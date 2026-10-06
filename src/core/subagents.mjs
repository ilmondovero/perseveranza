// The loop's subagents seen from the mod (Claude Code's in-process hooks): which model a
// pf-* subagent runs on, and whether a judge about to stop left the verdict the loop asked
// for. Pure, and no `node:` import: the mod imports this module and has no Node API.
//
//   routeModel(state, subagentType)                          -> 'haiku'|'sonnet'|'opus'|null
//   subagentVerdictCheck(state, agentType, artifacts, opts)  -> { ok, reason, file }
//
// `artifacts` has the shape of the Stop hook's ctx.artifacts: { review, verify, verifyLenses:
// { <lens>: text } }, each a file's text or null when the file is not there.

import { MODEL_ROUTING, loopAgentName, runningLoopAgents, cleanRequestId, LATE_TOLERANCE_MS, lensFileName } from './machine.mjs';
import { parseReviewVerdict, parseVerifyVerdict } from './verdicts.mjs';
import { COMPLEXITIES, singleLens } from './state.mjs';

export { loopAgentName, runningLoopAgents };

// A judge is sent back to write its verdict at most this many times per request; then it is
// let go and the machine's own `missing` outcome is the net.
export const MAX_VERDICT_ASKS = 2;

const ROUTES = { 'pf-reviewer': 'review', 'pf-verifier': 'verify', 'pf-executor': 'execute' };

// The model of a loop subagent by the recorded complexity (medium when unknown); null for
// any other agent, the advisor included (its model is an option of the run, not a route).
export function routeModel(state, subagentType) {
  const route = ROUTES[loopAgentName(subagentType)];
  if (!route) return null;
  const c = state && COMPLEXITIES.includes(state.complexity) ? state.complexity : 'medium';
  return MODEL_ROUTING[route][c] || null;
}

// One verdict file against the current request, by the machine's rule: an id must be the
// current one; without an id the file must not predate the request (one second of tolerance).
// -> 'valid' | 'missing' | 'stale' | 'malformed: <error>'
function judgeFile(state, text, at, parse) {
  if (text == null) return 'missing';
  const v = parse(text);
  if (!v.ok) return `malformed: ${v.error}`;
  const id = cleanRequestId(v.requestId);
  if (state.verdictRequestId && id) return id === state.verdictRequestId ? 'valid' : 'stale';
  const t = Number(at) || 0;
  const requested = Number(state.verdictRequestedAt) || 0;
  return requested > 0 && t > 0 && t + LATE_TOLERANCE_MS < requested ? 'stale' : 'valid';
}

// opts: { askedTimes: how many times this judge was already sent back for this request,
//         artifactAt: the files' mtimes (same shape as artifacts), lens: the lens this
//         verifier was given, when the caller knows it }
// A judge stopping outside its phase, or with no request id to answer, is none of this
// check's business (ok). In a round by
// lenses without `lens`, a verifier cannot be told from its siblings: any valid file of the
// round lets it go (the machine still asks for the lenses that are missing).
export function subagentVerdictCheck(state, agentType, artifacts, opts = {}) {
  const name = loopAgentName(agentType);
  if (name !== 'pf-reviewer' && name !== 'pf-verifier') return { ok: true, reason: 'not-a-judge', file: null };
  const s = state && typeof state === 'object' ? state : {};
  const awaited = name === 'pf-reviewer' ? 'review' : 'final-verify';
  if (s.phase !== awaited) return { ok: true, reason: 'not-awaited', file: null };
  // no request id (a state from before the ids): nothing to bind a verdict to, so nothing to
  // send the judge back for (no prompt ever hands out an empty id)
  if (!s.verdictRequestId) return { ok: true, reason: 'no-request', file: null };
  const a = artifacts && typeof artifacts === 'object' ? artifacts : {};
  const at = opts.artifactAt && typeof opts.artifactAt === 'object' ? opts.artifactAt : {};
  const asked = Math.max(0, Number(opts.askedTimes) || 0);

  // [file, result] candidates in the order they answer the request
  let checks;
  if (name === 'pf-reviewer') checks = [['review.json', judgeFile(s, a.review, at.review, parseReviewVerdict)]];
  else {
    const raw = a.verifyLenses && typeof a.verifyLenses === 'object' ? a.verifyLenses : {};
    const rawAt = at.verifyLenses && typeof at.verifyLenses === 'object' ? at.verifyLenses : {};
    const lens = (l) => [lensFileName(l), judgeFile(s, raw[l], rawAt[l], parseVerifyVerdict)];
    const main = ['verify.json', judgeFile(s, a.verify, at.verify, parseVerifyVerdict)];
    const lenses = Array.isArray(s.verdictLenses) ? s.verdictLenses : [];
    if (singleLens(lenses)) checks = [main, lens('general')];
    else if (typeof opts.lens === 'string' && lenses.includes(opts.lens)) {
      const own = lens(opts.lens);
      // verify.json covers a lens that wrote no file at all (the machine's rule)
      checks = own[1] === 'missing' ? [own, main] : [own];
    } else checks = [...lenses.map(lens), main];
  }
  const good = checks.find(([, r]) => r === 'valid');
  if (good) return { ok: true, reason: 'valid', file: good[0] };
  // the most telling problem: a file that is there but wrong, before a file that is not there
  const bad = checks.find(([, r]) => r !== 'missing') || checks[0];
  if (asked >= MAX_VERDICT_ASKS) return { ok: true, reason: `asked-enough: ${bad[1]}`, file: bad[0] };
  return { ok: false, reason: bad[1], file: bad[0] };
}
