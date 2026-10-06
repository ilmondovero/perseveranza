#!/usr/bin/env node
// The bridge between the mod (Claude Code's in-process hooks, no Node API, a non-atomic
// $.fs) and the Node shell: every read and write of the gate goes through here, invoked with
// $.process.run and one JSON request on stdin, one JSON answer on stdout.
//
//   request:  { op, cwd, event, facts }
//     op 'stop'            the Stop logic of stop.mjs, with the facts only the mod sees
//                          (facts.backgroundTasks, facts.usage, facts.loopMode)
//     op 'subagent-stop'   is the verdict a pf-reviewer/pf-verifier was asked for on disk?
//                          (event.agent_type, facts.askedTimes, facts.lens)
//     op 'activity-flush'  the heartbeat of the turn: facts.activity is written as
//                          .perseveranza/activity.json (the activity hook's format), facts.journal
//                          [{ event, agent }] journaled as activity lines
//     op 'usage-flush'     facts.usage.byAgent (tokens per agent since the last flush) dropped
//                          as a new file in .perseveranza/usage-inbox/: state.json is never
//                          touched, the next stop adds it (usage-inbox.mjs)
//   added for the mod (phase 2), all read-only on state.json:
//     op 'session-start'   the notice session-start.mjs prints (event: the SessionStart input;
//                          facts.loopMode 'tool' when the mod's tool is registered):
//                          { ok, context: text | null }
//     op 'route-model'     the model of a pf-* subagent about to spawn (event.subagentType),
//                          by MODEL_ROUTING and the run's complexity: { ok, model: alias | null,
//                          outcome }; a route is journaled (model-route)
//     op 'tool-check'      the reconciliation guard of activity-hook.mjs (event.tool, event.input):
//                          { ok, deny: reason | null }; a refusal is journaled
//     op 'journal'         facts.lines [{ type, ... }] of the mod's own types (MOD_JOURNAL_TYPES)
//                          appended to the journal of a live gate, for the owner's session
//                          only (event.session_id): { ok, journaled }
//   added for the tool (phase 3):
//     op 'alive'           the mod's sign of life for `arm` (facts.session ...), written here
//                          only when the mod's own $.fs.write failed: { ok, file } (mod-alive.mjs);
//                          with facts.prune: the old ones pruned instead (pruneAlive, never
//                          facts.session's): { ok, removed }
//   answer:   { ok: true, decision: { block } | { allowStop: true }, ... } | { ok: false, error }
//
// The state as the bridge finds it:
//   - absent (never armed, disarmed, archived): usage-flush 'no-loop', the others 'dormant';
//   - busy (a read refused at every retry: EBUSY, EPERM, a sync client, an antivirus) or
//     corrupt (state.json there but not a state, no pending copy: the next stop archives the
//     run as corrupt-state): the run may well be armed, so neither is "no loop":
//       - usage-flush queues the delta anyway, marked armUnknown (it counts for the run armed
//         before it was written, and only for its owner's session), and answers usage-queued
//         with armUnknown: true;
//       - subagent-stop sends a judge back (fail closed) with the reason, at most
//         MAX_VERDICT_ASKS times like a missing verdict, then lets it go (outcome 'busy' or
//         'corrupt'); the reason is in facts.lang if the mod gives it, else in the language
//         `arm` would pick (PERSEVERANZA_LANG > config > it): the state that says it is unreadable;
//       - activity-flush answers { ok: false, error: 'busy' | 'corrupt', retry: true }: nothing
//         written, the mod sends the heartbeat again;
//   - stop answers 'state-busy' (the next stop retries) or 'corrupt-state' (archived).
// The stop's and the flush's own delta, three answers:
//   - queued (no field): counted once by a later stop;
//   - dropped: usageDropped (stop) or { ok: false, error } (flush): the failure came before
//     any file under an inbox name could exist, so no stop ever saw it: the mod sends it again;
//   - unverified: usageUnverified (stop) or unverified: true (flush): a file under its inbox
//     name may exist (written in place, not confirmed): a stop may already have counted it,
//     so the mod must NOT resend; if it never landed whole, that delta is lost. Both the stop
//     and the flush journal it, when the journal can be written.
// A dropped delta is never counted; the price of that is the unverified one that may be lost.
// No answer at all (the mod's timeout killed the bridge, a crash): the mod does NOT resend.
// A stop queues its delta first, before anything slow, and a flush does nothing else: the
// delta is most likely queued already. Resending could count it twice; not resending loses
// it only if the call died before its file was written. No idempotent id: a name is
// remembered only until its file is removed, so a late resend would count twice anyway.
//
// It never throws and always exits 0: an error is an answer ({ ok: false }) and a journal line.
// The mod keeps no loop state: everything is reread from disk at every call.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gatePaths, ROOT } from './paths.mjs';
import { runStopFromFacts, readVerdictFiles } from './stop-core.mjs';
import { appendJournal } from './journal.mjs';
import { writeActivity } from './activity.mjs';
import { writeUsageDelta } from './usage-inbox.mjs';
import { loadPromptLayers } from './packs.mjs';
import { loadStateFile } from './state-file.mjs';
import { detectLang } from '../providers/config.mjs';
import { normalizeActivity } from '../core/staleness.mjs';
import { subagentVerdictCheck, loopAgentName, MAX_VERDICT_ASKS } from '../core/subagents.mjs';
import { renderPrompt } from '../core/prompts.mjs';
import { routeModel } from '../core/subagents.mjs';
import { sessionStartContext } from './session-start.mjs';
import { reconcileDecision } from './activity-hook.mjs';
import { takeModFault } from './mod-fault.mjs';
import { writeAlive, pruneAlive } from './mod-alive.mjs';

