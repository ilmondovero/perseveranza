// classic.SubagentStop: for a judge (pf-reviewer, pf-verifier), the check that the verdict it
// was asked for is on disk, then the heartbeat (a delegation came back). When the verdict is
// missing, stale or malformed the judge is sent back ({ block }) with the reason, at most
// MAX_VERDICT_ASKS times per subagent; then it goes, and the machine's own `missing` outcome is
// the net. Fail-closed like the stop: no answer from the bridge -> the .catch sends the judge
// back once, unless stop_hook_active says it was already sent back (never an endless block).
//
// A judge sent back is still running: its delegation stays open. It closes once, when the
// subagent is let go (by its agent_id, see activity.js noteSubagentStop).
import { MAX_VERDICT_ASKS, QUICK_TIMEOUT_MS, CATCH_TIMEOUT_MS, isObj, isJudge, errText } from './core.js';
import { call, hasGate } from './gate.js';
import { noteSubagentStop, scheduleActivity } from './activity.js';

const idOf = (e) => (isObj(e) && typeof e.agent_id === 'string' ? e.agent_id : '');

// The subagent is let go: its delegation closes (once per agent_id) and the heartbeat goes.
async function letGo(io, mod, e) {
  const id = idOf(e);
  if (id && mod.settled[id]) return;
  if (id) mod.settled[id] = true;
  let now = 0;
  try { now = await io.now(); } catch { /* 0: the record is still written */ }
  scheduleActivity(io, mod, noteSubagentStop(mod, e, now), now);
}

// -> { block } to send the judge back, or null. Throws when the bridge gives no answer.
async function judge(io, mod, e) {
  if (!isObj(e) || !isJudge(e.agent_type)) return null;
  const id = idOf(e);
  const asked = mod.asks[id] || 0;
  if (asked >= MAX_VERDICT_ASKS) return null;
  const cwd = typeof e.cwd === 'string' && e.cwd ? e.cwd : await io.cwd();
  if (!(await hasGate(io, cwd, true))) return null;
  const known = mod.agents[id];
  const facts = { askedTimes: asked, ...(known && known.lens ? { lens: known.lens } : {}) };
  const r = await call(io, mod, 'subagent-stop', { cwd, event: e, facts, timeoutMs: QUICK_TIMEOUT_MS });
  if (!r.answer) throw new Error(r.error || 'no answer from the bridge');
  if (r.answer.ok !== true) throw new Error(`the bridge failed: ${String(r.answer.error || 'unknown').slice(0, 200)}`);
  const block = isObj(r.answer.decision) && typeof r.answer.decision.block === 'string' && r.answer.decision.block.trim() ? r.answer.decision.block : null;
  if (!block) return null;
  mod.asks[id] = asked + 1;
  return { block };
}

export async function onSubagentStop(io, mod, e) {
  const decision = await judge(io, mod, e);
  if (!decision) await letGo(io, mod, e);
  return decision;
}

export function verdictUncheckedText(error) {
  return `perseveranza (mod): your verdict could not be checked (${error}). Before you finish, make sure the verdict file you were asked to write (.perseveranza/review.json, or .perseveranza/verify.json / verify-<lens>.json) exists, is valid JSON, and carries the requestId you were given. Then finish.`;
}

// The .catch of classic.SubagentStop -> { block } | null.
async function failed(io, mod, e, error) {
  if (!isObj(e) || !isJudge(e.agent_type) || e.stop_hook_active === true) return null;
  const id = idOf(e);
  const asked = mod.asks[id] || 0;
  if (asked >= MAX_VERDICT_ASKS) return null;
  const cwd = typeof e.cwd === 'string' ? e.cwd : '';
  if (!(await hasGate(io, cwd, false))) return null;
  const session = typeof e.session_id === 'string' ? e.session_id : '';
  await call(io, mod, 'journal', { cwd, event: { session_id: session }, facts: { lines: [{ type: 'mod-hook-skipped', hook: 'classic.SubagentStop', error: errText(error), recovery: true }] }, timeoutMs: CATCH_TIMEOUT_MS });
  mod.asks[id] = asked + 1;
  return { block: verdictUncheckedText(errText(error)) };
}

export async function onSubagentStopFailed(io, mod, e, error) {
  const decision = await failed(io, mod, e, error);
  if (!decision) await letGo(io, mod, e);
  return decision;
}
