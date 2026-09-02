import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultState, normalizeState, loadState, isV1State, migrateV1, SCHEMA_VERSION, PHASES } from '../../src/core/state.mjs';

test('defaultState has schema v2 and sane defaults', () => {
  const s = defaultState();
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
  assert.equal(s.phase, 'plan');
  assert.equal(s.limits.maxIterations, 25);
  assert.equal(s.limits.maxRetries, 3);
  assert.equal(s.limits.maxTokens, null);
  assert.equal(s.options.lang, 'en');
});

test('defaultState deep-merges overrides without losing siblings', () => {
  const s = defaultState({ limits: { maxIterations: 7 }, options: { commitSteps: true } });
  assert.equal(s.limits.maxIterations, 7);
  assert.equal(s.limits.maxRetries, 3);
  assert.equal(s.options.commitSteps, true);
  assert.equal(s.options.gitFinish, true);
});

test('normalizeState coerces bad numbers and unknown enums', () => {
  const s = normalizeState({ phase: 'weird', complexity: 'huge', counters: { iterations: 'x' }, limits: { maxIterations: 0, maxRetries: -2 } });
  assert.equal(s.phase, 'plan');
  assert.equal(s.complexity, 'medium');
  assert.equal(s.counters.iterations, 0);
  assert.equal(s.limits.maxIterations, 25);
  assert.equal(s.limits.maxRetries, 3);
});

test('isV1State detects the flat v1 layout', () => {
  assert.equal(isV1State({ phase: 'review', iterations: 3 }), true);
  assert.equal(isV1State({ schemaVersion: 2, phase: 'review' }), false);
  assert.equal(isV1State(null), false);
});

test('migrateV1 maps every v1 field onto the v2 shape', () => {
  const v1 = {
    task: 'old task', phase: 'review', complexity: 'high', commitSteps: true, externals: ['codex'],
    cleanedOnce: true, testCmd: 'npm test', lastTest: { cmd: 'npm test', exitCode: 0, iteration: 4, at: 'x' },
    gitFinish: false, gitPush: false, approvePlan: true, planPresented: true, baselineDirty: ['a.js'],
    iterations: 5, max: 30, retries: 1, maxRetries: 4, finalFails: 2, lastReport: 'fail', claimedDone: true,
    paused: false, repeated: true, sessionId: 'abc', lastFireAt: 123,
  };
  const s = migrateV1(v1);
  assert.equal(s.schemaVersion, 2);
  assert.equal(s.task, 'old task');
  assert.equal(s.phase, 'review');
  assert.equal(s.complexity, 'high');
  assert.equal(s.options.commitSteps, true);
  assert.deepEqual(s.options.externals, ['codex']);
  assert.equal(s.options.testCmd, 'npm test');
  assert.equal(s.options.gitFinish, false);
  assert.equal(s.options.gitPush, false);
  assert.equal(s.options.approvePlan, true);
  assert.equal(s.flags.cleanedOnce, true);
  assert.equal(s.flags.planPresented, true);
  assert.equal(s.flags.repeated, true);
  assert.equal(s.counters.iterations, 5);
  assert.equal(s.limits.maxIterations, 30);
  assert.equal(s.limits.maxIterationsExplicit, true);
  assert.equal(s.counters.retries, 1);
  assert.equal(s.limits.maxRetries, 4);
  assert.equal(s.counters.finalFails, 2);
  assert.equal(s.signals.lastReport, 'fail');
  assert.equal(s.signals.claimedDone, true);
  assert.equal(s.lastTest.iteration, 4);
  assert.equal(s.lastTest.fingerprint, null);
  assert.deepEqual(s.baselineDirty, ['a.js']);
  assert.equal(s.owner.sessionId, 'abc');
  assert.equal(s.owner.lastFireAt, 123);
});

test('loadState: v1 -> migrated, v2 -> normalised, garbage -> error', () => {
  assert.equal(loadState({ phase: 'plan', iterations: 0 }).migrated, true);
  assert.equal(loadState({ schemaVersion: 2, phase: 'plan' }).migrated, false);
  assert.equal(loadState(null).state, null);
  assert.equal(loadState({ foo: 1 }).state, null);
  assert.equal(loadState([1]).state, null);
});

test('PHASES lists the six phases', () => {
  assert.deepEqual(PHASES, ['plan', 'implement', 'review', 'cleanup', 'final-verify', 'git-finish']);
});
