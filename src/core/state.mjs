// Loop state: schema v2, defaults, normalisation and migration from the v1 flat layout.
// Pure: no filesystem access. The shell reads/writes the JSON; this module says what it means.
//
// Ownership (the contract the v1 comments described, now visible in the shape):
//   phase, counters, flags, owner, usage  -> written only by the Stop hook
//   signals, lastTest                     -> written only by the verbs
//   options, limits                       -> written only by `arm` (and adaptive budget once)

export const SCHEMA_VERSION = 2;
export const PHASES = ['plan', 'implement', 'review', 'cleanup', 'final-verify', 'git-finish'];
export const COMPLEXITIES = ['low', 'medium', 'high'];
export const DEFAULT_MAX_ITERATIONS = 25;
export const DEFAULT_MAX_RETRIES = 3;

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
      lang: 'en',
    },
    counters: { iterations: 0, retries: 0, finalFails: 0 },
    limits: { maxIterations: DEFAULT_MAX_ITERATIONS, maxIterationsExplicit: false, maxRetries: DEFAULT_MAX_RETRIES, maxTokens: null },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, source: null },
    signals: { lastReport: 'none', claimedDone: false, paused: false },
    flags: { repeated: false, cleanedOnce: false, planPresented: false },
    lastTest: null,
    baselineDirty: [],
    owner: { sessionId: null, lastFireAt: 0 },
    armedAt: null,
    engineVersion: null,
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

// Fill defaults and coerce types on a v2 object. Never throws on odd input.
export function normalizeState(raw) {
  const s = defaultState(raw && typeof raw === 'object' ? raw : {});
  s.schemaVersion = SCHEMA_VERSION;
  s.task = String(s.task ?? '');
  if (!PHASES.includes(s.phase)) s.phase = 'plan';
  if (!COMPLEXITIES.includes(s.complexity)) s.complexity = 'medium';
  s.counters.iterations = Math.max(0, num(s.counters.iterations, 0));
  s.counters.retries = Math.max(0, num(s.counters.retries, 0));
  s.counters.finalFails = Math.max(0, num(s.counters.finalFails, 0));
  s.limits.maxIterations = num(s.limits.maxIterations, DEFAULT_MAX_ITERATIONS);
  if (s.limits.maxIterations < 1) s.limits.maxIterations = DEFAULT_MAX_ITERATIONS;
  s.limits.maxIterationsExplicit = bool(s.limits.maxIterationsExplicit, false);
  s.limits.maxRetries = num(s.limits.maxRetries, DEFAULT_MAX_RETRIES);
  if (s.limits.maxRetries < 1) s.limits.maxRetries = DEFAULT_MAX_RETRIES;
  s.limits.maxTokens = s.limits.maxTokens == null ? null : Math.max(0, num(s.limits.maxTokens, 0)) || null;
  for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens']) s.usage[k] = Math.max(0, num(s.usage[k], 0));
  s.signals.lastReport = ['pass', 'fail'].includes(s.signals.lastReport) ? s.signals.lastReport : 'none';
  s.signals.claimedDone = bool(s.signals.claimedDone, false);
  s.signals.paused = bool(s.signals.paused, false);
  s.flags.repeated = bool(s.flags.repeated, false);
  s.flags.cleanedOnce = bool(s.flags.cleanedOnce, false);
  s.flags.planPresented = bool(s.flags.planPresented, false);
  s.options.commitSteps = bool(s.options.commitSteps, false);
  s.options.gitFinish = bool(s.options.gitFinish, true);
  s.options.gitPush = bool(s.options.gitPush, true);
  s.options.approvePlan = bool(s.options.approvePlan, false);
  s.options.testCmd = s.options.testCmd ? String(s.options.testCmd) : null;
  s.options.externals = Array.isArray(s.options.externals) ? s.options.externals.map(String) : [];
  s.options.lang = typeof s.options.lang === 'string' && s.options.lang ? s.options.lang : 'en';
  s.baselineDirty = Array.isArray(s.baselineDirty) ? s.baselineDirty.map(String) : [];
  if (s.lastTest && typeof s.lastTest === 'object') {
    s.lastTest = {
      cmd: String(s.lastTest.cmd ?? ''),
      exitCode: num(s.lastTest.exitCode, 1),
      iteration: num(s.lastTest.iteration, -1),
      at: s.lastTest.at ?? null,
      fingerprint: s.lastTest.fingerprint ?? null,
    };
  } else s.lastTest = null;
  s.owner.sessionId = typeof s.owner.sessionId === 'string' && s.owner.sessionId ? s.owner.sessionId : null;
  s.owner.lastFireAt = Math.max(0, num(s.owner.lastFireAt, 0));
  return s;
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