export const OPS = ['stop', 'subagent-stop', 'activity-flush', 'usage-flush', 'session-start', 'route-model', 'tool-check', 'journal', 'alive'];
// The journal lines the mod may write through op 'journal' (anything else is refused): its
// start (the Claude Code version it runs on) and a hook it had to skip (fail-open).
export const MOD_JOURNAL_TYPES = ['mod-start', 'mod-hook-skipped'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const short = (id) => String(id || '').slice(0, 8);

// The state on disk. -> { raw, state } | { busy: error, kind: 'busy' | 'corrupt' } (the loop
// may well be armed) | null (absent: dormant)
// (a pending copy of a save cut short is read, not promoted: the next stop promotes it)
function readStateFile(paths) {
  const loaded = loadStateFile(paths, { promote: false, journal: false });
  if (loaded.state) return { raw: loaded.raw, state: loaded.state, migrated: loaded.migrated };
  if (loaded.absent) return null;
  return { busy: loaded.error || 'unreadable', kind: loaded.transient ? 'busy' : 'corrupt' };
}

// A call from a session that does not own the loop touches nothing (the Stop hook's rule).
const foreignTo = (state, sessionId) => !!state.owner.sessionId && !!sessionId && sessionId !== state.owner.sessionId;

function opStop(req, paths, env, start) {
  const evt = { ...(isObj(req.event) ? req.event : {}), cwd: paths.cwd };
  // a fault the mod could not journal (mod-fault.json): into the run's journal, before this
  // stop may archive the run
  if (existsSync(paths.statePath)) takeModFault(paths.gateDir);
  const r = runStopFromFacts({ evt, env, start, facts: isObj(req.facts) ? req.facts : {} });
  // the driver of this stop, for whoever reads the journal: only beside a live state (a stop
  // that archived or disarmed the run leaves nothing behind)
  if (existsSync(paths.statePath)) appendJournal(paths.gateDir, { type: 'mod-stop', outcome: r.outcome, block: !!r.output, session: short(evt.session_id), active: evt.stop_hook_active === true });
  return { ok: true, decision: r.output ? { block: r.output.reason } : { allowStop: true }, outcome: r.outcome, ...(r.usageDropped ? { usageDropped: r.usageDropped } : {}), ...(r.usageUnverified ? { usageUnverified: r.usageUnverified } : {}) };
}

function opSubagentStop(req, paths, env) {
  const read = readStateFile(paths);
  if (!read) return { ok: true, decision: { allowStop: true }, outcome: 'dormant' };
  const e = isObj(req.event) ? req.event : {};
  const f = isObj(req.facts) ? req.facts : {};
  const session = typeof e.session_id === 'string' ? e.session_id : '';
  if (read.busy) return busyJudge(paths, env, e, f, session, read);
  const { state } = read;
  if (foreignTo(state, session)) return { ok: true, decision: { allowStop: true }, outcome: 'foreign-session' };
  const agentType = typeof e.agent_type === 'string' ? e.agent_type : typeof e.subagent_type === 'string' ? e.subagent_type : '';
  const { artifacts, artifactAt } = readVerdictFiles(paths.gateDir);
  const askedTimes = Math.max(0, Number(f.askedTimes) || 0);
  const check = subagentVerdictCheck(state, agentType, artifacts, { askedTimes, artifactAt, lens: typeof f.lens === 'string' ? f.lens : undefined });
  if (check.reason !== 'not-a-judge' && check.reason !== 'not-awaited') {
    appendJournal(paths.gateDir, { type: 'subagent-check', agent: agentType.slice(0, 80), ok: check.ok, reason: check.reason, file: check.file, askedTimes, session: short(session) });
  }
  if (check.ok) return { ok: true, decision: { allowStop: true }, check };
  const packs = loadPromptLayers({ gateDir: paths.gateDir, env, lang: state.options.lang, root: ROOT });
  // the reason in the loop's language, not the code
  const [code, ...rest] = check.reason.split(': ');
  const problem = renderPrompt(`hint-verdict-${code}`, { error: rest.join(': ') }, packs.layers) || check.reason;
  const block = renderPrompt('subagent-verdict', { file: check.file, problem, verdictRequestId: state.verdictRequestId }, packs.layers);
  return { ok: true, decision: { block }, check };
}

// state.json busy at a judge's stop: its verdict cannot be checked, so it is not let go blind
// (fail closed): sent back with the reason, as many times as a missing verdict would be.
function busyJudge(paths, env, e, f, session, read) {
  const agentType = typeof e.agent_type === 'string' ? e.agent_type : typeof e.subagent_type === 'string' ? e.subagent_type : '';
  const name = loopAgentName(agentType);
  if (name !== 'pf-reviewer' && name !== 'pf-verifier') return { ok: true, decision: { allowStop: true }, outcome: read.kind };
  const askedTimes = Math.max(0, Number(f.askedTimes) || 0);
  const letGo = askedTimes >= MAX_VERDICT_ASKS;
  const check = { ok: letGo, reason: letGo ? `asked-enough: ${read.kind}` : read.kind, file: null };
  appendJournal(paths.gateDir, { type: 'subagent-check', agent: agentType.slice(0, 80), ok: check.ok, reason: check.reason, file: null, askedTimes, session: short(session), error: String(read.busy).slice(0, 120) });
  if (letGo) return { ok: true, decision: { allowStop: true }, outcome: read.kind, check };
  // the loop's language is in the state that cannot be read: the mod's, else the one arm picks
  const lang = typeof f.lang === 'string' && /^[a-z]{2}$/i.test(f.lang) ? f.lang.toLowerCase() : detectLang(env);
  const packs = loadPromptLayers({ gateDir: paths.gateDir, env, lang, root: ROOT });
  return { ok: true, decision: { block: renderPrompt('subagent-busy', {}, packs.layers) }, outcome: read.kind, check };
}

function opActivityFlush(req, paths) {
  const read = readStateFile(paths);
  if (!read) return { ok: true, decision: { allowStop: true }, outcome: 'dormant' };
  // whose session the loop is cannot be told: nothing written, the mod sends it again
  if (read.busy) return { ok: false, error: read.kind, retry: true };
  const f = isObj(req.facts) ? req.facts : {};
  const e = isObj(req.event) ? req.event : {};
  const rec = normalizeActivity(f.activity);
  const session = rec && rec.session ? rec.session : typeof e.session_id === 'string' ? e.session_id : '';
  if (foreignTo(read.state, session)) return { ok: true, decision: { allowStop: true }, outcome: 'foreign-session' };
  let wrote = false;
  if (rec) wrote = writeActivity(paths.gateDir, rec);
  const lines = Array.isArray(f.journal) ? f.journal.filter(isObj).slice(0, 50) : [];
  for (const j of lines) {
    appendJournal(paths.gateDir, { type: 'activity', event: String(j.event || 'tool').slice(0, 40), agent: String(j.agent || '').slice(0, 120), session: short(session), ...(Number.isFinite(Number(j.pending)) ? { pending: Number(j.pending) } : {}), via: 'mod' });
  }
  return { ok: true, decision: { allowStop: true }, outcome: rec ? 'activity' : 'no-activity', atomic: wrote, journaled: lines.length };
}

function opSessionStart(req, paths, env) {
  const e = isObj(req.event) ? req.event : {};
  const f = isObj(req.facts) ? req.facts : {};
  const context = sessionStartContext({ ...e, cwd: paths.cwd }, env, { loopMode: f.loopMode });
  return { ok: true, context: typeof context === 'string' && context ? context : null };
}

function opRouteModel(req, paths) {
  const e = isObj(req.event) ? req.event : {};
  const agent = typeof e.subagentType === 'string' ? e.subagentType : '';
  if (!loopAgentName(agent)) return { ok: true, model: null, outcome: 'not-a-loop-agent' };
  const read = readStateFile(paths);
  if (!read) return { ok: true, model: null, outcome: 'dormant' };
  // a state that cannot be read has no complexity to route by: the prompt's model stands
  if (read.busy) return { ok: true, model: null, outcome: read.kind };
  const session = typeof e.session_id === 'string' ? e.session_id : '';
  if (foreignTo(read.state, session)) return { ok: true, model: null, outcome: 'foreign-session' };
  const model = routeModel(read.state, agent);
  if (!model) return { ok: true, model: null, outcome: 'no-route' };
  appendJournal(paths.gateDir, { type: 'model-route', agent: agent.slice(0, 80), complexity: read.state.complexity, model, ...(typeof e.model === 'string' && e.model ? { asked: e.model.slice(0, 40) } : {}), session: short(session) });
  return { ok: true, model, outcome: 'routed' };
}

// The reconciliation guard (activity-hook.mjs, PreToolUse): while the loop is being reconciled
// after a restore, a tool that would mutate is refused. Only for the owner's session.
function opToolCheck(req, paths) {
  const e = isObj(req.event) ? req.event : {};
  const read = readStateFile(paths);
  if (!read || read.busy) return { ok: true, deny: null, outcome: read ? read.kind : 'dormant' };
  const session = typeof e.session_id === 'string' ? e.session_id : '';
  const owner = read.state.owner.sessionId;
  if (owner && owner !== session) return { ok: true, deny: null, outcome: 'foreign-session' };
  if (!read.state.signals.interrupted) return { ok: true, deny: null, outcome: 'free' };
  const tool = typeof e.tool === 'string' ? e.tool : '';
  const why = reconcileDecision(tool, isObj(e.input) ? e.input : {});
  if (why) appendJournal(paths.gateDir, { type: 'activity', event: 'refused', tool: tool.slice(0, 40), session: short(session), why: 'reconciling', via: 'mod' });
  return { ok: true, deny: why, outcome: why ? 'refused' : 'allowed' };
}

// Plain values only, each string cut short: a journal line from the mod is a fact, not a payload.
function journalLine(raw) {
  if (!isObj(raw) || !MOD_JOURNAL_TYPES.includes(raw.type)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw).slice(0, 12)) {
    if (k === 'ts' || !/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 300);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean' || v === null) out[k] = v;
  }
  return out;
}

