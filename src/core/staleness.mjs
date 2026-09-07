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

// Thirty minutes. With three signs of life (the Stop, the tool activity of the turn, the
// transcript written at every message) the longest silence of a live turn is one tool call:
// a Bash caps at ten minutes, the test verb beats while the suite runs, an API retry takes
// minutes. Thirty is three times the worst case; the reported orphan stayed silent forty
// times longer. A false positive costs a restored turn, a true positive a whole night.
export const DEFAULT_STALE_MS = 30 * 60 * 1000;
// Below this age the HUD shows no ⏱ at all: a live loop deserves a quiet statusline.
export const HUD_AGE_MIN_MS = 10 * 60 * 1000;

const short = (id) => String(id || '').slice(0, 8);
const limitOf = (staleMs) => (Number(staleMs) > 0 ? Number(staleMs) : DEFAULT_STALE_MS);

// The activity record (.omc-loop/activity.json, written by the activity hook inside a turn):
//   { at, session, event: 'tool'|'delegate'|'subagent-stop', tool, agent, pending: [{at, agent}] }
// `pending` are the subagents launched and not yet back, oldest first: the forensic detail
// that tells "delegated the review at 11:10 and never returned" from "the session died".
export function normalizeActivity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at = Number(raw.at) || 0;
  if (at <= 0) return null;
  const list = Array.isArray(raw.pending) ? raw.pending : raw.delegate ? [raw.delegate] : [];
  const pending = list
    .filter((d) => d && typeof d === 'object' && Number(d.at) > 0)
    .map((d) => ({ at: Number(d.at), agent: String(d.agent || '').slice(0, 120) }))
    .sort((a, b) => a.at - b.at);
  return { at, session: String(raw.session || ''), event: String(raw.event || 'tool'), tool: String(raw.tool || ''), agent: String(raw.agent || '').slice(0, 120), pending, transcript: typeof raw.transcript === 'string' ? raw.transcript : '' };
}

// The last moment the loop showed life: the owner's last Stop, the last tool activity of
// the owner's turn (an activity of another session is not the loop's), or the last write
// to the session transcript (every message, so the model generating counts as life).
//   -> { at, via: 'fire'|'activity'|'transcript' }
export function lastSeen(state, activity = null, transcriptAt = 0) {
  const fire = Number(state?.owner?.lastFireAt) || 0;
  let best = { at: fire, via: 'fire' };
  const a = normalizeActivity(activity);
  const owner = state?.owner?.sessionId;
  if (a && !(owner && a.session && a.session !== owner) && a.at > best.at) best = { at: a.at, via: 'activity' };
  const t = Number(transcriptAt) || 0;
  if (t > best.at) best = { at: t, via: 'transcript' };
  return best;
}

// -> { claimed, paused, lastFireAt, seenAt, via, ageMs (null if never seen), stale }
// A paused loop is never stale: the silence is a human's choice (escalation, plan approval,
// unconfirmed git closure), and the right move is `resume`, not a takeover.
export function staleness(state, now = Date.now(), staleMs = DEFAULT_STALE_MS, activity = null, transcriptAt = 0) {
  const owner = state?.owner || {};
  const last = Number(owner.lastFireAt) || 0;
  const seen = lastSeen(state, activity, transcriptAt);
  const claimed = !!owner.sessionId;
  const paused = state?.signals?.paused === true;
  const ageMs = seen.at > 0 ? Math.max(0, now - seen.at) : null;
  return { claimed, paused, lastFireAt: last, seenAt: seen.at, via: seen.via, ageMs, stale: !paused && ageMs != null && ageMs > limitOf(staleMs) };
}

// Plain-English description of the activity record, for the CLI (status, disarm recap,
// the watchdog notification).
export function describeActivity(activity, now = Date.now()) {
  const a = normalizeActivity(activity);
  if (!a) return '';
  const what = a.event === 'delegate' ? `delegated to ${a.agent || 'a subagent'}`
    : a.event === 'subagent-stop' ? `subagent ${a.agent || 'done'} finished`
      : `tool ${a.tool || '?'}`;
  let s = `${formatAge(Math.max(0, now - a.at))} ago (${formatAt(a.at)}, ${what})`;
  const others = a.pending.filter((d) => !(a.event === 'delegate' && d.agent === a.agent && d.at === a.at));
  if (a.event === 'delegate' && others.length < a.pending.length) s += ', not back yet';
  if (others.length) s += `; ${others.slice(0, 3).map((d) => `${d.agent || 'a subagent'} delegated ${formatAge(Math.max(0, now - d.at))} ago`).join(', ')}${others.length > 3 ? `, +${others.length - 3}` : ''}, not back yet`;
  return s;
}

// A released loop (`resume --takeover`) can be claimed only for a while: past the window
// nobody claims it by accident and the notice calls it abandoned again.
export function releaseOpen(state, now = Date.now(), staleMs = DEFAULT_STALE_MS) {
  const o = state?.owner || {};
  if (o.sessionId || !o.releasedFrom) return false;
  const at = Number(o.releasedAt) || 0;
  return at > 0 && now - at <= limitOf(staleMs);
}

