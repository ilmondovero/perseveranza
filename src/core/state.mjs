// Loop state: schema v2, defaults, normalisation and migration from the v1 flat layout.
// Pure: no filesystem access. The shell reads/writes the JSON; this module says what it means.
//
// Ownership (the contract the v1 comments described, now visible in the shape):
//   phase, counters, flags, owner, usage, tree -> written only by the Stop hook
//   signals, lastTest                          -> written only by the verbs
//   options, limits                       -> written only by `arm` (and adaptive budget once)
// with the exceptions VERB_OWNED lists (complexity, resume's counters and owner release, the
// test command, the watchdog's interruption). rev: incremented by every save, whoever
// writes, so a writer can tell that the state changed under it (shell/state-file.mjs).

export const SCHEMA_VERSION = 2;
export const PHASES = ['plan', 'implement', 'review', 'cleanup', 'final-verify', 'git-finish'];
export const COMPLEXITIES = ['low', 'medium', 'high'];
export const DEFAULT_MAX_ITERATIONS = 25;
export const DEFAULT_MAX_RETRIES = 3;
// The lenses of the final verification: `general` is the single verifier of old; the others
// split the adversarial mandate among verifiers that run side by side (arm --verifiers).
export const LENSES = ['general', 'correctness', 'security', 'tests'];
export const AUTO_LENSES_HIGH = ['correctness', 'security', 'tests'];
// the rejected rounds whose findings the next final verification rechecks
export const MAX_PRIOR_VERIFIES = 3;
// the rejected reviews of the current step, handed to the advisor of the fix
export const MAX_PRIOR_REVIEWS = 10;
// The internal advisor (agents/pf-advisor.md): a second opinion that never routes the loop.
export const DEFAULT_ADVISOR_MODEL = 'opus';
// a model name as the Agent tool takes it (opus, sonnet, claude-opus-4-1, opus[1m]...)
export const ADVISOR_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;
export const normalizeAdvisorModel = (v) => (typeof v === 'string' && ADVISOR_MODEL_RE.test(v.trim()) ? v.trim() : DEFAULT_ADVISOR_MODEL);