// Only the owner's session writes in its run's journal (the other ops' rule): another session's
// mod-start or skipped hook is not this run's fact. Every line carries the session it came from
// (`status` reads a mod-start only from the owner's); a state that cannot be read cannot say
// whose the run is, so the line goes with ownerUnknown: true and `status` does not use it.
function opJournal(req, paths) {
  // the gate of a live run only: never a folder made, never a line for a run that is gone
  const read = readStateFile(paths);
  if (!read) return { ok: true, journaled: 0, outcome: 'dormant' };
  const e = isObj(req.event) ? req.event : {};
  const session = typeof e.session_id === 'string' ? e.session_id : '';
  if (!read.busy && foreignTo(read.state, session)) return { ok: true, journaled: 0, outcome: 'foreign-session' };
  const f = isObj(req.facts) ? req.facts : {};
  const lines = (Array.isArray(f.lines) ? f.lines : []).slice(0, 20).map(journalLine).filter(Boolean);
  for (const l of lines) appendJournal(paths.gateDir, { ...l, session: short(session), ...(read.busy ? { ownerUnknown: true } : {}), via: 'mod' });
  return { ok: true, journaled: lines.length };
}

// The mod's sign of life for `arm` (mod-alive.mjs), when its own $.fs.write was refused:
// facts { session, claudeCode, plugin }. Touches nothing of the loop.
function opAlive(req, paths, env) {
  const f = isObj(req.facts) ? req.facts : {};
  // the mod found too many signs of life, or an old one: prune them (never this session's)
  if (f.prune === true) return { ok: true, removed: pruneAlive(env, { keep: typeof f.session === 'string' ? f.session : null }) };
  const plain = (v) => (typeof v === 'string' ? v.slice(0, 80) : undefined);
  const w = writeAlive(typeof f.session === 'string' ? f.session : '', { at: Date.now(), claudeCode: plain(f.claudeCode), plugin: plain(f.plugin), cwd: paths.cwd.slice(0, 300), via: 'bridge' }, env);
  return w.ok ? { ok: true, file: w.path } : { ok: false, error: w.error };
}

