// Budget: the one place that decides whether the loop may take another iteration.
// Counts iterations (always) and tokens (when a cap is set and usage is measurable).
// The exit ramp (cleanup / final-verify / git-finish) gets a small grace so a loop that
// has finished the work is not killed one step short of its verification.

import { EXIT_RAMP } from './state.mjs';

export const EXIT_RAMP_GRACE = 3;
export const ADAPTIVE_MAX_CAP = 60;

// Adaptive iteration budget once the plan is known: 8 fixed fires (plan, cleanup,
// verification, closure, slack) plus 3 per step (implement, review, one fix).
export function adaptiveMax(steps) {
  const n = Math.max(0, Number(steps) || 0);
  return Math.min(ADAPTIVE_MAX_CAP, 8 + 3 * n);
}

export function tokensSpent(usage) {
  if (!usage) return 0;
  return (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0);
}

// The grace also covers the stop that carries a claim-done (signals.claimedDone, not yet read):
// the budget is checked before the claim, so a loop that declared the work done at the cap was
// archived one stop short of its cleanup (a real run, --max 6: claimed at 6, stopped 6/6). The
// claim is still judged by the machine; a refused one leaves the loop in implement, over the
// plain cap at the next stop. The grace never adds up: cap = max + EXIT_RAMP_GRACE at most.
export function iterationCap(state) {
  const claimed = !!(state.signals && state.signals.claimedDone === true);
  const grace = EXIT_RAMP.includes(state.phase) || claimed ? EXIT_RAMP_GRACE : 0;
  return state.limits.maxIterations + grace;
}

// -> { ok: true } | { ok: false, reason: 'iterations' | 'tokens', detail }
export function canContinue(state) {
  const cap = iterationCap(state);
  if (state.counters.iterations >= cap) {
    return { ok: false, reason: 'iterations', detail: `${state.counters.iterations}/${cap} iterations` };
  }
  const maxTokens = state.limits.maxTokens;
  if (maxTokens && tokensSpent(state.usage) >= maxTokens) {
    return { ok: false, reason: 'tokens', detail: `${tokensSpent(state.usage)}/${maxTokens} tokens` };
  }
  return { ok: true };
}
