// The Stop logic as a function: read the state, gather the facts, ask the core what to do,
// execute the effects. Called by the Stop hook (stop.mjs, the settings hook) and by the mod
// bridge (mod-bridge.mjs), which adds the facts only the mod sees (facts below). DORMANT
// until .perseveranza/state.json exists in the cwd.
//
// runStopFromFacts({ evt, env, start, facts }) -> { output, outcome }
//   evt:   the Stop payload as Claude Code sends it (session_id, cwd, transcript_path...)
//   facts: { backgroundTasks: [{ id, type, status, agent_type, description }],
//            usage: { byAgent: { <agentId|'main'>: tokens } }  (measured since the last flush),
//            and whatever the mod's flushes left in .perseveranza/usage-inbox/ (usage-inbox.mjs),
//            loopMode: 'shell'|'tool': the driver has the mod's tool (the instructions name
//            it only when the run was armed for it too: effectiveLoopMode) }
//   output: null (let Claude stop) | { decision: 'block', reason }
//   outcome: the machine's outcome, or what stopped it before ('dormant', 'kill', 'corrupt-state')
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gatePaths, ROOT, loopCommand } from './paths.mjs';
import { loadState, mergeVerbFields, onlyVerbChanges, LENSES } from '../core/state.mjs';
import { step, WAIT_ROLES, loopAgentName } from '../core/machine.mjs';
import { effectiveLoopMode } from '../core/prompts.mjs';
import { DEFAULT_STALE_MS } from '../core/staleness.mjs';
import { executeEffects } from './effects.mjs';
import { appendJournal } from './journal.mjs';
import { notify } from './notify.mjs';
import { archiveRun, archiveFailureNote, RETAINED_STATE, DISARMED_MARK } from './archive.mjs';
import { loadStateFile, PENDING, READ_TRIES, RENAME_WAIT_MS, sleepMs } from './state-file.mjs';
import { loadPromptLayers } from './packs.mjs';
import { treeFingerprints } from './git.mjs';
import { readSessionUsage } from './transcript.mjs';
import { readUsageInbox, applyInbox, removeInboxFiles, settleSeen, boundSeen, foreignReason, defaultUnlink, writeUsageDelta, gone, INBOX_DIR } from './usage-inbox.mjs';
import { readLife } from './life.mjs';
import { readActivity } from './activity.mjs';
import { spawnWatchdog, dropRestoreSentinel } from './watchdog.mjs';
import { findClaudeProcess } from './restore.mjs';
import { parseTimeoutMs, boolEnv } from './util.mjs';
import { currentVersion, updateAvailable, maybeSpawnRefresh } from '../update.mjs';

export const TITLE = 'Claude Code - perseveranza';

// The verdict files in the gate, with their clocks, in the shape of ctx.artifacts.
// which: { review, verify } -> read those groups only
export function readVerdictFiles(gateDir, which = { review: true, verify: true }) {
  const readArtifact = (name) => {
    const p = join(gateDir, name);
    if (!existsSync(p)) return null;
    try { return readFileSync(p, 'utf8'); } catch { return ''; }
  };
  const artifactMtime = (name) => { try { return statSync(join(gateDir, name)).mtimeMs; } catch { return 0; } };
  const artifacts = {};
  const artifactAt = {};
  if (which.review) { artifacts.review = readArtifact('review.json'); artifactAt.review = artifactMtime('review.json'); }
  if (which.verify) {
    artifacts.verify = readArtifact('verify.json'); artifactAt.verify = artifactMtime('verify.json');
    // one verdict per lens (verify-<lens>.json): read with the same tolerance, the machine
    // decides which ones this round asked for
    artifacts.verifyLenses = {};
    artifactAt.verifyLenses = {};
    for (const lens of LENSES) {
      artifacts.verifyLenses[lens] = readArtifact(`verify-${lens}.json`);
      artifactAt.verifyLenses[lens] = artifactMtime(`verify-${lens}.json`);
    }
  }
  return { artifacts, artifactAt };
}

