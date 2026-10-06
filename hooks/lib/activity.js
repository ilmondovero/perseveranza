// The heartbeat of a turn (what src/shell/activity-hook.mjs did with a node process per tool
// call): the last tool activity and the delegations not back yet, written by the bridge as
// .perseveranza/activity.json ('activity-flush'), with a journal line for every delegation and
// every subagent's return. Debounced with $.clock.after: a delegation or a return within
// ACTIVITY_URGENT_MS, a plain tool call at most every ACTIVITY_HEARTBEAT_MS.
//
// The bridge's answers: written -> done; { ok: false, retry: true } (state.json busy or
// corrupt: whose loop it is cannot be told) -> sent again, MAX_ACTIVITY_RETRIES times; dormant
// or another session's loop -> dropped; no answer -> the lines are not sent again (they would
// be journaled twice), the record goes with the next flush.
import { isObj, ACTIVITY_URGENT_MS, ACTIVITY_HEARTBEAT_MS, MAX_ACTIVITY_RETRIES, FLUSH_TIMEOUT_MS } from './core.js';
import { call, enqueue, hasGate } from './gate.js';

// a description can be a whole prompt
const name = (v) => String(v || 'subagent').slice(0, 120);

function record(mod, now, session, event, tool, agent) {
  mod.activity = { at: now, session: String(session || ''), event, tool: String(tool || ''), agent, pending: mod.pending.slice(), transcript: mod.transcript || '' };
}

// A tool call (tool.call's input) -> 'urgent' for a delegation, else 'heartbeat'.
export function noteTool(mod, e, now, session) {
  const tool = isObj(e) && typeof e.tool === 'string' ? e.tool : '';
  if (tool === 'Agent' || tool === 'Task') {
    const agent = name(e.subagent_type || e.name || e.description);
    // the call's id: agent.spawn maps the subagent's agentId to it, its SubagentStop closes it
    mod.pending.push({ at: now, agent, ...(typeof e.tool_use_id === 'string' && e.tool_use_id ? { id: e.tool_use_id } : {}) });
    record(mod, now, session, 'delegate', tool, agent);
    mod.lines.push({ event: 'delegate', agent, pending: mod.pending.length });
    return 'urgent';
  }
  record(mod, now, session, 'tool', tool, '');
  return 'heartbeat';
}

// A subagent that is done (classic.SubagentStop's input, not sent back): its own delegation
// closes, found by its agent_id -> the Agent call's tool_use_id (agent.spawn learned it); when
// that is unknown (no spawn seen), the oldest of its name, else the oldest. Two judges of the
// same type running side by side: the one still running stays pending. -> 'urgent'
export function noteSubagentStop(mod, e, now) {
  const named = isObj(e) && (e.agent_type || e.subagent_type) ? name(e.agent_type || e.subagent_type) : '';
  const agentId = isObj(e) && typeof e.agent_id === 'string' ? e.agent_id : '';
  const callId = agentId ? mod.agentTool[agentId] : '';
  let i = callId ? mod.pending.findIndex((d) => d.id === callId) : -1;
  if (i < 0 && named) i = mod.pending.findIndex((d) => d.agent === named);
  if (agentId) delete mod.agentTool[agentId];
  const done = i >= 0 ? mod.pending.splice(i, 1)[0] : mod.pending.shift() || null;
  const agent = named || (done ? done.agent : 'subagent');
  record(mod, now, isObj(e) ? e.session_id : '', 'subagent-stop', '', agent);
  mod.lines.push({ event: 'subagent-stop', agent, pending: mod.pending.length });
  return 'urgent';
}

// What the bridge's answer does to what was sent (rec, lines). -> 'written' | 'retry' |
// 'dropped' | 'no-answer'
export function settleActivity(mod, rec, lines, r) {
  if (!r || !r.answer) { mod.activityRetries = 0; return 'no-answer'; }
  const a = r.answer;
  if (a.ok === false && a.retry === true && mod.activityRetries < MAX_ACTIVITY_RETRIES) {
    mod.activityRetries += 1;
    // sent again: the lines first, the record only if nothing newer came meanwhile
    mod.lines = [...lines, ...mod.lines];
    if (!mod.activity) mod.activity = rec;
    return 'retry';
  }
  mod.activityRetries = 0;
  return a.ok === true && (a.outcome === 'activity' || a.outcome === 'no-activity') ? 'written' : 'dropped';
}

export async function flushActivity(io, mod) {
  const rec = mod.activity;
  const lines = mod.lines;
  mod.activity = null;
  mod.lines = [];
  if (!rec && !lines.length) return 'empty';
  let cwd = '';
  try { cwd = await io.cwd(); } catch { /* below */ }
  if (!(await hasGate(io, cwd, true))) return 'no-gate';
  try { mod.lastActivityFlush = await io.now(); } catch { /* keep the last */ }
  const r = await enqueue(mod, () => call(io, mod, 'activity-flush', { cwd, event: { session_id: rec ? rec.session : '' }, facts: { activity: rec, journal: lines }, timeoutMs: FLUSH_TIMEOUT_MS }));
  const out = settleActivity(mod, rec, lines, r);
  if (out === 'retry') scheduleActivity(io, mod, 'heartbeat', mod.lastActivityFlush);
  return out;
}

// One timer at a time; an urgent event brings a heartbeat's timer forward.
export function scheduleActivity(io, mod, kind, now) {
  const t = Number(now) || 0;
  const delay = kind === 'urgent' ? ACTIVITY_URGENT_MS : Math.max(ACTIVITY_URGENT_MS, mod.lastActivityFlush + ACTIVITY_HEARTBEAT_MS - t);
  const due = t + delay;
  if (mod.activityTimer) {
    if (due >= mod.activityDue) return;
    try { mod.activityTimer.cancel(); } catch { /* gone */ }
  }
  mod.activityDue = due;
  mod.activityTimer = io.after(delay, () => {
    mod.activityTimer = null;
    mod.activityDue = 0;
    return flushActivity(io, mod).catch(() => 'error');
  });
}