function opUsageFlush(req, paths) {
  // no loop, no inbox: the tokens of a run already archived are nobody's (never a folder made).
  // A state.json busy or corrupt is not "no loop": the delta is queued as armUnknown.
  const read = readStateFile(paths);
  if (!read) return { ok: false, error: 'no-loop' };
  const f = isObj(req.facts) ? req.facts : {};
  const e = isObj(req.event) ? req.event : {};
  const session = typeof e.session_id === 'string' ? e.session_id : '';
  if (!read.busy && foreignTo(read.state, session)) return { ok: true, decision: { allowStop: true }, outcome: 'foreign-session' };
  const byAgent = isObj(f.usage) && isObj(f.usage.byAgent) ? f.usage.byAgent : null;
  if (!byAgent) return { ok: true, decision: { allowStop: true }, outcome: 'no-usage' };
  // a file of its own, never state.json: overlapping flushes and stops lose nothing; the arm
  // it belongs to goes with it, so a later run never counts it (armUnknown: the time it was
  // written decides, and the session is checked when it is counted)
  const w = writeUsageDelta(paths.gateDir, read.busy ? { session, armUnknown: true, byAgent } : { session, arm: read.state.armedAt, byAgent });
  if (w.error) return { ok: false, error: w.error };
  if (w.unverified) appendJournal(paths.gateDir, { type: 'note', text: `usage: flushed delta ${w.name} was written in place and not confirmed (${w.why}): counted if it landed whole, else lost; never sent again` });
  return { ok: true, decision: { allowStop: true }, outcome: 'usage-queued', file: w.name, ...(read.busy ? { armUnknown: true } : {}), ...(w.unverified ? { unverified: true } : {}) };
}

