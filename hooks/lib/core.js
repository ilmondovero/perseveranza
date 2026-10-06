// What the mod's adapters share: the timings, the mod's ephemeral facts, and the pure helpers.
// No Node API and no timer globals here (a hooks module has neither): every call that reaches
// outside goes through the `io` object register.js builds from `$` for each hook.
//
// The mod keeps NO loop state in memory. What it keeps is ephemeral and safe to lose on a hot
// reload or a restart: tokens measured since the last flush, the last tool activity and the
// delegations not back yet, how many times a judge was sent back, which subagent is which.
import { loopAgentName, MAX_VERDICT_ASKS } from '../../src/core/subagents.mjs';
import { LENSES } from '../../src/core/state.mjs';
import { GATE, MAX_SKIP_NOTES } from './gate.js';

export { loopAgentName, MAX_VERDICT_ASKS, GATE, MAX_SKIP_NOTES };

// The first Claude Code with mods (the docs: "Mods require Claude Code v2.1.287 or later").
export const MIN_CLAUDE_CODE = '2.1.287';

// $.process.run timeouts. Time spent inside a $ call does not count against a hook's own
// 10 s, so a stop may wait for the bridge as long as the settings hook could (stop-core keeps
// its own deadline: PERSEVERANZA_HOOK_TIMEOUT_MS, 120 s, minus a margin).
export const STOP_TIMEOUT_MS = 125000;
export const FLUSH_TIMEOUT_MS = 8000;
export const QUICK_TIMEOUT_MS = 8000;
// in a .catch handler (1 s of grace for its own code; the $ call itself does not count)
export const CATCH_TIMEOUT_MS = 5000;
// A stop waits at most this long for a flush already on its way. This wait IS the hook's own
// time ($.clock.sleep runs the budget on, unlike the other $ calls): half of the 10 s, so the
// stop keeps the rest for its own code (its bridge call does not count).
export const STOP_FLUSH_WAIT_MS = 5000;

// Debounce of the flushes ($.clock.after): tokens every 15 s while a turn runs (and with every
// stop); a delegation or a subagent's return within 2 s; a plain tool call at most every 30 s
// (the activity hook's ACTIVITY_THROTTLE_MS).
export const USAGE_FLUSH_MS = 15000;
export const ACTIVITY_URGENT_MS = 2000;
export const ACTIVITY_HEARTBEAT_MS = 30000;
// a heartbeat the bridge could not write (state.json busy or corrupt) is sent again this many times
export const MAX_ACTIVITY_RETRIES = 5;

// the mod-start line is offered to a loop's journal this many times per process
export const MAX_HELLO_TRIES = 3;

// The tools a reconciliation refuses (activity-hook.mjs reconcileDecision): only these ask the
// bridge before running.
export const MUTATING_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'Bash', 'PowerShell'];

// The mod's own tool (verbs.js): its full name as the model calls it, learned from
// $.tool.register (mcp__<plugin>__perseveranza), and its verbs the reconciliation lets run
// without asking (they change nothing: activity-hook.mjs RECONCILE_TOOL_VERBS has these and pause).
export const OWN_TOOL = 'mcp__perseveranza__perseveranza';
export const READ_ONLY_VERBS = ['status', 'history', 'explain'];
export const isOwnTool = (mod, e) => isObj(e) && typeof e.tool === 'string' && e.tool === (mod.toolName || OWN_TOOL);

export function createMod() {
  return {
    node: null, // the node binary (PERSEVERANZA_NODE, else node on the PATH)
    bridge: null, // <plugin root>/src/shell/mod-bridge.mjs
    tail: Promise.resolve(), // the serial queue of the flushes
    usage: {}, // { <agentId|'main'>: counts } measured since the last flush
    usageTimer: null,
    activity: null, // the last activity record not yet written
    lines: [], // activity journal lines not yet written
    inflight: new Set(), // the flushes on their way (a stop waits for them, see stop.js)
    driving: false, // a stop of this process reached a live loop of this session
    pending: [], // delegations not back yet [{ at, agent, id: the Agent call's tool_use_id }]
    agentTool: {}, // agentId -> the tool_use_id of the Agent call that spawned it
    settled: {}, // agent_id -> its delegation was closed (once per subagent)
    activityTimer: null,
    activityDue: 0,
    activityRetries: 0,
    lastActivityFlush: 0,
    transcript: '',
    asks: {}, // agent_id -> times this judge was sent back for its verdict
    agents: {}, // agentId -> { type, lens } learned at agent.spawn
    hello: null, // { claudeCode, ok, min, problem } from session.start
    helloSent: false,
    helloTries: 0,
    skips: {}, // hook -> fail-open skips seen
    toolName: null, // the full name of the mod's tool, once registered (session.start)
    commandName: null, // the /pf command, once registered
    pluginName: '', // $.plugin.name
    alive: {}, // session id -> when its sign of life was last written or tried (verbs.js writeAlive, refreshAlive)
    alivePruned: false, // the old signs of life were looked at (verbs.js pruneAliveIfNeeded)
  };
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export { isObj };
export const errText = (e) => String((e && e.message) || e || 'unknown error').slice(0, 300);

// "2.1.289" or "2.1.289-dev..." -> [2, 1, 289] | null
function parts(v) {
  const m = typeof v === 'string' ? v.trim().match(/^(\d+)\.(\d+)\.(\d+)/) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// $.session.version() -> what the journal and `status` say about the Claude Code the mod runs on
export function versionCheck(v) {
  const raw = isObj(v) ? (typeof v.base === 'string' && v.base ? v.base : v.version) : null;
  const claudeCode = typeof raw === 'string' && raw ? raw.slice(0, 60) : 'unknown';
  const have = parts(raw);
  const min = parts(MIN_CLAUDE_CODE);
  if (!have) return { claudeCode, ok: false, min: MIN_CLAUDE_CODE, problem: 'the version could not be read' };
  for (let i = 0; i < 3; i++) {
    if (have[i] > min[i]) break;
    if (have[i] < min[i]) return { claudeCode, ok: false, min: MIN_CLAUDE_CODE, problem: `older than ${MIN_CLAUDE_CODE}, the first version with mods: hooks may be missing` };
  }
  return { claudeCode, ok: true, min: MIN_CLAUDE_CODE, problem: '' };
}

// A model response's usage (turn.step's result.usage) in the loop's counts; null when absent.
export function usageCounts(u) {
  if (!isObj(u)) return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const c = { inputTokens: n(u.input_tokens), outputTokens: n(u.output_tokens), cacheReadTokens: n(u.cache_read_input_tokens), cacheCreationTokens: n(u.cache_creation_input_tokens) };
  return c.inputTokens || c.outputTokens || c.cacheReadTokens || c.cacheCreationTokens ? c : null;
}

// The lens a verifier was given, when its prompt names exactly one lens file (verify-<lens>.json).
export function lensOf(prompt) {
  if (typeof prompt !== 'string') return undefined;
  const found = new Set();
  for (const m of prompt.matchAll(/verify-([a-z]+)\.json/g)) if (LENSES.includes(m[1])) found.add(m[1]);
  return found.size === 1 ? [...found][0] : undefined;
}

// The judges the loop waits a verdict from.
export function isJudge(agentType) {
  const n = loopAgentName(agentType);
  return n === 'pf-reviewer' || n === 'pf-verifier';
}
