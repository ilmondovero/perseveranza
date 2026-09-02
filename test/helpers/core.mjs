// Helpers for the pure-core unit tests: build states, contexts and drive step().
import { defaultState } from '../../src/core/state.mjs';
import { step } from '../../src/core/machine.mjs';

export const LOOP = 'node "omc-loop.mjs"';

export function mk(overrides = {}) {
  return defaultState({ task: 'test task', armedAt: '2026-01-01T00:00:00.000Z', ...overrides });
}

export function ctx(over = {}) {
  return {
    LOOP,
    projectName: 'proj',
    planText: '',
    planExists: false,
    artifacts: {},
    overrides: [],
    fingerprint: null,
    usage: null,
    version: '2.0.0',
    ...over,
  };
}

export function ev(over = {}) {
  return { sessionId: 'sess-1', now: 1_700_000_000_000, payloadKeys: ['session_id', 'cwd'], ...over };
}

export function run(state, c = {}, e = {}) {
  const r = step(state, ev(e), ctx(c));
  const types = r.effects.map((x) => x.type);
  const block = r.effects.find((x) => x.type === 'block');
  return { ...r, types, reason: block ? block.reason : '', blocked: !!block };
}

export const journal = (r) => r.effects.filter((x) => x.type === 'journal').map((x) => x.entry);
