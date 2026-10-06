// Tokens per agent, exact, from turn.step (every model request, main's and every subagent's,
// with its cache counts). They wait in memory and go to the bridge's inbox ('usage-flush')
// every USAGE_FLUSH_MS while a turn runs, and with every stop (facts.usage). The next stop
// adds them to state.json (usage-inbox.mjs): the mod never writes state.json.
//
// The bridge's contract for a delta (mod-bridge.mjs, PIANO-MOD "Stato fase 1"):
//   queued      counted once by a later stop                      -> done
//   dropped     { ok: false, error } (not 'no-loop'): no file under an inbox name can exist,
//               nobody ever counts it                             -> sent again (back in memory)
//   unverified  unverified: true: a file may exist and may already be counted
//                                                                 -> NOT sent again
//   no answer   the bridge died or timed out: it may have queued it first
//                                                                 -> NOT sent again
//   no-loop     no run to count it for (never armed, archived)    -> dropped for good
//   busy / corrupt state.json: the bridge queues it as armUnknown (usage-queued) -> done
//   foreign-session: another session's loop                       -> dropped for good
import { usageCounts, isObj, USAGE_FLUSH_MS, FLUSH_TIMEOUT_MS } from './core.js';
import { call, enqueue, hasGate, track } from './gate.js';

const KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'];

function add(into, key, counts) {
  const prev = into[key] || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  into[key] = Object.fromEntries(KEYS.map((k) => [k, prev[k] + (counts[k] || 0)]));
}

// One model request: e is turn.step's input (agentId for a subagent), result its response.
export function addStep(mod, e, result) {
  const c = usageCounts(isObj(result) ? result.usage : null);
  if (!c) return false;
  const key = isObj(e) && typeof e.agentId === 'string' && e.agentId ? e.agentId.slice(0, 80) : 'main';
  add(mod.usage, key, c);
  return true;
}

// The delta since the last flush, taken out of memory (null: nothing measured).
export function takeUsage(mod) {
  const d = mod.usage;
  mod.usage = {};
  return Object.keys(d).length ? d : null;
}

// A delta the bridge surely did not queue goes back, to leave with the next flush or stop.
export function giveBack(mod, delta) {
  for (const [k, c] of Object.entries(isObj(delta) ? delta : {})) if (isObj(c)) add(mod.usage, k, c);
}

// What happens to a flushed delta, by the bridge's answer (the contract above).
export function settleUsage(mod, delta, r) {
  if (!r || !r.answer) return 'no-answer';
  const a = r.answer;
  if (a.ok !== true) {
    if (a.error === 'no-loop') return 'no-loop';
    giveBack(mod, delta);
    return 'dropped';
  }
  if (a.unverified === true) return 'unverified';
  return typeof a.outcome === 'string' ? a.outcome : 'queued';
}

export async function flushUsage(io, mod) {
  const delta = takeUsage(mod);
  if (!delta) return 'empty';
  let cwd = '';
  let session = '';
  try { cwd = await io.cwd(); session = await io.sessionId(); } catch { /* below */ }
  // a project without an armed loop: these tokens are no run's (what 'no-loop' would say)
  if (!(await hasGate(io, cwd, true))) return 'no-gate';
  const r = await enqueue(mod, () => call(io, mod, 'usage-flush', { cwd, event: { session_id: session }, facts: { usage: { byAgent: delta } }, timeoutMs: FLUSH_TIMEOUT_MS }));
  return settleUsage(mod, delta, r);
}

// After a request: a flush within USAGE_FLUSH_MS, one timer at a time.
export function scheduleUsage(io, mod) {
  if (mod.usageTimer) return;
  mod.usageTimer = io.after(USAGE_FLUSH_MS, () => {
    mod.usageTimer = null;
    // tracked: a stop that comes meanwhile waits for it (its delta may come back to memory)
    return track(mod, () => flushUsage(io, mod)).catch(() => 'error');
  });
}

// A stop carries the delta itself: no flush of it is left pending.
export function cancelUsageTimer(mod) {
  if (mod.usageTimer) { try { mod.usageTimer.cancel(); } catch { /* gone */ } }
  mod.usageTimer = null;
}
