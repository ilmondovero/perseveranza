// agent.spawn: a pf-* subagent runs on the model MODEL_ROUTING gives the run's complexity
// (routeModel, through the bridge's 'route-model', which journals the route). Fail-open: when
// the route cannot be had (no loop, another session's loop, the bridge down) the model the
// prompt asked for stands, and a failure is journaled as mod-hook-skipped.
//
// The subagent's id comes back from the spawn: the mod remembers its type and, for a
// verifier whose prompt names one lens file, its lens (the SubagentStop input does not say it).
import { QUICK_TIMEOUT_MS, isObj, loopAgentName, lensOf } from './core.js';
import { call, hasGate, skipped } from './gate.js';

// -> the model alias to spawn with, or null (keep e.model)
export async function routeFor(io, mod, e) {
  if (!isObj(e) || !loopAgentName(e.subagentType) || e.fork === true) return null;
  let cwd = '';
  let session = '';
  try {
    cwd = typeof e.cwd === 'string' && e.cwd ? e.cwd : await io.cwd();
    session = await io.sessionId();
  } catch (err) {
    await skipped(io, mod, cwd, 'agent.spawn', String((err && err.message) || err));
    return null;
  }
  if (!(await hasGate(io, cwd, true))) return null;
  const r = await call(io, mod, 'route-model', { cwd, event: { subagentType: e.subagentType, model: typeof e.model === 'string' ? e.model : '', session_id: session }, timeoutMs: QUICK_TIMEOUT_MS });
  if (!r.answer || r.answer.ok !== true) {
    await skipped(io, mod, cwd, 'agent.spawn', r.error || String(r.answer && r.answer.error));
    return null;
  }
  return typeof r.answer.model === 'string' && r.answer.model ? r.answer.model : null;
}

// After the spawn: which Agent call started which agent id (its SubagentStop closes that
// delegation, activity.js) and, for a loop subagent, which one it is.
export function rememberAgent(mod, e, result) {
  if (!isObj(e) || !isObj(result) || typeof result.agentId !== 'string' || !result.agentId) return;
  if (typeof e.tool_use_id === 'string' && e.tool_use_id) mod.agentTool[result.agentId] = e.tool_use_id;
  if (!loopAgentName(e.subagentType)) return;
  mod.agents[result.agentId] = { type: String(e.subagentType).slice(0, 80), lens: lensOf(e.prompt) };
}
