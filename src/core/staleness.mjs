// Silence of a loop: how long since its owner session last fired, and what that means.
// Pure: the clock, the state and the plan come in; text and booleans go out.
//
// A loop lives only in the Stop hook of ONE session. When that session dies (terminal
// closed, Esc mid-turn, client crash) the state keeps saying "phase: review" forever and
// nothing distinguishes "working" from "dead". The age of the last fire is the only signal
// there is, so every surface shows it: status, HUD, disarm recap, the SessionStart notice
// and the `gap` journal event.

import { stepCounts, stripCodeFences } from './plan.mjs';
import { renderPrompt } from './prompts.mjs';
import { formatAge, formatAt } from './time.mjs';

export { formatAge, formatAt };

// Two hours: a high-complexity step with subagents and a long suite can keep one turn open
// well past an hour, and a false STALE turns into a needless question to the user; the
// reported orphan stayed silent ten times longer.
export const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;
// Below this age the HUD shows no ⏱ at all: a live loop deserves a quiet statusline.
export const HUD_AGE_MIN_MS = 10 * 60 * 1000;

const short = (id) => String(id || '').slice(0, 8);
const limitOf = (staleMs) => (Number(staleMs) > 0 ? Number(staleMs) : DEFAULT_STALE_MS);

// -> { claimed, paused, lastFireAt, ageMs (null if never fired), stale }
// A paused loop is never stale: the silence is a human's choice (escalation, plan approval,
// unconfirmed git closure), and the right move is `resume`, not a takeover.
export function staleness(state, now = Date.now(), staleMs = DEFAULT_STALE_MS) {
  const owner = state?.owner || {};
  const last = Number(owner.lastFireAt) || 0;
  const claimed = !!owner.sessionId;
  const paused = state?.signals?.paused === true;
  const ageMs = last > 0 ? Math.max(0, now - last) : null;
  return { claimed, paused, lastFireAt: last, ageMs, stale: !paused && ageMs != null && ageMs > limitOf(staleMs) };
}

// A released loop (`resume --takeover`) can be claimed only for a while: past the window
// nobody claims it by accident and the notice calls it abandoned again.
export function releaseOpen(state, now = Date.now(), staleMs = DEFAULT_STALE_MS) {
  const o = state?.owner || {};
  if (o.sessionId || !o.releasedFrom) return false;
  const at = Number(o.releasedAt) || 0;
  return at > 0 && now - at <= limitOf(staleMs);
}

// The "last fire" line shared by status and the disarm recap.
export function describeLastFire(state, now = Date.now(), staleMs = DEFAULT_STALE_MS) {
  const st = staleness(state, now, staleMs);
  if (st.ageMs == null) return 'never';
  return `${formatAge(st.ageMs)} ago (${formatAt(st.lastFireAt)})${st.stale ? '  STALE' : st.paused ? '  (paused)' : ''}`;
}

// The open steps of the plan, first few, for a recap a human reads at a glance.
// Same fence rule as the gate: a checkbox inside a code block is an example, not a step.
export function openStepTitles(planText, max = 3) {
  const open = [];
  for (const l of stripCodeFences(planText).split('\n')) {
    const m = l.match(/^[ \t]*[-*+][ \t]*\[[ \t]*\][ \t]*(.*)$/);
    if (m) open.push(m[1].trim());
  }
  const shown = open.slice(0, max).map((t) => (t.length > 60 ? `${t.slice(0, 57).trimEnd()}...` : t));
  return { count: open.length, shown };
}

const armedAtMs = (state) => {
  const n = Date.parse(state?.armedAt || '');
  return Number.isFinite(n) ? n : 0;
};

// Which notice a session that does not own the loop gets:
//   released   the owner was released by `resume --takeover` and the window is still open
//   waiting    paused: a human is expected (escalation, plan approval), however long ago
//   fresh      never fired and armed recently: the arming session has not stopped yet
//   abandoned  the owner is silent beyond the threshold (or never fired and arm is old,
//              or released and the window closed)
//   live       the owner fired recently
export function noticeKind(state, now = Date.now(), staleMs = DEFAULT_STALE_MS) {
  const st = staleness(state, now, staleMs);
  if (releaseOpen(state, now, staleMs)) return 'released';
  if (!state.owner?.sessionId && state.owner?.releasedFrom) return 'abandoned';
  if (st.paused && st.claimed) return 'waiting';
  if (st.ageMs == null) {
    const armed = armedAtMs(state);
    return armed > 0 && now - armed <= limitOf(staleMs) ? 'fresh' : 'abandoned';
  }
  return st.stale ? 'abandoned' : 'live';
}

// Everything the notice templates interpolate, in the language of the pack (`layers`).
function noticeVars(state, { planText, now, staleMs, sessionId, LOOP, lastPrompt, layers }) {
  const P = (key, vars = {}) => renderPrompt(key, { ...vars, LOOP }, layers);
  const st = staleness(state, now, staleMs);
  const c = stepCounts(planText);
  const armed = armedAtMs(state);
  const when = st.ageMs != null
    ? P('hint-last-fire', { age: formatAge(st.ageMs), at: formatAt(st.lastFireAt) })
    : P('hint-armed-at', { age: formatAge(armed > 0 ? Math.max(0, now - armed) : 0), at: formatAt(armed) });
  return {
    P,
    owner: state.owner?.sessionId ? P('hint-owner-session', { id: short(state.owner.sessionId) }) : P('hint-owner-none'),
    from: short(state.owner?.releasedFrom),
    sessionId: short(sessionId),
    phase: `${state.phase}${state.signals?.paused ? P('hint-paused') : ''}`,
    when,
    steps: c.total ? P('hint-steps', { done: c.done, total: c.total }) : P('hint-no-plan'),
    lastInstr: lastPrompt ? P('hint-last-instruction', { lastPrompt }) : '',
    task: state.task,
  };
}

// What another session must know when it starts in a project whose loop it does not own.
//   sessionId: the session that just started; LOOP: the verb command; lastPrompt: the key of
//   the last injected instruction (from the journal), if known; layers: prompt pack layers.
export function sessionNotice(state, { planText = '', now = Date.now(), staleMs = DEFAULT_STALE_MS, sessionId = '', LOOP = 'node omc-loop.mjs', lastPrompt = '', layers = [] } = {}) {
  const v = noticeVars(state, { planText, now, staleMs, sessionId, LOOP, lastPrompt, layers });
  return v.P(`session-${noticeKind(state, now, staleMs)}`, v);
}

// The owner session came back after a compaction: the phase instruction may be gone.
export function compactNotice(state, { planText = '', LOOP = 'node omc-loop.mjs', layers = [] } = {}) {
  const v = noticeVars(state, { planText, now: Date.now(), staleMs: DEFAULT_STALE_MS, sessionId: '', LOOP, lastPrompt: '', layers });
  return v.P('session-compact', v);
}
