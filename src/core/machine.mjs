// The loop as a pure state machine.
//
//   step(state, event, ctx)          -> { state, effects, outcome }
//   finishProject(state, gitResult)  -> { state, effects, outcome }   (after the gitFinish effect ran)
//
// No filesystem, no processes, no clock: everything observable comes in through `event`
// and `ctx`; everything to be done goes out as EFFECTS the shell executes in order:
//
//   { type: 'journal', entry }               append to the run journal
//   { type: 'saveState' }                    persist the returned state
//   { type: 'dropArtifact', name }           delete .omc-loop/<name> (a stale verdict, never read)
//   { type: 'keepArtifact', name, as }        rename .omc-loop/<name> to <as> (a verdict consumed on
//                                            read stays readable by the fix phase and the archive)
//   { type: 'notify', title, message }       desktop notification (best-effort)
//   { type: 'writeEscalation', why }         hand-off document for a human
//   { type: 'gitFinish', retry }             commit+push (shell then calls finishProject)
//   { type: 'archiveRun', outcome }          move .omc-loop/ into the runs archive
//   { type: 'disarm' }                       remove .omc-loop/
//   { type: 'allowStop' }                    let Claude stop (no output)
//   { type: 'block', reason }                block the stop and inject the instruction
//
// Pre-state checks (kill switch, corrupt state) live in the shell: they need no state.

import { countOpenSteps, stepCounts } from './plan.mjs';
import { parseReviewVerdict, parseVerifyVerdict, parseReconcile } from './verdicts.mjs';
import { lookup } from './transitions.mjs';
import { canContinue, adaptiveMax, tokensSpent } from './budget.mjs';
import { renderPrompt } from './prompts.mjs';
import { PHASES, COMPLEXITIES } from './state.mjs';
import { DEFAULT_STALE_MS, releaseOpen } from './staleness.mjs';
import { renderProgress } from '../hud/render.mjs';

export const MODEL_ROUTING = {
  review: { low: 'haiku', medium: 'sonnet', high: 'opus' },
  verify: { low: 'sonnet', medium: 'opus', high: 'opus' },
};
export const NOTIFY_TITLE = 'Claude Code - perseveranza';

const clone = (o) => JSON.parse(JSON.stringify(o));
const short = (id) => String(id || '').slice(0, 8);
// a hand-edited clock in state.json must not crash the hook on a journal line
const iso = (ms) => { const d = new Date(ms); return Number.isFinite(d.getTime()) ? d.toISOString() : null; };

// Every prompt that asks for a verdict issues a new request, also when the phase does not
// change (claim-again from final-verify, a reconciliation back to review): from then on the
// verdict of an earlier request carries another id, and one without an id counts only if
// written after this instant. The code of the moment is what a final pass judged.
const REQUEST_PROMPTS = new Set(['review-delegate', 'final-verify']);
function issueRequest(s, now, phase, ctx) {
  s.verdictRequestedAt = now;
  s.verdictRequestId = `${now}-${s.counters.iterations + 1}-${phase}`;
  s.verdictTree = ctx.codeFingerprint ?? null;
}