// Does the state on disk name every file this stop counted (usageInboxSeen)? A name joins
// that list only in the save that adds its tokens (one write, one file). The totals are NOT
// compared: an overlapping stop may have legitimately added more since, and equal totals with
// other names prove nothing.
//
// How an inbox file is consumed, and why no token is counted twice nor lost (but in the
// instant described at the end):
//   1. the stop that counts a file adds its tokens and its name in one save, and does NOT
//      remove the file;
//   2. a LATER stop removes it (settleSeen), and only because the state it loaded from disk
//      names it: the tokens are in a state that stood on disk as the base of a new stop;
//   3. the name leaves the list once its file is gone.
// A listed file is counted only if it is still on disk once the state is read: a stop that
// listed it before another stop removed it (step 2) and dropped its name (step 3) finds it
// gone, so it is never counted twice.
// A save overwritten by another writer (two stops overlapping, a verb in the instant between
// a check and a rename) loses the name together with the tokens, and the file, still on disk,
// is counted by the next stop: counted once, late, never lost. What is left: a stop that
// removes a file (step 2) whose base state is then overwritten by a writer (a stop, a verb,
// the watchdog) that read the state before that base was written, in the instant between its
// last check and its rename: three writers overlapping, with one of them paused between two
// system calls (an instant, or seconds on a starved CPU: state-file.mjs). Those tokens are
// LOST (an undercount; never a double count): the sequence is
// pinned in test/e2e/state-overlap.test.mjs. Claude Code does not overlap
// the stops of a session; the mod's bridge can, and the restart below (another stop's save
// seen before anything is written) and the abandoned save (seen at the save) narrow it to that
// instant. Closing it needs a lock, and the repo has none.
export function savedCounts(statePath, names, read = (p) => readFileSync(p, 'utf8')) {
  let disk;
  try { disk = JSON.parse(read(statePath)); } catch { return false; }
  const seen = new Set(disk && Array.isArray(disk.usageInboxSeen) ? disk.usageInboxSeen : []);
  return names.every((n) => seen.has(n));
}

// A pf-* subagent still running at a stop (subagent-running, seen by the mod): the machine
// allows MAX_SUBAGENT_WAITS such stops per request, and a stop answered at once costs the
// model one short turn, so three of them went by in seconds while a reviewer worked for a
// minute (seen in a real run: the review then counted as missing twice, a failed round).
// The stop waits in real time instead: up to PERSEVERANZA_SUBAGENT_WAIT_MS (30 s by default),
// never past the hook's deadline minus WAIT_MARGIN_MS (the rerun recomputes the tree), polled
// every SUBAGENT_POLL_MS. It ends early when the phase's verdict file is written or when the
// mod records the subagent's return (SubagentStop, in the activity record); either way the stop
// then runs again from the disk (a returned subagent no longer counted as running), so an early
// end costs no wait and no quiet stop. Only the mod's stops reach it: a settings hook has no
// backgroundTasks, so the machine never answers subagent-running there.
export const DEFAULT_SUBAGENT_WAIT_MS = 30000;
export const SUBAGENT_POLL_MS = 500;
export const WAIT_MARGIN_MS = 30000;
// PERSEVERANZA_SUBAGENT_WAIT_MS: a whole number of ms, 0 turns the wait off; anything else: the default
export function subagentWaitMs(env = process.env) {
  const raw = String(env.PERSEVERANZA_SUBAGENT_WAIT_MS ?? '').trim();
  return /^\d{1,7}$/.test(raw) ? Number(raw) : DEFAULT_SUBAGENT_WAIT_MS;
}

// the verdict files of a phase, with their clocks (0: absent)
function verdictClocks(gateDir, phase) {
  const at = (name) => { try { return statSync(join(gateDir, name)).mtimeMs; } catch { return 0; } };
  if (phase === 'review') return { 'review.json': at('review.json') };
  if (phase === 'final-verify') return Object.fromEntries(['verify.json', ...LENSES.map((l) => `verify-${l}.json`)].map((n) => [n, at(n)]));
  return {};
}

// -> { waitedMs, landed: <file> | null, returned: true when the subagent's return was recorded,
//      activity: that record (its `pending` says which delegations are still out) }
export function waitForSubagent(gateDir, phase, budgetMs, { sleep = sleepMs, now = Date.now } = {}) {
  const start = now();
  const before = verdictClocks(gateDir, phase);
  const role = WAIT_ROLES[phase];
  const returned = () => {
    const a = readActivity(gateDir);
    return a && a.event === 'subagent-stop' && a.at >= start && (!role || !a.agent || a.agent.endsWith(role)) ? a : null;
  };
  while (now() - start < budgetMs) {
    sleep(Math.min(SUBAGENT_POLL_MS, Math.max(1, budgetMs - (now() - start))));
    const after = verdictClocks(gateDir, phase);
    const landed = Object.keys(after).find((n) => after[n] > 0 && after[n] !== before[n]) || null;
    if (landed) return { waitedMs: now() - start, landed, returned: false, activity: null };
    const a = returned();
    if (a) return { waitedMs: now() - start, landed: null, returned: true, activity: a };
  }
  return { waitedMs: now() - start, landed: null, returned: false, activity: null };
}