// One request -> one answer. Never throws.
export function handle(req, { env = process.env, start = Date.now() } = {}) {
  let paths = null;
  try {
    if (!isObj(req)) return { ok: false, error: 'request is not a JSON object' };
    const ev = isObj(req.event) ? req.event : {};
    const cwd = typeof req.cwd === 'string' && req.cwd ? req.cwd : typeof ev.cwd === 'string' && ev.cwd ? ev.cwd : '';
    if (!cwd) return { ok: false, error: 'cwd missing' };
    paths = gatePaths(cwd);
    switch (req.op) {
      case 'stop': return opStop(req, paths, env, start);
      case 'subagent-stop': return opSubagentStop(req, paths, env);
      case 'activity-flush': return opActivityFlush(req, paths);
      case 'usage-flush': return opUsageFlush(req, paths);
      case 'session-start': return opSessionStart(req, paths, env);
      case 'route-model': return opRouteModel(req, paths);
      case 'tool-check': return opToolCheck(req, paths);
      case 'journal': return opJournal(req, paths);
      case 'alive': return opAlive(req, paths, env);
      default: return { ok: false, error: `unknown op ${JSON.stringify(req.op)} (expected one of ${OPS.join(', ')})` };
    }
  } catch (e) {
    const error = String((e && e.message) || e).slice(0, 300);
    if (paths && existsSync(paths.gateDir)) appendJournal(paths.gateDir, { type: 'note', text: `mod bridge ${String(req && req.op).slice(0, 20)} failed: ${error}` });
    return { ok: false, error };
  }
}

function isMainModule() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] || '.')).href; }
  catch { return false; }
}

if (isMainModule()) {
  const start = Date.now();
  let res;
  try {
    let raw = '';
    try { raw = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
    let req = null;
    try { req = raw.trim() ? JSON.parse(raw) : null; } catch (e) { res = { ok: false, error: `invalid JSON on stdin: ${e.message}` }; }
    if (!res) res = handle(req, { env: process.env, start });
  } catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
  process.stdout.write(JSON.stringify(res), () => process.exit(0));
}
