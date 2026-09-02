// Compact progress rendering shared by the injected header (plain text) and the
// statusline (ANSI colours + marker). Pure, dependency-free.

import { stepCounts } from '../core/plan.mjs';
import { tokensSpent, iterationCap } from '../core/budget.mjs';

const PHASE_LABEL = {
  plan: 'plan', implement: 'impl', review: 'rev',
  cleanup: 'clean', 'final-verify': 'verify', 'git-finish': 'git',
};
const PHASE_COLOR = {
  plan: 36, implement: 36, review: 33, cleanup: 36, 'final-verify': 34, 'git-finish': 35,
};

function bar(done, total, w = 5) {
  const f = Math.max(0, Math.min(w, Math.round((done / total) * w)));
  return '▰'.repeat(f) + '▱'.repeat(w - f);
}

export function formatTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1e6) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)}k`;
  return `${(v / 1e6).toFixed(2)}M`;
}

// state: a v2 state; planText: content of plan.md (or ''); opts: { color, marker, version }
export function renderProgress(state, planText = '', opts = {}) {
  const paint = opts.color ? (code, s) => `\x1b[${code}m${s}\x1b[0m` : (_c, s) => s;
  const phase = state.phase || 'plan';
  const label = PHASE_LABEL[phase] || phase;
  const parts = [];
  if (state.signals?.paused) {
    const why = phase === 'git-finish' ? 'git: closure not confirmed' : `PAUSED ${label}`;
    parts.push(paint('38;5;208', `⏸ ${why}`));
  } else {
    parts.push(paint(PHASE_COLOR[phase] || 36, `▸${label}`));
    const c = stepCounts(planText);
    if (c.total) parts.push(`${bar(c.done, c.total)} ${c.done}/${c.total}`);
  }
  const it = Number(state.counters?.iterations) || 0;
  parts.push(`it${it}/${iterationCap(state)}`);
  const spent = tokensSpent(state.usage);
  if (spent > 0) {
    const cap = state.limits?.maxTokens;
    parts.push(`${formatTokens(spent)}${cap ? `/${formatTokens(cap)}` : ''} tok`);
  }
  const retries = Number(state.counters?.retries) || 0;
  const finalFails = Number(state.counters?.finalFails) || 0;
  const maxRetries = Number(state.limits?.maxRetries) || 3;
  if (retries > 0) parts.push(paint(33, `↻${retries}/${maxRetries}`));
  if (finalFails > 0) parts.push(paint(31, `✗${finalFails}/${maxRetries}`));
  const body = parts.join(' · ');
  const marker = opts.version ? `⟳ PRS v${opts.version}` : '⟳ PRS';
  return opts.marker ? `${paint('1;35', marker)} ${body}` : body;
}