// The background tasks of the Stop input, after the wait saw the phase's subagent come back:
// the input was taken before the wait, so it still lists that subagent as running, and a rerun
// on it would answer "a subagent is still running" again. The returned ones are marked
// completed: as many of the role's running tasks as the record of the return does not list as
// still pending (its `pending`, the delegations not back yet), and at least one (the one whose
// return was recorded). Pure: the input is not changed. -> the tasks for the rerun
export function settleReturned(tasks, role, activity) {
  if (!Array.isArray(tasks)) return tasks;
  const ofRole = (t) => !!t && typeof t === 'object' && !Array.isArray(t) && typeof t.status === 'string' && t.status.toLowerCase() === 'running' && loopAgentName(t.agent_type ?? t.agentType) === role;
  const running = tasks.filter(ofRole).length;
  const pending = activity && Array.isArray(activity.pending) ? activity.pending.filter((p) => p && loopAgentName(p.agent) === role).length : 0;
  let settle = Math.max(1, running - pending);
  return tasks.map((t) => {
    if (settle > 0 && ofRole(t)) { settle -= 1; return { ...t, status: 'completed' }; }
    return t;
  });
}

// io: { unlink, stat, writeState, fs, afterSave } for the tests that simulate a refused
// removal or save (a sync client, an antivirus, a read-only state.json, a full disk) or
// another writer between the save and its check (afterSave)
// a stop that finds another stop's save on disk before writing anything starts over from it
export const MAX_RESTARTS = 2;
// the outcome signals of the verbs (report, claim-done): never merged into a paused state
export const OUTCOME_FIELDS = ['lastReport', 'claimedDone'];

// -> { output, outcome, usageDropped?, usageUnverified? }: usageDropped when the stop's own
// delta (facts.usage) is surely not in the inbox (the mod sends it again); usageUnverified when
// it was not confirmed but could not be removed (counted if whole: the mod must NOT resend)
export function runStopFromFacts(args = {}) {
  const note = {};
  const r = runStopOnce(args, 0, note);
  return { ...r, ...(note.usageDropped ? { usageDropped: note.usageDropped } : {}), ...(note.usageUnverified ? { usageUnverified: note.usageUnverified } : {}) };
}

