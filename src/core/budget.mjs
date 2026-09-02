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

export function iterationCap(state) {
  const grace = EXIT_RAMP.includes(state.phase) ? EXIT_RAMP_GRACE : 0;
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
