// tool.call: the reconciliation guard (while a restored loop is being reconciled, a tool that
// would mutate is refused: activity-hook.mjs's reconcileDecision, asked of the bridge's
// 'tool-check'), then the heartbeat. The guard asks only for the tools it could refuse, only
// where a loop is armed (gate.js hasGate); it is fail-open like the settings hook was (a failure is
// journaled as mod-hook-skipped and the tool runs).
import { MUTATING_TOOLS, QUICK_TIMEOUT_MS, isObj } from './core.js';
import { call, hasGate, skipped } from './gate.js';
import { noteTool, scheduleActivity } from './activity.js';
import { refreshAlive } from './verbs.js';

// tool.call's input is the tool's input with tool, tool_use_id (and agentId) beside it
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent']);
export function toolInput(e) {
  return Object.fromEntries(Object.entries(isObj(e) ? e : {}).filter(([k]) => !RESERVED.has(k)));
}

// -> the reason to refuse, or null
export async function guardTool(io, mod, e, session) {
  if (!isObj(e) || !MUTATING_TOOLS.includes(e.tool)) return null;
  let cwd = '';
  try { cwd = await io.cwd(); } catch (err) {
    await skipped(io, mod, '', 'tool.call', String((err && err.message) || err));
    return null;
  }
  if (!(await hasGate(io, cwd, true))) return null;
  return askGuard(io, mod, cwd, session, e.tool, toolInput(e));
}

// The bridge's reconciliation guard for one call (op 'tool-check'). Fail-open. -> reason | null
export async function askGuard(io, mod, cwd, session, tool, input) {
  const r = await call(io, mod, 'tool-check', { cwd, event: { session_id: session, tool, input }, timeoutMs: QUICK_TIMEOUT_MS });
  if (!r.answer || r.answer.ok !== true) {
    await skipped(io, mod, cwd, 'tool.call', r.error || String(r.answer && r.answer.error));
    return null;
  }
  return typeof r.answer.deny === 'string' && r.answer.deny ? r.answer.deny : null;
}

// -> { deny } to refuse the call, or null to let it run (and count it as life)
export async function onToolCall(io, mod, e) {
  let session = '';
  let now = 0;
  try { session = await io.sessionId(); now = await io.now(); } catch { /* the record goes without them */ }
  // the sign of life for `arm`, kept fresh (verbs.js refreshAlive): before the tool runs
  await refreshAlive(io, mod, session);
  const deny = await guardTool(io, mod, e, session);
  if (deny) return { deny };
  scheduleActivity(io, mod, noteTool(mod, e, now, session), now);
  return null;
}