// Known lenses only, each once, in the order given. -> [] when nothing is left.
export function normalizeLenses(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const l of raw) {
    const k = String(l ?? '').trim().toLowerCase();
    if (LENSES.includes(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

// The lenses a final verification round asks for: the ones armed, else by complexity.
export function effectiveLenses(s) {
  const chosen = normalizeLenses(s && s.options && s.options.verifiers);
  if (chosen.length) return chosen;
  return s && s.complexity === 'high' ? [...AUTO_LENSES_HIGH] : ['general'];
}

// One verifier writing verify.json, as before the lenses: the round the machine reads alone.
export const singleLens = (lenses) => !Array.isArray(lenses) || !lenses.length || (lenses.length === 1 && lenses[0] === 'general');

export function defaultState(overrides = {}) {
  const s = {
    schemaVersion: SCHEMA_VERSION,
    task: '',
    phase: 'plan',
    complexity: 'medium',
    options: {
      commitSteps: false,
      gitFinish: true,
      gitPush: true,
      approvePlan: false,
      testCmd: null,
      externals: [],
      lang: 'it',
      // final verification lenses chosen at arm; null = automatic (by complexity, per round)
      verifiers: null,
      // the internal advisor at the plan and from the 2nd fix (arm --advisor, --advisor-model)
      advisor: true,
      advisorModel: DEFAULT_ADVISOR_MODEL,
      // how the instructions name the verbs: 'tool' (the mod's `perseveranza` tool, set by
      // `arm` when the mod is alive in the arming session) or 'shell' (the CLI command)
      loopMode: 'shell',
      // paths whose UNTRACKED files the work-tree fingerprint and the git finish leave out, beside
      // the known tool state (git.mjs VOLATILE_PATHS): arm --ignore, validated there
      fingerprintIgnore: [],
    },
    // staleGates: final passes in a row that did not cover the current tree (pass-stale)
    // subagentWaits: stops answered with subagent-running (a pf-* subagent still running,
    // seen only by the mod) for the current verdict request; a new request or phase resets it
    // quietStops: stops in a row that asked for no new work (subagent-running, missing, idle)
    counters: { iterations: 0, retries: 0, finalFails: 0, staleGates: 0, subagentWaits: 0, quietStops: 0 },
    limits: { maxIterations: DEFAULT_MAX_ITERATIONS, maxIterationsExplicit: false, maxRetries: DEFAULT_MAX_RETRIES, maxTokens: null },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, source: null },
    // resumedAt: when `resume` closed a pause (ms); consumed by the next fire so the gap
    // it journals is marked as a human's pause, not a dead session
    // interrupted: written by the watchdog when it kills and restores the session; the next
    // Stop runs a read-only reconciliation before anything else
    signals: { lastReport: 'none', claimedDone: false, paused: false, resumedAt: 0, interrupted: null },
    flags: { repeated: false, cleanedOnce: false, planPresented: false, reconcileAsked: false },
    lastTest: null,
    baselineDirty: [],
    // releasedFrom: the previous owner after `resume --takeover`, until the next fire claims
    // transcriptPath: the session transcript (a sign of life); claudePid/claudeStartedAt: the
    // Claude Code process driving the loop, for the watchdog's kill-and-restore
    owner: { sessionId: null, lastFireAt: 0, releasedFrom: null, releasedAt: 0, transcriptPath: null, claudePid: 0, claudeStartedAt: null },
    // the work tree as the hook last saw it: lets it notice a stop that changed nothing
    tree: { fingerprint: null, iteration: 0 },
    // when the phase that awaits a verdict (review, final-verify) was entered: a verdict file
    // written before that instant answers an earlier request, not this one
    verdictRequestedAt: 0,
    // Correlation token copied into the reviewer/verifier verdict. Unlike file timestamps it
    // also rejects an old agent that finishes after a replacement request was issued.
    verdictRequestId: null,
    // the code fingerprint the request pointed at (null: not computable, e.g. outside git): a
    // final pass closes only the tree it judged
    verdictTree: null,
    // the lenses the current final verification round asked for (fixed when it is requested)
    verdictLenses: [],
    // the kept findings (verify-<n>.json) of the last rejected rounds: rechecked by the next
    priorVerifies: [],
    // the kept rejections (review-<n>.json) of the current step: the advisor of the fix reads
    // every attempt that already failed, not only the last one
    priorReviews: [],
    // the files of the mod's usage inbox (.perseveranza/usage-inbox/) already added to usage
    usageInboxSeen: [],
    armedAt: null,
    engineVersion: null,
    rev: 0,
  };
  return deepMerge(s, overrides);
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
const bool = (v, def) => (typeof v === 'boolean' ? v : def);
const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'];
// A token count is a finite non-negative integer. A value too large to count (1e308, a
// string of digits, Infinity) saturates at MAX_TOKENS instead of falling back to 0: tokens
// already spent never vanish from the budget. NaN, a negative or a non-number is 0.
export const MAX_TOKENS = Number.MAX_SAFE_INTEGER;
// one delta of the mod (one flush, one agent, one field) is never more than this: past it the
// value is clamped and the caller journals it (usage-clamped)
export const MAX_TOKEN_DELTA = 1e12;
// A string counts only when it is plain decimal digits (with an optional fraction): what a
// writer may quote of a JSON number. No sign, exponent, hex (0x10), binary (0b11), octal or
// whitespace: Number() would read those, and a count that came out of a file must not.
const DECIMAL = /^\d+(\.\d+)?$/;
export function tokenCount(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && DECIMAL.test(v) ? Number(v) : NaN;
  if (Number.isNaN(n) || n <= 0) return 0;
  return n >= MAX_TOKENS ? MAX_TOKENS : Math.floor(n);
}
const tokenCounts = (o) => Object.fromEntries(USAGE_KEYS.map((k) => [k, tokenCount(o && o[k])]));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const MAX_USAGE_AGENTS = 16;
// Stops a pf-* subagent still running may hold the loop (subagent-running) for one verdict
// request (one phase, where none is pending): past it the usual logic applies, so the loop
// never spends Claude Code's cap of text-only continuations on waiting (see MAX_QUIET_STOPS
// in machine.mjs for the cap across waits and missing outcomes).
export const MAX_SUBAGENT_WAITS = 3;

// saturating: a sum never becomes Infinity (which a later read would turn into 0)
const addCounts = (a, b) => Object.fromEntries(USAGE_KEYS.map((k) => [k, Math.min(MAX_TOKENS, (a ? a[k] : 0) + (b ? b[k] : 0))]));
const spendOf = (c) => c.inputTokens + c.outputTokens;

// The rows of a mod reading, folded to the cap: main, the biggest spenders, and the rest
// summed under "other" (never dropped: the budget must see every token).
function foldAgents(rows) {
  const byKey = new Map();
  for (const [k, c] of rows) byKey.set(k, addCounts(byKey.get(k), c));
  const main = byKey.get('main');
  const other = byKey.get('other');
  const rest = [...byKey].filter(([k]) => k !== 'main' && k !== 'other').sort((a, b) => spendOf(b[1]) - spendOf(a[1]));
  const room = MAX_USAGE_AGENTS - (main ? 1 : 0);
  const fits = rest.length + (other ? 1 : 0) <= room;
  const kept = fits ? rest : rest.slice(0, room - 1);
  let folded = other || null;
  if (!fits) for (const [, c] of rest.slice(room - 1)) folded = addCounts(folded, c);
  return Object.fromEntries([...(main ? [['main', main]] : []), ...kept, ...(folded ? [['other', folded]] : [])]);
}

// state.usage: the totals the budget reads, plus the split by agent kind and
// the subagents' share. Coerced here, not trusted: it comes from files Claude Code writes.
// source 'mod': the mod measures every request by agent id, so byAgent IS the reading and the
// totals are at least its sum (the budget counts every agent's tokens).
export function normalizeUsage(raw) {
  const u = isObj(raw) ? raw : {};
  const out = { ...tokenCounts(u), source: typeof u.source === 'string' ? u.source.slice(0, 40) : null };
  if (isObj(u.byAgent)) {
    const rows = Object.entries(u.byAgent).filter(([, v]) => isObj(v)).map(([k, v]) => [String(k).slice(0, 80), tokenCounts(v)]);
    if (out.source === 'mod') {
      const sum = rows.reduce((acc, [, c]) => addCounts(acc, c), null);
      if (sum) for (const k of USAGE_KEYS) out[k] = Math.max(out[k], sum[k]);
      out.byAgent = foldAgents(rows);
    } else out.byAgent = Object.fromEntries(rows.slice(0, MAX_USAGE_AGENTS));
  }
  if (isObj(u.subagents)) out.subagents = { files: Math.max(0, num(u.subagents.files, 0)), ...tokenCounts(u.subagents) };
  if (u.partial === true) out.partial = true;
  return out;
}

// The tokens the mod measured since its last flush ({ <agentId|'main'>: counts }) added to
// the reading in state.usage. A reading of another source (the transcripts, before the mod
// drove the run) becomes the "main" row it started from: nothing already spent is lost.
// Every field of the delta is a count (tokenCount) clamped to MAX_TOKEN_DELTA; each clamp is
// pushed to `clamped` ({ agent, field, value }) for the caller to journal. The totals only
// grow: a hostile delta adds 0, never subtracts.
// -> a normalized usage with source 'mod'
export function mergeModUsage(prev, delta, clamped = null) {
  const p = normalizeUsage(prev);
  const base = new Map(p.source === 'mod' && p.byAgent ? Object.entries(p.byAgent)
    : spendOf(p) || p.cacheReadTokens || p.cacheCreationTokens ? [['main', tokenCounts(p)]] : []);
  let added = null;
  for (const [k, v] of Object.entries(isObj(delta) ? delta : {})) {
    if (!isObj(v)) continue;
    const key = String(k).slice(0, 80) || 'main';
    const c = Object.fromEntries(USAGE_KEYS.map((f) => {
      const n = tokenCount(v[f]);
      if (n > MAX_TOKEN_DELTA) {
        if (Array.isArray(clamped)) clamped.push({ agent: key, field: f, value: String(v[f]).slice(0, 40) });
        return [f, MAX_TOKEN_DELTA];
      }
      return [f, n];
    }));
    base.set(key, addCounts(base.get(key), c));
    added = addCounts(added, c);
  }
  const subs = [...base].filter(([k]) => k !== 'main');
  const subTotals = subs.reduce((acc, [, c]) => addCounts(acc, c), null);
  return normalizeUsage({
    ...addCounts(tokenCounts(p), added),
    source: 'mod',
    byAgent: Object.fromEntries(base),
    ...(subTotals ? { subagents: { files: subs.length, ...subTotals } } : {}),
  });
}

// Fill defaults and coerce types on a v2 object. Never throws on odd input.
export function normalizeState(raw) {
  const s = defaultState(raw && typeof raw === 'object' ? raw : {});
  const defaults = defaultState();
  for (const key of ['counters', 'limits', 'usage', 'signals', 'flags', 'options', 'owner', 'tree']) {
    if (!s[key] || typeof s[key] !== 'object' || Array.isArray(s[key])) s[key] = defaults[key];
  }
  s.schemaVersion = SCHEMA_VERSION;
  s.task = String(s.task ?? '');
  if (!PHASES.includes(s.phase)) s.phase = 'plan';
  if (!COMPLEXITIES.includes(s.complexity)) s.complexity = 'medium';
  s.counters.iterations = Math.max(0, num(s.counters.iterations, 0));
  s.counters.retries = Math.max(0, num(s.counters.retries, 0));
  s.counters.finalFails = Math.max(0, num(s.counters.finalFails, 0));
  s.counters.staleGates = Math.max(0, num(s.counters.staleGates, 0));
  s.counters.subagentWaits = Math.max(0, num(s.counters.subagentWaits, 0));
  s.counters.quietStops = Math.max(0, num(s.counters.quietStops, 0));
  s.limits.maxIterations = num(s.limits.maxIterations, DEFAULT_MAX_ITERATIONS);
  if (s.limits.maxIterations < 1) s.limits.maxIterations = DEFAULT_MAX_ITERATIONS;
  s.limits.maxIterationsExplicit = bool(s.limits.maxIterationsExplicit, false);
  s.limits.maxRetries = num(s.limits.maxRetries, DEFAULT_MAX_RETRIES);
  if (s.limits.maxRetries < 1) s.limits.maxRetries = DEFAULT_MAX_RETRIES;
  s.limits.maxTokens = s.limits.maxTokens == null ? null : Math.max(0, num(s.limits.maxTokens, 0)) || null;
  s.usage = normalizeUsage(s.usage);
  s.signals.lastReport = ['pass', 'fail'].includes(s.signals.lastReport) ? s.signals.lastReport : 'none';
  s.signals.claimedDone = bool(s.signals.claimedDone, false);
  s.signals.paused = bool(s.signals.paused, false);
  s.signals.resumedAt = Math.max(0, num(s.signals.resumedAt, 0));
  if (s.signals.interrupted && typeof s.signals.interrupted === 'object') {
    const i = s.signals.interrupted;
    s.signals.interrupted = { at: i.at ?? null, silentMs: Math.max(0, num(i.silentMs, 0)), phase: typeof i.phase === 'string' ? i.phase : '', pending: Array.isArray(i.pending) ? i.pending.map(String).slice(0, 10) : [] };
  } else s.signals.interrupted = null;
  s.flags.reconcileAsked = bool(s.flags.reconcileAsked, false);
  s.flags.repeated = bool(s.flags.repeated, false);
  s.flags.cleanedOnce = bool(s.flags.cleanedOnce, false);
  s.flags.planPresented = bool(s.flags.planPresented, false);
  s.options.commitSteps = bool(s.options.commitSteps, false);
  s.options.gitFinish = bool(s.options.gitFinish, true);
  s.options.gitPush = bool(s.options.gitPush, true);
  s.options.approvePlan = bool(s.options.approvePlan, false);
  s.options.testCmd = s.options.testCmd ? String(s.options.testCmd) : null;
  s.options.externals = Array.isArray(s.options.externals) ? s.options.externals.map(String) : [];
  s.options.lang = typeof s.options.lang === 'string' && s.options.lang ? s.options.lang : 'it';
  const verifiers = normalizeLenses(s.options.verifiers);
  s.options.verifiers = verifiers.length ? verifiers : null;
  s.options.advisor = bool(s.options.advisor, true);
  s.options.advisorModel = normalizeAdvisorModel(s.options.advisorModel);
  s.options.loopMode = s.options.loopMode === 'tool' ? 'tool' : 'shell';
  // plain relative paths only (git.mjs ignorePath validates them again where they are used)
  s.options.fingerprintIgnore = Array.isArray(s.options.fingerprintIgnore) ? s.options.fingerprintIgnore.filter((p) => typeof p === 'string' && p && p.length <= 200).slice(0, 50) : [];
  s.baselineDirty = Array.isArray(s.baselineDirty) ? s.baselineDirty.map(String) : [];
  if (s.lastTest && typeof s.lastTest === 'object') {
    s.lastTest = {
      cmd: String(s.lastTest.cmd ?? ''),
      exitCode: num(s.lastTest.exitCode, 1),
      iteration: num(s.lastTest.iteration, -1),
      at: s.lastTest.at ?? null,
      fingerprint: s.lastTest.fingerprint ?? null,
      // the same snapshot without documentation files (null on states written before 2.1)
      codeFingerprint: s.lastTest.codeFingerprint ?? null,
      // names of the tests that failed, as far as the runner's output could be parsed
      failed: Array.isArray(s.lastTest.failed) ? s.lastTest.failed.map(String) : [],
    };
  } else s.lastTest = null;
  s.verdictRequestedAt = Math.max(0, num(s.verdictRequestedAt, 0));
  s.verdictRequestId = typeof s.verdictRequestId === 'string' && s.verdictRequestId ? s.verdictRequestId : null;
  s.verdictTree = typeof s.verdictTree === 'string' && s.verdictTree ? s.verdictTree : null;
  s.verdictLenses = normalizeLenses(s.verdictLenses);
  s.priorVerifies = Array.isArray(s.priorVerifies)
    ? s.priorVerifies.map(String).filter((n) => /^verify-\d+\.json$/.test(n)).slice(-MAX_PRIOR_VERIFIES)
    : [];
  s.priorReviews = Array.isArray(s.priorReviews)
    ? s.priorReviews.map(String).filter((n) => /^review-\d+\.json$/.test(n)).slice(-MAX_PRIOR_REVIEWS)
    : [];
  s.usageInboxSeen = Array.isArray(s.usageInboxSeen) ? s.usageInboxSeen.map(String).filter((n) => /^[\w-]+\.json$/.test(n)).slice(-5000) : [];
  s.rev = Math.max(0, Math.floor(num(s.rev, 0)));
  s.tree.fingerprint = typeof s.tree.fingerprint === 'string' && s.tree.fingerprint ? s.tree.fingerprint : null;
  s.tree.iteration = Math.max(0, num(s.tree.iteration, 0));
  s.owner.sessionId = typeof s.owner.sessionId === 'string' && s.owner.sessionId ? s.owner.sessionId : null;
  s.owner.lastFireAt = Math.max(0, num(s.owner.lastFireAt, 0));
  s.owner.releasedFrom = typeof s.owner.releasedFrom === 'string' && s.owner.releasedFrom ? s.owner.releasedFrom : null;
  s.owner.releasedAt = Math.max(0, num(s.owner.releasedAt, 0));
  s.owner.transcriptPath = typeof s.owner.transcriptPath === 'string' && s.owner.transcriptPath ? s.owner.transcriptPath : null;
  s.owner.claudePid = Math.max(0, num(s.owner.claudePid, 0));
  s.owner.claudeStartedAt = typeof s.owner.claudeStartedAt === 'string' && s.owner.claudeStartedAt ? s.owner.claudeStartedAt : null;
  return s;
}

// The fields the verbs (and the watchdog) write, as paths. The Stop saves the state it read at
// its start plus its own decisions: a field of this list that changed on disk since that read
// was changed by a verb meanwhile, and the verb's value wins (mergeVerbFields).
export const VERB_OWNED = [
  'signals.lastReport', 'signals.claimedDone', 'signals.paused', 'signals.resumedAt', 'signals.interrupted',
  'lastTest', 'complexity', 'options.testCmd',
  'counters.retries', 'counters.finalFails', 'counters.staleGates',
  'flags.repeated', 'flags.reconcileAsked',
  'owner.sessionId', 'owner.releasedFrom', 'owner.releasedAt',
];
const getPath = (o, p) => p.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), o);
const setPath = (o, p, val) => { const ks = p.split('.'); const last = ks.pop(); let t = o; for (const k of ks) { if (!t[k] || typeof t[k] !== 'object') t[k] = {}; t = t[k]; } t[last] = val; };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// ours: the state about to be saved; start: the state read at the start; disk: the state on
// disk now. -> { state, taken: [paths taken from disk] }. Pure; never throws on odd input.
// The limit: it compares VALUES, not writes. A verb that wrote the value the field already had
// at the start is invisible, and the Stop's value stands: `resume` resetting counters.retries
// to 0 while it was 0 at the start and the Stop raised it to 1 keeps the 1, though the reset
// came later. A per-field write counter would tell them apart; it is not there yet, and the
// cost is one retry counted once more.
export function mergeVerbFields(ours, start, disk) {
  const out = JSON.parse(JSON.stringify(ours));
  const taken = [];
  if (!disk || typeof disk !== 'object' || !start || typeof start !== 'object') return { state: out, taken };
  for (const p of VERB_OWNED) {
    const d = getPath(disk, p);
    if (!same(d, getPath(start, p))) { setPath(out, p, d === undefined ? null : JSON.parse(JSON.stringify(d))); taken.push(p); }
  }
  return { state: out, taken };
}

// Did only the fields a verb owns (and the rev) change from start to disk? true: a verb or the
// watchdog wrote meanwhile (mergeVerbFields keeps it); false: another Stop saved (or the state
// is not comparable), and its whole state must not be overwritten. Both normalized states.
export function onlyVerbChanges(start, disk) {
  if (!start || !disk || typeof start !== 'object' || typeof disk !== 'object') return false;
  const strip = (s) => { const c = JSON.parse(JSON.stringify(s)); for (const p of VERB_OWNED) setPath(c, p, null); c.rev = 0; return JSON.stringify(c); };
  return strip(start) === strip(disk);
}

// A v1 state is a flat object with `phase` and no schemaVersion.
export function isV1State(raw) {
  return !!raw && typeof raw === 'object' && raw.schemaVersion == null && typeof raw.phase === 'string';
}

// Map the v1 flat layout onto v2. Unknown fields are dropped; defaults fill the rest.
export function migrateV1(raw) {
  return normalizeState({
    task: raw.task,
    phase: raw.phase,
    complexity: raw.complexity,
    options: {
      commitSteps: raw.commitSteps,
      gitFinish: raw.gitFinish,
      gitPush: raw.gitPush,
      approvePlan: raw.approvePlan,
      testCmd: raw.testCmd ?? null,
      externals: raw.externals,
    },
    counters: { iterations: raw.iterations, retries: raw.retries, finalFails: raw.finalFails },
    limits: { maxIterations: raw.max, maxIterationsExplicit: true, maxRetries: raw.maxRetries },
    signals: { lastReport: raw.lastReport, claimedDone: raw.claimedDone, paused: raw.paused },
    flags: { repeated: raw.repeated, cleanedOnce: raw.cleanedOnce, planPresented: raw.planPresented },
    lastTest: raw.lastTest ?? null,
    baselineDirty: raw.baselineDirty,
    owner: { sessionId: raw.sessionId ?? null, lastFireAt: raw.lastFireAt },
  });
}

// Load any raw JSON value into a v2 state.
// Returns { state, migrated } or { state: null, error } when the input is not a loop state at all.
export function loadState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: null, error: 'not an object' };
  if (isV1State(raw)) return { state: migrateV1(raw), migrated: true };
  if (typeof raw.phase !== 'string') return { state: null, error: 'missing phase' };
  return { state: normalizeState(raw), migrated: false };
}

// The exit ramp: phases after the work is declared complete.
export const EXIT_RAMP = ['cleanup', 'final-verify', 'git-finish'];
