import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canContinue, adaptiveMax, iterationCap, tokensSpent, EXIT_RAMP_GRACE } from '../../src/core/budget.mjs';
import { mk } from '../helpers/core.mjs';

test('adaptiveMax: 8 + 3 per step, capped at 60', () => {
  assert.equal(adaptiveMax(0), 8);
  assert.equal(adaptiveMax(1), 11);
  assert.equal(adaptiveMax(5), 23);
  assert.equal(adaptiveMax(100), 60);
  assert.equal(adaptiveMax('x'), 8);
});

test('iteration cap: grace only on the exit ramp', () => {
  assert.equal(iterationCap(mk({ phase: 'implement', limits: { maxIterations: 10 } })), 10);
  assert.equal(iterationCap(mk({ phase: 'cleanup', limits: { maxIterations: 10 } })), 10 + EXIT_RAMP_GRACE);
  assert.equal(iterationCap(mk({ phase: 'final-verify', limits: { maxIterations: 10 } })), 10 + EXIT_RAMP_GRACE);
  assert.equal(iterationCap(mk({ phase: 'git-finish', limits: { maxIterations: 10 } })), 10 + EXIT_RAMP_GRACE);
});

test('iteration cap: a pending claim-done gets the exit ramp grace, once', () => {
  // a real run (--max 6): claim-done at iteration 6, archived 6/6 before the claim was read
  const claimed = mk({ phase: 'implement', counters: { iterations: 6 }, limits: { maxIterations: 6 }, signals: { claimedDone: true } });
  assert.equal(iterationCap(claimed), 6 + EXIT_RAMP_GRACE);
  assert.equal(canContinue(claimed).ok, true);
  // without the claim: the plain cap
  assert.equal(canContinue(mk({ phase: 'implement', counters: { iterations: 6 }, limits: { maxIterations: 6 } })).ok, false);
  // claimed on the ramp: no double grace
  assert.equal(iterationCap(mk({ phase: 'final-verify', limits: { maxIterations: 6 }, signals: { claimedDone: true } })), 6 + EXIT_RAMP_GRACE);
  // the grace is a ceiling: a claim at max + grace is not let through
  assert.equal(canContinue(mk({ phase: 'implement', counters: { iterations: 9 }, limits: { maxIterations: 6 }, signals: { claimedDone: true } })).ok, false);
  // only a real true counts
  assert.equal(iterationCap(mk({ phase: 'implement', limits: { maxIterations: 6 }, signals: { claimedDone: 'yes' } })), 6);
});

test('canContinue: iterations', () => {
  assert.equal(canContinue(mk({ counters: { iterations: 9 }, limits: { maxIterations: 10 } })).ok, true);
  const r = canContinue(mk({ counters: { iterations: 10 }, limits: { maxIterations: 10 } }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'iterations');
});

test('canContinue: tokens only when a cap is set', () => {
  assert.equal(canContinue(mk({ usage: { inputTokens: 1e9 } })).ok, true);
  const r = canContinue(mk({ usage: { inputTokens: 600, outputTokens: 500 }, limits: { maxTokens: 1000 } }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'tokens');
  assert.equal(canContinue(mk({ usage: { inputTokens: 100 }, limits: { maxTokens: 1000 } })).ok, true);
});

test('tokensSpent sums input and output only', () => {
  assert.equal(tokensSpent({ inputTokens: 2, outputTokens: 3, cacheReadTokens: 100 }), 5);
  assert.equal(tokensSpent(null), 0);
});