// The id as an agent may have copied it out of a prose prompt: quotes or a trailing period.
const cleanRequestId = (id) => (typeof id === 'string' ? id.trim().replace(/^["'`]+/, '').replace(/["'`.,;:]+$/, '') : null) || null;

function agentRef(name, fallback) {
  return `the ${name} agent (subagent_type "${name}"; when installed as a plugin it is "perseveranza:${name}"; if neither exists, ${fallback})`;
}

// Everything the templates may interpolate, derived from state + ctx.
function buildVars(s, ctx) {
  const LOOP = ctx.LOOP || 'node omc-loop.mjs';
  const P = (key, vars = {}) => renderPrompt(key, { ...vars, LOOP }, ctx.overrides || []);
  const externals = s.options.externals;
  const extList = externals.join(', ');
  const askHint = (slot) => P('hint-ask', { slot, extList });
  const extFraming = P('hint-ext-framing');
  const high = s.complexity === 'high';
  const implHint = high ? P('hint-impl-high', { executorRef: agentRef('pf-executor', 'a generic executor subagent') }) : '';
  const testRun = `${LOOP} test --if-needed -- ${s.options.testCmd || '<test command>'}`;
  // What the recorded suite run proves about the CURRENT tree: the hint every phase gets so
  // that neither Claude nor its subagents rerun a suite whose green is already on record.
  const proof = testProof(s, ctx);
  const testHint = !s.options.testCmd && !s.lastTest ? ''
    : proof.green
      ? P('hint-test-green', { testIteration: s.lastTest.iteration, docsOnlyNote: proof.docsOnly ? P('hint-test-docs-only') : '', testRun })
      : P('hint-test-none', { testRun });
  const verdictHint = ctx.verdictFile ? P('hint-verdict-file', { verdictFile: ctx.verdictFile }) : '';
  return {
    LOOP,
    P,
    implHint,
    testHint,
    verdictHint,
    extPlanHint: externals.length ? P('hint-ext-plan', { askHint: askHint('plan') }) : '',
    extFixHint: externals.length ? P('hint-ext-fix', { askHint: askHint('fix'), extFraming }) : '',
    extVerifyHint: externals.length ? P('hint-ext-verify', { askHint: askHint('verify'), extFraming }) : '',
    secHint: high ? P('hint-security') : '',
    commitHint: s.options.commitSteps ? P('hint-commit') : '',
    reviewerRef: agentRef('pf-reviewer', 'a generic code-reviewer subagent'),
    verifierRef: agentRef('pf-verifier', 'an independent adversarial subagent'),
    reviewModel: MODEL_ROUTING.review[s.complexity],
    verifyModel: MODEL_ROUTING.verify[s.complexity],
    testRun,
    retries: s.counters.retries,
    maxRetries: s.limits.maxRetries,
    finalFails: s.counters.finalFails,
  };
}

// Does the last recorded run prove the current tree green?
//   green: exit 0 AND (same fingerprint, or same code with only documentation changed since)
export function testProof(s, ctx) {
  const t = s.lastTest;
  if (!t || Number(t.exitCode) !== 0) return { green: false };
  const full = !!t.fingerprint && ctx.fingerprint != null && t.fingerprint === ctx.fingerprint;
  if (full) return { green: true, docsOnly: false };
  const code = !!t.codeFingerprint && ctx.codeFingerprint != null && t.codeFingerprint === ctx.codeFingerprint;
  if (code) return { green: true, docsOnly: true };
  return { green: false };
}

function header(s, ctx, planText) {
  const next = clone(s);
  next.counters.iterations += 1; // the iteration about to start
  const ver = ctx.version ? ` v${ctx.version}` : '';
  const upd = ctx.updateAvailable ? ` · ⬆ v${ctx.updateAvailable} (/plugin)` : '';
  return `[perseveranza${ver} · ${renderProgress(next, planText)}${upd}] Task: ${s.task}.`;
}

export function step(input, event = {}, ctx0 = {}) {
  let ctx = ctx0;
  const s = clone(input);
  const effects = [];
  const J = (entry) => effects.push({ type: 'journal', entry });
  const now = Number.isFinite(event.now) ? event.now : Date.now();
  const planText = String(ctx.planText ?? '');
  const planExists = ctx.planExists === true;
  const proj = ctx.projectName || 'project';
  const phase = s.phase;
  const done = (outcome, extra = []) => ({ state: s, effects: [...effects, ...extra], outcome });

  J({ type: 'fire', session: short(event.sessionId), payloadKeys: Array.isArray(event.payloadKeys) ? event.payloadKeys : [], stopHookActive: event.stopHookActive === true });

  // --- per-session scoping: the loop belongs to ONE session (claim on first fire) ---
  // Another session NEVER takes the loop over on its own, however long the owner has been
  // silent: a session opened to do something else would otherwise find itself driving a
  // half-done step. The hand-over is explicit (`resume --takeover` releases the owner) and
  // the SessionStart hook is what tells a new session that an abandoned loop exists.
  const staleMs = Number(ctx.staleMs) > 0 ? Number(ctx.staleMs) : DEFAULT_STALE_MS;
  if (event.sessionId) {
    const owner = s.owner.sessionId;
    if (owner && owner !== event.sessionId) {
      // another session drives this loop: let this one stop, touch nothing
      return { state: input, effects: [{ type: 'allowStop' }], outcome: 'foreign-session' };
    }
    // released, but the window closed: nobody claims it by accident (resume --takeover again)
    if (!owner && s.owner.releasedFrom && !releaseOpen(s, now, staleMs)) {
      return { state: input, effects: [{ type: 'allowStop' }], outcome: 'foreign-session' };
    }
    if (!owner) J({ type: 'session', event: s.owner.releasedFrom ? 'takeover' : 'claimed', from: short(s.owner.releasedFrom), to: short(event.sessionId) });
    s.owner.sessionId = event.sessionId;
    s.owner.releasedFrom = null;
    s.owner.releasedAt = 0;
    // what the shell knows about the driving session: its transcript (a sign of life) and
    // its Claude Code process (what the watchdog restores)
    if (typeof event.transcriptPath === 'string' && event.transcriptPath) s.owner.transcriptPath = event.transcriptPath;
    if (event.claude && Number(event.claude.pid) > 0) {
      s.owner.claudePid = Number(event.claude.pid);
      s.owner.claudeStartedAt = typeof event.claude.startedAt === 'string' ? event.claude.startedAt : null;
    }
  }
  // --- the silence before this fire: recorded so the run's history shows the hole ---
  // Only a fire that carries a session id moves the owner's clock: it is the one signal
  // the staleness of the loop is read from.
  if (event.sessionId || !s.owner.sessionId) {
    // ctx.activityAt: the last sign of life inside the turn (tool activity, transcript); a
    // long turn that kept working is not a hole in the run
    const seen = Math.max(s.owner.lastFireAt, Number(ctx.activityAt) || 0);
    if (s.owner.lastFireAt > 0 && now - seen > staleMs) {
      // paused: the silence was a human's choice (escalation, plan approval), not a dead
      // session. Still paused now, or resumed by the verb since the last fire: both count.
      const paused = s.signals.paused === true || s.signals.resumedAt > s.owner.lastFireAt;
      J({ type: 'gap', since: iso(seen), ms: now - seen, paused });
    }
    s.owner.lastFireAt = now;
    s.signals.resumedAt = 0;
  }

  // --- token usage from the transcript (best-effort, measured by the shell) ---
  if (ctx.usage && typeof ctx.usage === 'object') {
    const before = tokensSpent(s.usage);
    s.usage = { ...s.usage, ...ctx.usage, source: ctx.usage.source || 'transcript' };
    J({ type: 'usage', spent: tokensSpent(s.usage), delta: tokensSpent(s.usage) - before });
  }

  // --- the tree as the hook sees it now, against the one at the previous stop ---
  const treeBefore = s.tree && typeof s.tree === 'object' ? s.tree : { fingerprint: null, iteration: 0 };
  s.tree = { fingerprint: ctx.fingerprint ?? null, iteration: s.counters.iterations };
  const unchangedTree = ctx.fingerprint != null && treeBefore.fingerprint === ctx.fingerprint;

  // --- paused: a human is in the loop (or the loop gave up) ---
  if (s.signals.paused) return done('paused', [{ type: 'saveState' }, { type: 'allowStop' }]);

  // --- budget ---
  const budget = canContinue(s);
  if (!budget.ok) {
    J({ type: 'budget', reason: budget.reason, detail: budget.detail });
    return done('budget', [
      { type: 'saveState' },
      { type: 'archiveRun', outcome: `budget-${budget.reason}` },
      { type: 'disarm' },
      { type: 'notify', title: NOTIFY_TITLE, message: `Loop stopped: ${budget.reason} budget exhausted (${budget.detail}) - ${proj}` },
      { type: 'allowStop' },
    ]);
  }

  // --- after a kill-and-restore: reconcile first, read-only, before any signal or verdict ---
  if (s.signals.interrupted) return reconcile(s, ctx, { now, phase, J, done, effects });

  // --- consume the signals written by the verbs, then the verdict artifacts ---
  let report = s.signals.lastReport;
  let claimed = s.signals.claimedDone === true;
  s.signals.lastReport = 'none';
  s.signals.claimedDone = false;
  let verdictSrc = report === 'none' ? null : 'verb';
  const artifacts = ctx.artifacts || {};
  const artifactAt = ctx.artifactAt || {};
  // A verdict is consumed on read, but not thrown away: it is renamed after the iteration
  // it judged, so the fix phase can reread the findings instead of asking the reviewer again.
  const keptAs = (name) => name.replace(/\.json$/, `-${s.counters.iterations}.json`);
  // A verdict that answers an earlier request is kept aside (never read as this iteration's
  // verdict): a subagent of a turn that was killed and restored, of an earlier round, or a
  // file left over across a takeover. Its id says which request it answers: a match is
  // this one whatever the file clock says (a share whose clock lags), another id is an
  // earlier one. A verdict without an id (an agent never handed one: an older prompt pack,
  // a re-delegation after a compaction) falls back to the clock: written before the
  // request, it is stale. One second of tolerance for coarse file clocks. A stale file is
  // no verdict, so an outcome recorded with the report verb still stands.
  const LATE_TOLERANCE_MS = 1000;
  const readVerdict = (name, key, parse, summarize) => {
    const at = Number(artifactAt[key]) || 0;
    const v = parse(artifacts[key]);
    const id = v.ok ? cleanRequestId(v.requestId) : null;
    const byId = !!s.verdictRequestId && !!id;
    const oldById = byId && id !== s.verdictRequestId;
    const oldByTime = !byId && s.verdictRequestedAt > 0 && at > 0 && at + LATE_TOLERANCE_MS < s.verdictRequestedAt;
    if (oldByTime || oldById) {
      const as = name.replace(/\.json$/, `-stale-${s.counters.iterations}.json`);
      effects.push({ type: 'keepArtifact', name, as });
      if (report === 'none') verdictSrc = name;
      J({ type: 'verdict', artifact: name, stale: true, staleBy: oldById ? 'requestId' : 'mtime', requestId: id, expectedRequestId: s.verdictRequestId, writtenAt: at > 0 ? iso(at) : null, requestedAt: iso(s.verdictRequestedAt), savedAs: as, treatedAs: report === 'none' ? 'missing' : `report ${report}` });
      return;
    }
    ctx = { ...ctx, verdictFile: `.omc-loop/${keptAs(name)}` };
    effects.push({ type: 'keepArtifact', name, as: keptAs(name) });
    verdictSrc = name;
    if (v.ok) {
      report = summarize(v);
      J({ type: 'verdict', artifact: name, ...(key === 'review' ? { blocking: v.blocking, declaredBlocking: v.declaredBlocking } : { pass: v.pass, declaredPass: v.declaredPass }), findings: v.findings.length, notes: v.notes, savedAs: keptAs(name), details: v.findings });
    } else {
      report = 'none';
      J({ type: 'verdict', artifact: name, error: v.error, treatedAs: 'missing' });
    }
  };
  if (phase === 'review' && artifacts.review != null) readVerdict('review.json', 'review', parseReviewVerdict, (v) => (v.blocking === 0 ? 'pass' : 'fail'));
  else if (phase === 'final-verify' && artifacts.verify != null) readVerdict('verify.json', 'verify', parseVerifyVerdict, (v) => (v.pass ? 'pass' : 'fail'));

  if (!COMPLEXITIES.includes(s.complexity)) s.complexity = 'medium';
  const V = buildVars(s, ctx);
  const proof = testProof(s, ctx);
  const H = () => header(s, ctx, planText);
  const say = (key, vars = {}) => `${H()} ${V.P(key, { ...V, ...vars })}`;

  // pause and hand off to a human: no iteration is spent
  const pauseForHuman = (why, outcome) => {
    s.signals.paused = true;
    s.flags.repeated = false;
    J({ type: 'transition', from: phase, to: s.phase, outcome, report, verdictSrc, paused: true, why });
    return done(outcome, [
      { type: 'saveState' },
      { type: 'writeEscalation', why },
      { type: 'notify', title: NOTIFY_TITLE, message: `Loop paused, a human is needed: ${why} - ${proj}. Hand-off in .omc-loop/ESCALATION.md` },
      { type: 'allowStop' },
    ]);
  };

  // regular transition: look the row up, set the phase, render the instruction
  const go = (outcome, vars = {}, extraEffects = []) => {
    const row = lookup(phase, outcome);
    if (!row) throw new Error(`no transition for ${phase}:${outcome}`);
    // staying in the phase after a missing outcome keeps the request; a state from before
    // request ids gets one, so no prompt ever hands out an empty id
    if (REQUEST_PROMPTS.has(row.prompt)) issueRequest(s, now, row.next, ctx);
    else if ((row.next === 'review' || row.next === 'final-verify') && !s.verdictRequestId) s.verdictRequestId = `${now}-${s.counters.iterations + 1}-${row.next}`;
    s.phase = row.next;
    const reason = say(row.prompt, { ...vars, verdictRequestId: s.verdictRequestId || '' });
    s.counters.iterations += 1;
    J({ type: 'transition', from: phase, to: s.phase, outcome, report, verdictSrc, claimed, prompt: row.prompt, iteration: s.counters.iterations, ...(vars.testProof ? { testProof: vars.testProof } : {}), ...(vars.gate ? { gate: vars.gate } : {}) });
    return done(outcome, [...extraEffects, { type: 'saveState' }, { type: 'block', reason }]);
  };

  const reviewFailed = (outcome) => {
    if (s.counters.retries >= s.limits.maxRetries) {
      return pauseForHuman(`${s.counters.retries} fixes did not clear the review of the same step (limit ${s.limits.maxRetries})`, 'fail-limit');
    }
    s.counters.retries += 1;
    s.flags.repeated = false;
    return go(outcome, { retries: s.counters.retries, extFixHint: s.counters.retries >= 2 ? V.extFixHint : '' });
  };
  const verifyFailed = (outcome) => {
    if (s.counters.finalFails >= s.limits.maxRetries) {
      return pauseForHuman(`${s.counters.finalFails} final verifications failed (limit ${s.limits.maxRetries})`, 'fail-limit');
    }
    s.counters.finalFails += 1;
    s.counters.staleGates = 0;
    s.flags.repeated = false;
    return go(outcome, { finalFails: s.counters.finalFails });
  };

  // A final pass judged the tree its request pointed at; it closes the work only if what
  // admitted the work to the verification still holds. Not the claim's freshness rules: the
  // suite ran before the request, so "run in this iteration" can never hold at the verdict.
  // What is checked: no step reopened; the last recorded suite run green, and run on the
  // code the verifier judged (a cleanup that edited code and did not rerun it is not); and
  // that code unchanged since the request (documentation aside). No snapshot (outside git,
  // a hook deadline) is no evidence either way. -> null | { outcome, vars }
  const exitBlock = () => {
    const openSteps = countOpenSteps(planText);
    if (openSteps > 0) return { outcome: 'pass-open', vars: { openSteps, gate: 'open-steps' } };
    const t = s.lastTest;
    const judged = s.verdictTree;
    if (s.options.testCmd && !t) return { outcome: 'pass-stale', vars: { gate: 'no-test' } };
    if (t && Number(t.exitCode) !== 0) return { outcome: 'pass-stale', vars: { gate: 'red-test' } };
    if (t && judged && t.codeFingerprint && t.codeFingerprint !== judged) return { outcome: 'pass-stale', vars: { gate: 'untested' } };
    const tree = ctx.codeFingerprint ?? null;
    if (judged && tree != null && tree !== judged) return { outcome: 'pass-stale', vars: { gate: 'code-changed' } };
    return null;
  };
  const verdictPass = phase === 'final-verify' && report === 'pass';
  const passBlock = verdictPass ? exitBlock() : null;
  // A pass that keeps not covering the current tree is not the work failing: something keeps
  // changing it under the verifier (output its own runs rewrite and git does not ignore,
  // typically). Bounded like the rejections, then a human looks. A rejection or a reopened
  // step ends the streak.
  if (passBlock && passBlock.outcome === 'pass-open') s.counters.staleGates = 0;
  if (passBlock && passBlock.outcome === 'pass-stale') {
    if (s.counters.staleGates >= s.limits.maxRetries) {
      s.counters.staleGates = 0;
      s.phase = 'implement';
      return pauseForHuman(`${s.limits.maxRetries + 1} final passes, with no rejection in between, did not cover the current work (last: ${passBlock.vars.gate}): something keeps changing the code under the verifier, typically build or test output its own runs rewrite and git does not ignore (add it to .gitignore), or the suite keeps going red. After the fix and resume: run the suite with the test verb and claim-done, which asks for a new final verification (a claim-done of the paused turn was not kept)`, 'pass-stale-limit');
    }
    s.counters.staleGates += 1;
  }

  // --- claim-done: the entrance to the exit ramp. Proofs, not words. ---
  // A clean final verdict answers the claim that asked for it: a second claim-done in the
  // same turn (documentation touched up after the pass, typically) must not throw it away
  // and reopen a whole verification round on a tree that was already approved. A pass that
  // cannot close is another story: the claim decides, and may ask for the next round now.
  const passedFinal = verdictPass && !passBlock;
  if (claimed && passedFinal) J({ type: 'claim', ignored: true, why: 'final verification already passed' });
  // The claim's proofs: none missing -> null, else the refusal to route.
  const t = s.lastTest;
  const green = !!t && Number(t.exitCode) === 0;
  // Fresh = run in this very iteration, or run on this very tree: the fingerprint is the
  // stronger evidence, so a green from an earlier iteration still counts when the code did
  // not change since (documentation changes included: they run in no test).
  const sameIteration = green && Number(t.iteration) === s.counters.iterations;
  const claimBlock = () => {
    const openSteps = countOpenSteps(planText);
    const testRequired = !!(s.options.testCmd || t);
    const fresh = sameIteration || proof.green;
    // A recorded snapshot must be revalidated: null means the shell could not recompute it
    // (deadline, unreadable tree), which is NOT a code change and gets its own instruction.
    const unverifiable = !!t && !!t.fingerprint && ctx.fingerprint == null;
    const stale = green && !!t.fingerprint && !unverifiable && !proof.green;
    if (openSteps > 0) return { outcome: 'claim-open', vars: { openSteps } };
    if (testRequired && !green) return { outcome: 'claim-no-test', vars: {} };
    if (unverifiable) return { outcome: 'claim-unverifiable', vars: {} };
    if (stale) return { outcome: 'claim-stale', vars: {} };
    if (testRequired && !fresh) return { outcome: 'claim-no-test', vars: {} };
    return null;
  };
  // A verdict read this turn (a rejection, or a pass that cannot close) was consumed: a claim
  // refused beside it would leave final-verify with no verdict to read, and the next stop
  // would report it missing. Then the verdict routes, and its prompt asks for the claim again.
  const verdictRead = phase === 'final-verify' && (report === 'fail' || !!passBlock);
  let refusal = claimed && !passedFinal ? claimBlock() : null;
  if (refusal && verdictRead) {
    J({ type: 'claim', ignored: true, why: `refused (${refusal.outcome}): the ${report === 'fail' ? 'rejection' : 'final pass not applied'} routes` });
    claimed = false;
    refusal = null;
  }
  if (claimed && passBlock) J({ type: 'claim', ignored: false, why: `final pass not applied (${passBlock.vars.gate}): the claim decides` });
  if (claimed && !passedFinal) {
    if (refusal) return go(refusal.outcome, refusal.vars);
    // a rejection counts even when a claim-done in the same turn asks for the next round
    if (phase === 'final-verify' && report === 'fail') {
      if (s.counters.finalFails >= s.limits.maxRetries) return pauseForHuman(`${s.counters.finalFails} final verifications failed (limit ${s.limits.maxRetries})`, 'fail-limit');
      s.counters.finalFails += 1;
      s.counters.staleGates = 0;
    }
    s.flags.repeated = false;
    s.counters.retries = 0;
    const testProofKind = !t ? 'none' : sameIteration ? 'same-iteration' : proof.docsOnly ? 'docs-only' : 'same-tree';
    if (!s.flags.cleanedOnce) {
      s.flags.cleanedOnce = true;
      return go('claim-first', { testProof: testProofKind });
    }
    return go('claim-again', { testProof: testProofKind }, [{ type: 'dropArtifact', name: 'verify.json' }]);
  }

  switch (phase) {
    case 'plan': {
      if (planExists || s.flags.repeated) {
        if (s.options.approvePlan && !s.flags.planPresented && planExists) {
          s.flags.planPresented = true;
          s.signals.paused = true;
          s.flags.repeated = false;
          return go('approval', {}, [{ type: 'notify', title: NOTIFY_TITLE, message: `Plan ready: review .omc-loop/plan.md and then run resume - ${proj}` }]);
        }
        s.flags.repeated = false;
        if (!s.limits.maxIterationsExplicit) {
          const steps = stepCounts(planText).total;
          const max = adaptiveMax(steps);
          if (max !== s.limits.maxIterations) J({ type: 'budget', adaptive: true, steps, maxIterations: max });
          s.limits.maxIterations = max;
        }
        return go('ready');
      }
      s.flags.repeated = true;
      return go('no-plan');
    }
    case 'implement': {
      // The tree is byte-for-byte what it was at the previous stop and no test ran: the step
      // was not implemented (a subagent still running when the turn ended, typically).
      // Reviewing nothing would burn a review round and desynchronise the phases: ask once.
      const ranTest = !!s.lastTest && Number(s.lastTest.iteration) === s.counters.iterations;
      if (unchangedTree && !ranTest && !s.flags.repeated) {
        s.flags.repeated = true;
        return go('idle');
      }
      s.flags.repeated = false;
      return go('always', {}, [{ type: 'dropArtifact', name: 'review.json' }]);
    }
    case 'review': {
      if (report === 'pass') {
        s.counters.retries = 0;
        s.flags.repeated = false;
        return go('pass');
      }
      if (report === 'fail') return reviewFailed('fail');
      if (!s.flags.repeated) {
        s.flags.repeated = true;
        return go('missing');
      }
      return reviewFailed('missing-twice');
    }
    case 'cleanup': {
      s.flags.repeated = false;
      return go('always', {}, [{ type: 'dropArtifact', name: 'verify.json' }]);
    }
    case 'final-verify': {
      if (report === 'pass') {
        // not a rejection: the verifier passed, so no finalFails; back to implement, where
        // the next claim-done proves the current tree and asks for a new verification
        if (passBlock) {
          s.flags.repeated = false;
          return go(passBlock.outcome, passBlock.vars);
        }
        s.phase = 'git-finish';
        s.flags.repeated = false;
        s.counters.iterations += 1;
        J({ type: 'transition', from: phase, to: 'git-finish', outcome: 'pass', report, verdictSrc, iteration: s.counters.iterations });
        return done('pass', [{ type: 'saveState' }, { type: 'gitFinish', retry: false }]);
      }
      if (report === 'fail') return verifyFailed('fail');
      if (!s.flags.repeated) {
        s.flags.repeated = true;
        return go('missing');
      }
      return verifyFailed('missing-twice');
    }
    case 'git-finish': {
      J({ type: 'transition', from: phase, to: phase, outcome: 'retry' });
      return done('retry', [{ type: 'gitFinish', retry: true }]);
    }
    default: {
      s.flags.repeated = false;
      // lookup() needs a phase that exists in the table: recover through the wildcard row
      const row = lookup('*', 'unknown-phase');
      s.phase = row.next;
      s.counters.iterations += 1;
      J({ type: 'transition', from: phase, to: s.phase, outcome: 'unknown-phase', iteration: s.counters.iterations });
      return done('unknown-phase', [{ type: 'saveState' }, { type: 'block', reason: say(row.prompt) }]);
    }
  }
}

// The restored session inspected the interrupted work and wrote .omc-loop/reconcile.json.
// Its disposition decides where the loop resumes; anything uncertain, and any command still
// running, goes to a human. Counters are never reset: the interruption counts, it does not
// buy a fresh budget. A decision (route or pause) also drops the signals the killed turn
// may have left (a report, a claim): the reconciliation judged the work, not that turn.
function reconcile(s, ctx, { now, phase, J, done, effects }) {
  const i = s.signals.interrupted;
  const LOOP = ctx.LOOP || 'node omc-loop.mjs';
  const P = (key, vars = {}) => renderPrompt(key, { ...vars, LOOP }, ctx.overrides || []);
  const head = header(s, ctx, String(ctx.planText ?? ''));
  const V = buildVars(s, ctx);
  const raw = ctx.artifacts && ctx.artifacts.reconcile != null ? ctx.artifacts.reconcile : null;
  const v = raw == null ? { ok: false, error: 'missing' } : parseReconcile(raw);
  const clear = () => { s.signals.interrupted = null; s.flags.reconcileAsked = false; s.flags.repeated = false; s.signals.lastReport = 'none'; s.signals.claimedDone = false; };
  const pause = (why) => {
    clear();
    s.signals.paused = true;
    // the verdict a subagent of the killed turn left must not answer for the work the human
    // is about to touch: whatever is on disk now belongs to an earlier request
    if (phase === 'review' || phase === 'final-verify') issueRequest(s, now, phase, ctx);
    J({ type: 'reconcile', ok: v.ok, disposition: v.ok ? v.disposition : null, running: v.ok ? v.running : [], outcome: 'reconcile-uncertain', why });
    J({ type: 'transition', from: phase, to: phase, outcome: 'reconcile-uncertain', paused: true, why });
    return done('reconcile-uncertain', [
      { type: 'saveState' },
      { type: 'writeEscalation', why },
      { type: 'notify', title: NOTIFY_TITLE, message: `Loop paused after a restore, a human is needed: ${why} - ${ctx.projectName || 'project'}. Hand-off in .omc-loop/ESCALATION.md` },
      { type: 'allowStop' },
    ]);
  };
  if (!v.ok) {
    if (s.flags.reconcileAsked) return pause(`reconcile.json ${v.error === 'missing' ? 'still missing' : `invalid (${v.error})`} after a second ask: the interrupted work (phase ${i.phase || phase}) needs a human's eyes`);
    s.flags.reconcileAsked = true;
    const row = lookup('*', 'reconcile-missing');
    s.counters.iterations += 1;
    J({ type: 'reconcile', ok: false, error: v.error, outcome: 'reconcile-missing', iteration: s.counters.iterations });
    J({ type: 'transition', from: phase, to: phase, outcome: 'reconcile-missing', prompt: row.prompt, iteration: s.counters.iterations });
    return done('reconcile-missing', [{ type: 'saveState' }, { type: 'block', reason: `${head} ${P(row.prompt, { error: v.error === 'missing' ? '' : ` (${v.error})` })}` }]);
  }
  const as = `reconcile-${s.counters.iterations}.json`;
  effects.push({ type: 'keepArtifact', name: 'reconcile.json', as });
  if (v.disposition === 'uncertain' || v.running.length) {
    return pause(v.running.length ? `command(s) still running after the restore: ${v.running.slice(0, 3).join('; ')}` : `the restored session could not tell what state the work is in${v.summary ? `: ${v.summary}` : ''}`);
  }
  clear();
  const outcome = v.next === 'review' ? 'reconcile-review' : 'reconcile-implement';
  const row = lookup('*', outcome);
  // a fresh request even when the phase does not change: review.json is dropped below, and a
  // reviewer of the killed turn that writes after that must not pass for the new one
  if (REQUEST_PROMPTS.has(row.prompt)) issueRequest(s, now, row.next, ctx);
  s.phase = row.next;
  s.counters.iterations += 1;
  J({ type: 'reconcile', ok: true, disposition: v.disposition, next: v.next, summary: v.summary, notes: v.notes, savedAs: as, outcome, iteration: s.counters.iterations });
  J({ type: 'transition', from: phase, to: s.phase, outcome, prompt: row.prompt, iteration: s.counters.iterations });
  const extra = outcome === 'reconcile-review' ? [{ type: 'dropArtifact', name: 'review.json' }] : [];
  return done(outcome, [...extra, { type: 'saveState' }, { type: 'block', reason: `${head} ${P(row.prompt, { ...V, verdictRequestId: s.verdictRequestId || '' })}` }]);
}

// After the shell ran the gitFinish effect. gitResult:
//   { ran: false }                                  not a git repo / git disabled
//   { ran: true, confirmed, committed, pushed, pushSkipped, hasUpstream, ahead, pushErr }
// externalNote: '' or the "no external opinion succeeded" sentence (computed by the shell).
export function finishProject(input, gitResult = { ran: false }, ctx = {}) {
  const s = clone(input);
  const effects = [];
  const J = (entry) => effects.push({ type: 'journal', entry });
  const proj = ctx.projectName || 'project';
  const retry = ctx.retry === true;
  const g = gitResult || { ran: false };
  let note = '';
  if (ctx.externalNote) J({ type: 'external-gate', note: ctx.externalNote });
  if (g.ran && !g.confirmed) {
    const why = g.error || (!g.committed ? 'commit did not happen (uncommitted changes remain)'
      : !g.hasUpstream ? 'push impossible: no upstream configured for the branch'
        : `push not confirmed${g.pushErr ? ` (${g.pushErr})` : ''}`);
    s.phase = 'git-finish';
    s.signals.paused = true;
    J({ type: 'git', retry, confirmed: false, committed: !!g.committed, pushed: !!g.pushed, why });
    effects.push(
      { type: 'saveState' },
      { type: 'notify', title: NOTIFY_TITLE, message: `Verification OK but git closure NOT confirmed: ${why}. Fix it and then run: resume - ${proj}` },
      { type: 'allowStop' },
    );
    return { state: s, effects, outcome: 'git-unconfirmed' };
  }
  if (g.ran && g.pushSkipped) {
    const aheadNote = g.hasUpstream && g.ahead > 0 ? ` (HEAD ${g.ahead} ahead of upstream, NOT pushed)` : '';
    note = ` · local commit, --no-push${aheadNote}`;
    J({ type: 'git', retry, confirmed: true, pushSkipped: true, ahead: g.ahead || 0 });
  } else if (g.ran) {
    note = ' · commit+push confirmed';
    J({ type: 'git', retry, confirmed: true, pushed: true });
  } else J({ type: 'git', ran: false });
  const baseDirty = Array.isArray(s.baselineDirty) ? s.baselineDirty : [];
  if (g.ran && baseDirty.length) {
    const lst = baseDirty.slice(0, 5).join(', ') + (baseDirty.length > 5 ? `, +${baseDirty.length - 5} more` : '');
    note += ` · ⚠ the commit may include ${baseDirty.length} file(s) already modified at arm (${lst})`;
    J({ type: 'baseline-dirty', count: baseDirty.length, files: baseDirty.slice(0, 10) });
  }
  if (ctx.externalNote) note += ' · ⚠ gate without a successful external opinion (detail in the commit body, if in git)';
  J({ type: 'done', iterations: s.counters.iterations, tokens: tokensSpent(s.usage) });
  effects.push(
    { type: 'saveState' },
    { type: 'archiveRun', outcome: 'done' },
    { type: 'disarm' },
    { type: 'notify', title: NOTIFY_TITLE, message: `Project finished and verified - ${proj}${note}` },
    { type: 'allowStop' },
  );
  return { state: s, effects, outcome: 'done' };
}

export { PHASES };