function runStopOnce(args, attempt, note = {}) {
  const { evt = null, env = process.env, start = Date.now(), facts = {}, io = {} } = args;
  const unlink = typeof io.unlink === 'function' ? io.unlink : defaultUnlink;
  // hooks.json declares 120 s; keep a margin so we always answer before Claude Code kills us
  const DEADLINE = start + parseTimeoutMs(env.PERSEVERANZA_HOOK_TIMEOUT_MS, 120000) - 8000;
  const f = facts && typeof facts === 'object' ? facts : {};
  const cwd = evt && typeof evt.cwd === 'string' && evt.cwd ? evt.cwd : process.cwd();
  const paths = gatePaths(cwd);

  // DORMANT: no gate, nothing to do (a pending copy left by a save cut short is a gate, unless
  // the run was retained after an archive failure: then the loop is disarmed)
  const pendingOnly = !existsSync(paths.statePath) && existsSync(`${paths.statePath}${PENDING}`) && !existsSync(join(paths.gateDir, RETAINED_STATE)) && !existsSync(join(paths.gateDir, DISARMED_MARK));
  if (!existsSync(paths.statePath) && !pendingOnly) return { output: null, outcome: 'dormant' };

  // KILL SWITCH: before any other check, needs no state, works from any session
  const killEnv = boolEnv(env.PERSEVERANZA_KILL);
  const killFile = existsSync(paths.stopFile);
  if (killEnv || killFile) {
    const via = killFile ? 'STOP file' : 'PERSEVERANZA_KILL';
    appendJournal(paths.gateDir, { type: 'kill', via });
    const state = loadStateFile(paths, { fs: io.fs }).state;
    const archived = archiveRun(paths.gateDir, { projectName: paths.projectName, state, outcome: 'killed', env });
    notify(TITLE, archived.ok ? `Kill switch (${via}): loop disarmed - ${paths.projectName}` : archiveFailureNote(archived), { env });
    return { output: null, outcome: 'kill' };
  }

  // The mod's delta of this stop (facts.usage, tokens since its last flush) goes through the
  // inbox like a flush, written FIRST, before the inbox is listed and whatever the state read
  // gives: counted exactly once, in the save that names it, and still on disk on every early
  // exit (state.json busy, a failed or abandoned save). Written once per stop, not per restart.
  // The state is read here only for the arm and the owner; when it cannot be read the file
  // says so (armUnknown) and counts if it was written after the current arm.
  const sessionId = evt && typeof evt.session_id === 'string' ? evt.session_id : '';
  if (attempt === 0 && !args.waited && f.usage && typeof f.usage === 'object' && !Array.isArray(f.usage) && f.usage.byAgent && typeof f.usage.byAgent === 'object') {
    const pre = loadStateFile(paths, { fs: io.fs, promote: false, journal: false }).state;
    const owner = pre && pre.owner.sessionId;
    if (!(owner && sessionId && sessionId !== owner)) {
      const w = writeUsageDelta(paths.gateDir, pre ? { session: sessionId, arm: pre.armedAt, byAgent: f.usage.byAgent } : { session: sessionId, armUnknown: true, byAgent: f.usage.byAgent });
      if (w.error) {
        note.usageDropped = w.error;
        appendJournal(paths.gateDir, { type: 'note', text: `usage: this stop's delta could not be queued (${w.error}); the answer says usageDropped` });
      } else if (w.unverified) {
        note.usageUnverified = w.name;
        appendJournal(paths.gateDir, { type: 'note', text: `usage: this stop's delta ${w.name} was written in place and not confirmed (${w.why}): counted if it landed whole, else lost; never sent again` });
      }
    }
  }

  // the mod's usage inbox, listed BEFORE the state is read: a file listed here and already
  // counted by an overlapping stop is named in the state that stop saved. A file is counted
  // only if it is still on disk once the state is read (below): a name leaves the list only
  // once its file is gone, so a state that counted a file but no longer names it was saved
  // after that file was removed, and a stop that loaded it finds the file gone.
  // its findings (a file set aside, one never readable) are journaled here, whoever this stop
  // is for and however it ends
  const inboxRead = readUsageInbox(paths.gateDir, [], Date.now(), { note: (text) => appendJournal(paths.gateDir, { type: 'note', text }) });

  // STATE: v1 is migrated on the fly; absent, empty or corrupt with a valid pending copy beside
  // it, the copy is promoted (state-recovered); garbage without one disarms cleanly (archived
  // for forensics)
  const loaded = loadStateFile(paths, { fs: io.fs });
  if (!loaded.state && loaded.absent) return { output: null, outcome: 'dormant' };
  // a read refused for a moment (a sync client, an antivirus) is not a corrupt state: nothing
  // promoted, nothing archived, the next stop reads it again
  if (!loaded.state && loaded.transient) {
    appendJournal(paths.gateDir, { type: 'note', text: `state.json could not be read (${loaded.error}): this stop lets go, the next one retries` });
    return { output: null, outcome: 'state-busy' };
  }
  if (!loaded.state) {
    appendJournal(paths.gateDir, { type: 'note', text: `state.json unreadable (${loaded.error}): disarming` });
    const archived = archiveRun(paths.gateDir, { projectName: paths.projectName, state: null, outcome: 'corrupt-state', env });
    notify(TITLE, archived.ok ? `state.json corrupt: loop disarmed - ${paths.projectName}` : archiveFailureNote(archived), { env });
    return { output: null, outcome: 'corrupt-state' };
  }
  const holder = { state: loaded.state };
  // the state as read: what a verb changed on disk since then is merged into the final save
  const startState = JSON.parse(JSON.stringify(loaded.state));
  const startText = loaded.text;
  if (loaded.migrated) appendJournal(paths.gateDir, { type: 'migrate', from: 1, to: 2 });
  const s = holder.state;

  // FACTS for the core
  const planExists = existsSync(paths.planPath);
  let planText = '';
  if (planExists) { try { planText = readFileSync(paths.planPath, 'utf8'); } catch { /* unreadable */ } }
  const { artifacts, artifactAt } = readVerdictFiles(paths.gateDir, { review: s.phase === 'review', verify: s.phase === 'final-verify' });
  if (s.signals.interrupted) {
    const p = join(paths.gateDir, 'reconcile.json');
    artifacts.reconcile = existsSync(p) ? (() => { try { return readFileSync(p, 'utf8'); } catch { return ''; } })() : null;
  }
  const packs = loadPromptLayers({ gateDir: paths.gateDir, env, lang: s.options.lang, root: ROOT });
  for (const err of packs.errors) appendJournal(paths.gateDir, { type: 'prompt-pack', source: err.source, error: err.error });
  // The tree at every stop, within the hook's remaining time: it revalidates a pending claim,
  // tells the phases whether the recorded green still holds, and shows a stop that changed
  // nothing. null = could not be computed (not a repo, deadline): never read as "changed".
  const fps = treeFingerprints(cwd, { deadline: DEADLINE });
  // not for a session that does not own the loop: the machine touches nothing for it, and its
  // transcripts would only evict the owner's cache
  const foreign = s.owner.sessionId && evt && typeof evt.session_id === 'string' && evt.session_id && evt.session_id !== s.owner.sessionId;
  // the mod measures every request by agent: its reading replaces the transcripts'. Its
  // flushes wait in the inbox: added here, removed by a later stop whose loaded state names them.
  const modUsage = f.usage && typeof f.usage === 'object' && !Array.isArray(f.usage);
  const seenBefore = new Set(s.usageInboxSeen);
  const stillThere = (e) => !gone(join(paths.gateDir, INBOX_DIR, e.name), io.stat);
  const inbox = foreign ? null : {
    invalid: inboxRead.invalid,
    entries: inboxRead.entries.filter((e) => !seenBefore.has(e.name) && stillThere(e)),
    seen: inboxRead.entries.filter((e) => seenBefore.has(e.name)).map((e) => e.name),
  };
  // a file of another session or of another arm (a late flush of an earlier run) is dropped
  const own = inbox ? inbox.entries.filter((e) => !foreignReason(e, s)) : [];
  const strays = inbox ? inbox.entries.filter((e) => foreignReason(e, s)) : [];
  if (strays.length) appendJournal(paths.gateDir, { type: 'note', text: `usage inbox: ${strays.length} file(s) not of this run dropped (${[...new Set(strays.map((e) => foreignReason(e, s)))].join(', ')})` });
  // every delta is a bounded count: a value past the cap is clamped and said
  const clamped = [];
  const usage = foreign ? null
    : modUsage || own.length ? applyInbox(s.usage, own, clamped)
      : evt && typeof evt.transcript_path === 'string'
        ? readSessionUsage(evt.transcript_path, s.armedAt, { cachePath: join(paths.gateDir, 'usage-cache.json'), deadline: DEADLINE })
        : null;
  if (clamped.length) appendJournal(paths.gateDir, { type: 'usage-clamped', count: clamped.length, fields: clamped.slice(0, 10) });
  maybeSpawnRefresh(env);
  const ctx = {
    LOOP: loopCommand(ROOT),
    loopMode: effectiveLoopMode(s.options.loopMode, f.loopMode),
    projectName: paths.projectName,
    planText,
    planExists,
    artifacts,
    artifactAt,
    overrides: packs.layers,
    fingerprint: fps.full,
    codeFingerprint: fps.code,
    usage,
    version: currentVersion(ROOT),
    updateAvailable: updateAvailable(ROOT, env),
    staleMs: parseTimeoutMs(env.PERSEVERANZA_STALE_MS, DEFAULT_STALE_MS),
    activityAt: (() => { const life = readLife(paths.gateDir, s); const a = life.activity; return Math.max(a && (!a.session || !s.owner.sessionId || a.session === s.owner.sessionId) ? a.at : 0, life.transcriptAt); })(),
    ...(Array.isArray(f.backgroundTasks) ? { backgroundTasks: f.backgroundTasks } : {}),
  };
  const event = {
    sessionId: evt && typeof evt.session_id === 'string' ? evt.session_id : '',
    now: Date.now(),
    payloadKeys: evt && typeof evt === 'object' ? Object.keys(evt) : [],
    stopHookActive: !!(evt && evt.stop_hook_active === true),
    transcriptPath: evt && typeof evt.transcript_path === 'string' ? evt.transcript_path : '',
    // the Claude Code process above this hook: only when the watchdog may restore it (a
    // process-tree walk costs a shell call at every Stop)
    claude: boolEnv(env.PERSEVERANZA_RESTORE) ? findClaudeProcess() : null,
  };

  const r = step(s, event, ctx);
  // a subagent still running: wait for it in real time (see waitForSubagent), once per stop;
  // nothing was written yet, so the stop runs again from the disk when the wait ends early:
  // a verdict that lands is read there, and a subagent that came back (the only early end in
  // implement, which has no verdict file) is no longer listed as running (settleReturned), so
  // the rerun routes on its work instead of spending a wait on it
  if (r.outcome === 'subagent-running' && !args.waited) {
    const budget = Math.min(subagentWaitMs(env), DEADLINE - WAIT_MARGIN_MS - Date.now());
    if (budget > 0) {
      const w = waitForSubagent(paths.gateDir, startState.phase, budget, io.wait || {});
      appendJournal(paths.gateDir, { type: 'subagent-wait', phase: startState.phase, ms: Math.round(w.waitedMs), ...(w.landed ? { landed: w.landed } : {}), ...(w.returned ? { returned: true } : {}) });
      if (w.landed) return runStopOnce({ ...args, waited: true }, attempt, note);
      if (w.returned) {
        const settled = { ...f, backgroundTasks: settleReturned(f.backgroundTasks, WAIT_ROLES[startState.phase], w.activity) };
        return runStopOnce({ ...args, facts: settled, waited: true }, attempt, note);
      }
    }
  }
  // the state on disk now, normalized: null when gone (disarmed meanwhile), 'torn' when unreadable
  // -> { text, state, why }: why 'gone' (ENOENT), 'busy' (a read refused at every retry), or null
  const readDisk = () => {
    let text = null;
    let why = null;
    for (let i = 0; i < READ_TRIES; i++) {
      if (i > 0) sleepMs(RENAME_WAIT_MS * i);
      try { text = (io.fs && io.fs.readFileSync ? io.fs.readFileSync : readFileSync)(paths.statePath, 'utf8'); why = null; break; } catch (e) { why = e && e.code === 'ENOENT' ? 'gone' : `busy (${(e && e.code) || 'error'})`; if (why === 'gone') break; }
    }
    if (text == null) return { text: null, state: null, why };
    let st = null;
    try { st = loadState(JSON.parse(text)).state; } catch { /* torn */ }
    return { text, state: st, why: null };
  };
  const disarmed = () => existsSync(join(paths.gateDir, DISARMED_MARK)) || existsSync(join(paths.gateDir, RETAINED_STATE));
  // Before this stop writes anything: if the state on disk is gone (disarmed meanwhile), stay
  // out; if another stop saved meanwhile (more than a verb's fields changed), start over from its
  // state instead of building on an older one
  {
    const now = readDisk();
    if (disarmed() || now.why === 'gone') {
      appendJournal(paths.gateDir, { type: 'note', text: `the loop was disarmed while this stop ran (${disarmed() ? 'gate marked' : 'state.json gone'}): nothing written` });
      return { output: null, outcome: 'dormant' };
    }
    // busy here: not verifiable now; the merge before the save reads again, and abandons if it still cannot
    if (now.why) appendJournal(paths.gateDir, { type: 'note', text: `state.json could not be read before writing: ${now.why}; going on, the save reads it again` });
    if (now.text !== startText && now.state && !onlyVerbChanges(startState, now.state)) {
      if (attempt < MAX_RESTARTS) {
        appendJournal(paths.gateDir, { type: 'stop-restarted', attempt: attempt + 1, diskRev: now.state.rev, startRev: startState.rev || 0 });
        return runStopOnce(args, attempt + 1, note);
      }
    }
  }
  holder.state = r.state;
  // the inbox files are consumed only by a stop that saves the state counting them
  const saves = r.effects.some((e) => e.type === 'saveState' || e.type === 'gitFinish');
  const counted = own.map((e) => e.name);
  if (saves && inbox) {
    // the names counted earlier leave the list only once their files are gone; the names
    // counted now join it, in the same save that counts their tokens
    const b = boundSeen([...settleSeen(paths.gateDir, holder.state.usageInboxSeen, unlink, io.stat), ...counted], paths.gateDir, io.stat);
    if (b.droppedPresent) appendJournal(paths.gateDir, { type: 'note', text: `usage inbox: ${b.droppedPresent} counted name(s) dropped past the guard of the list while their files are still on disk` });
    holder.state.usageInboxSeen = b.seen;
  }
  // Right before each attempt of the save. -> { state, expect } | { abandon: why }
  //   - state.json gone, or the gate marked disarmed/retained: the loop was disarmed while this
  //     stop ran; only `arm` creates a state, so the save is abandoned;
  //   - unchanged: ours, written only over the text read at the start;
  //   - only a verb's fields changed (report, test, claim-done, pause, the watchdog...): they
  //     are taken from disk (mergeVerbFields), the rev goes past both;
  //   - anything else changed: another stop saved; its state is not overwritten (its counts and
  //     decisions stand), this save is abandoned. Nothing is lost: the inbox files this stop
  //     counted are still on disk and not named there, the next stop counts them.
  // expect is the text the result was built on: writeDurable writes only over it, checked
  // before every rename attempt, so a writer during a retry makes the save start over here.
  // the base: the state read at the start, then the last one this stop saved (git-finish saves
  // twice in one stop)
  let baseText = startText;
  let baseState = startState;
  const saved = (st) => { baseState = JSON.parse(JSON.stringify(st)); baseText = JSON.stringify(st, null, 2); };
  const reconcile = (st) => {
    const now = readDisk();
    if (disarmed()) return { abandon: 'the loop was disarmed while this stop ran (gate marked)' };
    if (now.why === 'gone') return { abandon: 'state.json gone while this stop ran (disarmed)' };
    if (now.why) return { abandon: `state.json could not be read before the save: ${now.why}; the next stop counts what this one counted` };
    const expect = now.text;
    if (now.text === baseText || !now.state) return { state: { ...st, rev: (baseState.rev || 0) + 1 }, expect };
    if (!onlyVerbChanges(baseState, now.state)) return { abandon: `another stop saved while this one ran (rev ${now.state.rev})` };
    const m = mergeVerbFields(st, baseState, now.state);
    // An outcome (report, claim-done) that a verb wrote while this Stop ran is not carried into a
    // paused state: the Stop is pausing (an escalation, the plan approval) or a pause landed, and
    // the first Stop after /pf resume would act on it (a review passed without being redone).
    // The Stop's own values stand; the outcome is journaled as dropped.
    if (m.state.signals && m.state.signals.paused === true) {
      const dropped = OUTCOME_FIELDS.filter((p) => m.taken.includes(`signals.${p}`));
      if (dropped.length) {
        for (const p of dropped) m.state.signals[p] = st.signals[p];
        m.taken = m.taken.filter((p) => !dropped.includes(p.replace(/^signals\./, '')));
        appendJournal(paths.gateDir, { type: 'outcome-dropped-paused', fields: dropped.map((p) => `signals.${p}`), values: Object.fromEntries(dropped.map((p) => [p, now.state.signals[p]])), by: 'stop' });
      }
    }
    if (m.taken.length) appendJournal(paths.gateDir, { type: 'state-merged', fields: m.taken, diskRev: now.state.rev || 0, startRev: baseState.rev || 0 });
    return { state: { ...m.state, rev: Math.max(now.state.rev || 0, baseState.rev || 0) + 1 }, expect };
  };
  const fx = { paths, holder, deadline: DEADLINE, processEnv: env, io, reconcile, saved };
  const output = executeEffects(r.effects, fx);
  if (typeof io.afterSave === 'function') io.afterSave(paths);
  // The files counted now stay on disk: a later stop removes them, once the state it loads
  // names them (see savedCounts). The files of another run are never counted: removed now.
  if (saves && inbox) {
    const landed = savedCounts(paths.statePath, counted);
    if (landed) {
      removeInboxFiles(paths.gateDir, strays.map((e) => e.name), unlink);
      if (own.length) appendJournal(paths.gateDir, { type: 'usage-inbox', files: own.length });
    } else {
      if (own.length && existsSync(paths.statePath)) appendJournal(paths.gateDir, { type: 'note', text: `usage inbox: ${own.length} file(s) kept, the state that counts them is not on disk${fx.save && fx.save.error ? ` (${fx.save.error})` : ''}` });
    }
  }
  // a restore's sentinel goes once a Stop of the restored session is on disk (the session
  // started again: its process is on record, a later restore may terminate it)
  dropRestoreSentinel(paths.gateDir);
  // still armed and driven by this session: a fresh watchdog takes over the silence watch
  if (r.outcome !== 'foreign-session' && !r.state.signals.paused && existsSync(paths.statePath)) spawnWatchdog(paths.gateDir, env);
  return { output, outcome: r.outcome };
}