// The "last fire" line shared by status and the disarm recap. The STALE flag counts the
// activity too: a fire from last night with a tool call ten minutes ago is a live loop.
export function describeLastFire(state, now = Date.now(), staleMs = DEFAULT_STALE_MS, activity = null, transcriptAt = 0) {
  const st = staleness(state, now, staleMs, activity, transcriptAt);
  if (!st.lastFireAt) return st.ageMs == null ? 'never' : `never${st.stale ? '  STALE' : ''}`;
  const fireAge = formatAge(Math.max(0, now - st.lastFireAt));
  return `${fireAge} ago (${formatAt(st.lastFireAt)})${st.stale ? '  STALE' : st.paused ? '  (paused)' : ''}`;
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
export function noticeKind(state, now = Date.now(), staleMs = DEFAULT_STALE_MS, activity = null, transcriptAt = 0) {
  const st = staleness(state, now, staleMs, activity, transcriptAt);
  if (releaseOpen(state, now, staleMs)) return 'released';
  if (!state.owner?.sessionId && state.owner?.releasedFrom) return 'abandoned';
  if (st.paused && st.claimed) return 'waiting';
  if (!st.lastFireAt) {
    // never fired: fresh while the arming turn shows life (its tools, or the arm itself)
    const armed = armedAtMs(state);
    const ref = st.ageMs != null ? st.ageMs : armed > 0 ? now - armed : Infinity;
    return ref <= limitOf(staleMs) ? 'fresh' : 'abandoned';
  }
  return st.stale ? 'abandoned' : 'live';
}

// Everything the notice templates interpolate, in the language of the pack (`layers`).
function activityWhat(a, now, P) {
  const what = a.event === 'delegate' ? P('hint-act-delegate', { agent: a.agent || 'subagent' })
    : a.event === 'subagent-stop' ? P('hint-act-subagent-stop', { agent: a.agent || 'subagent' })
      : P('hint-act-tool', { tool: a.tool || '?' });
  const others = a.pending.filter((d) => !(a.event === 'delegate' && d.agent === a.agent && d.at === a.at));
  const pending = others.slice(0, 3).map((d) => P('hint-act-pending', { agent: d.agent || 'subagent', age: formatAge(Math.max(0, now - d.at)) })).join('');
  return `${what}${pending}`;
}

function noticeVars(state, { planText, now, staleMs, sessionId, LOOP, lastPrompt, layers, activity, transcriptAt = 0 }) {
  const P = (key, vars = {}) => renderPrompt(key, { ...vars, LOOP }, layers);
  const st = staleness(state, now, staleMs, activity, transcriptAt);
  const c = stepCounts(planText);
  const armed = armedAtMs(state);
  const a = normalizeActivity(activity);
  const when = st.ageMs == null
    ? P('hint-armed-at', { age: formatAge(armed > 0 ? Math.max(0, now - armed) : 0), at: formatAt(armed) })
    : st.via === 'activity' && a
      ? P('hint-last-activity', { age: formatAge(st.ageMs), at: formatAt(st.seenAt), what: activityWhat(a, now, P) })
      : st.via === 'transcript'
        ? P('hint-last-transcript', { age: formatAge(st.ageMs), at: formatAt(st.seenAt) })
        : P('hint-last-fire', { age: formatAge(st.ageMs), at: formatAt(st.lastFireAt) });
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
export function sessionNotice(state, { planText = '', now = Date.now(), staleMs = DEFAULT_STALE_MS, sessionId = '', LOOP = 'node omc-loop.mjs', lastPrompt = '', layers = [], activity = null, transcriptAt = 0 } = {}) {
  const v = noticeVars(state, { planText, now, staleMs, sessionId, LOOP, lastPrompt, layers, activity, transcriptAt });
  return v.P(`session-${noticeKind(state, now, staleMs, activity, transcriptAt)}`, v);
}

// The prompt a restored session receives after the watchdog killed a silent turn.
export function restorePrompt(state, { silentMs = 0, LOOP = 'node omc-loop.mjs', layers = [], activity = null, now = Date.now() } = {}) {
  const P = (key, vars = {}) => renderPrompt(key, { ...vars, LOOP }, layers);
  const a = normalizeActivity(activity);
  const what = a && a.pending.length ? P('hint-restore-pending', { agents: a.pending.map((d) => d.agent || 'subagent').join(', ') }) : '';
  return P('session-restore', { silence: formatAge(silentMs), phase: state.phase, what, task: state.task });
}

// The owner session came back after a compaction: the phase instruction may be gone.
export function compactNotice(state, { planText = '', LOOP = 'node omc-loop.mjs', layers = [] } = {}) {
  const v = noticeVars(state, { planText, now: Date.now(), staleMs: DEFAULT_STALE_MS, sessionId: '', LOOP, lastPrompt: '', layers, activity: null });
  return v.P('session-compact', v);
}
