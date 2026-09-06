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
//   { type: 'dropArtifact', name }           delete .omc-loop/<name> (a verdict is consumed on read)
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
import { parseReviewVerdict, parseVerifyVerdict } from './verdicts.mjs';
import { lookup } from './transitions.mjs';
import { canContinue, adaptiveMax, tokensSpent } from './budget.mjs';
import { renderPrompt } from './prompts.mjs';
import { PHASES, COMPLEXITIES } from './state.mjs';
import { renderProgress } from '../hud/render.mjs';

export const DEFAULT_TAKEOVER_MS = 6 * 60 * 60 * 1000;
export const MODEL_ROUTING = {
  review: { low: 'haiku', medium: 'sonnet', high: 'opus' },
  verify: { low: 'sonnet', medium: 'opus', high: 'opus' },
};
export const NOTIFY_TITLE = 'Claude Code - perseveranza';

const clone = (o) => JSON.parse(JSON.stringify(o));
const short = (id) => String(id || '').slice(0, 8);

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
  const testRun = s.options.testCmd ? `${LOOP} test -- ${s.options.testCmd}` : `${LOOP} test -- <test command>`;
  return {
    LOOP,
    P,
    implHint,
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

function header(s, ctx, planText) {
  const next = clone(s);
  next.counters.iterations += 1; // the iteration about to start
  const ver = ctx.version ? ` v${ctx.version}` : '';
  const upd = ctx.updateAvailable ? ` · ⬆ v${ctx.updateAvailable} (/plugin)` : '';
  return `[perseveranza${ver} · ${renderProgress(next, planText)}${upd}] Task: ${s.task}.`;
}

export function step(input, event = {}, ctx = {}) {
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
  if (event.sessionId) {
    const owner = s.owner.sessionId;
    const takeoverMs = Number(ctx.takeoverMs) > 0 ? Number(ctx.takeoverMs) : DEFAULT_TAKEOVER_MS;
    const stale = !!owner && s.owner.lastFireAt > 0 && (now - s.owner.lastFireAt) > takeoverMs;
    if (owner && owner !== event.sessionId && !stale) {
      // another session drives this loop: let this one stop, touch nothing
      return { state: input, effects: [{ type: 'allowStop' }], outcome: 'foreign-session' };
    }
    if (owner !== event.sessionId) J({ type: 'session', event: owner ? 'takeover' : 'claimed', from: short(owner), to: short(event.sessionId) });
    s.owner.sessionId = event.sessionId;
    s.owner.lastFireAt = now;
  }

  // --- token usage from the transcript (best-effort, measured by the shell) ---
  if (ctx.usage && typeof ctx.usage === 'object') {
    const before = tokensSpent(s.usage);
    s.usage = { ...s.usage, ...ctx.usage, source: ctx.usage.source || 'transcript' };
    J({ type: 'usage', spent: tokensSpent(s.usage), delta: tokensSpent(s.usage) - before });
  }

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

  // --- consume the signals written by the verbs, then the verdict artifacts ---
  let report = s.signals.lastReport;
  const claimed = s.signals.claimedDone === true;
  s.signals.lastReport = 'none';
  s.signals.claimedDone = false;
  let verdictSrc = report === 'none' ? null : 'verb';
  const artifacts = ctx.artifacts || {};
  if (phase === 'review' && artifacts.review != null) {
    effects.push({ type: 'dropArtifact', name: 'review.json' });
    const v = parseReviewVerdict(artifacts.review);
    if (v.ok) {
      report = v.blocking === 0 ? 'pass' : 'fail';
      verdictSrc = 'review.json';
      J({ type: 'verdict', artifact: 'review.json', blocking: v.blocking, declaredBlocking: v.declaredBlocking, findings: v.findings.length, notes: v.notes });
    } else {
      report = 'none';
      verdictSrc = 'review.json';
      J({ type: 'verdict', artifact: 'review.json', error: v.error, treatedAs: 'missing' });
    }
  } else if (phase === 'final-verify' && artifacts.verify != null) {
    effects.push({ type: 'dropArtifact', name: 'verify.json' });
    const v = parseVerifyVerdict(artifacts.verify);
    if (v.ok) {
      report = v.pass ? 'pass' : 'fail';
      verdictSrc = 'verify.json';
      J({ type: 'verdict', artifact: 'verify.json', pass: v.pass, declaredPass: v.declaredPass, findings: v.findings.length, notes: v.notes });
    } else {
      report = 'none';
      verdictSrc = 'verify.json';
      J({ type: 'verdict', artifact: 'verify.json', error: v.error, treatedAs: 'missing' });
    }
  }

  if (!COMPLEXITIES.includes(s.complexity)) s.complexity = 'medium';
  const V = buildVars(s, ctx);
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
    s.phase = row.next;
    const reason = say(row.prompt, vars);
    s.counters.iterations += 1;
    J({ type: 'transition', from: phase, to: s.phase, outcome, report, verdictSrc, claimed, prompt: row.prompt, iteration: s.counters.iterations });
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
    s.flags.repeated = false;
    return go(outcome, { finalFails: s.counters.finalFails });
  };

  // --- claim-done: the entrance to the exit ramp. Proofs, not words. ---
  if (claimed) {
    const openSteps = countOpenSteps(planText);
    const t = s.lastTest;
    const testRequired = !!(s.options.testCmd || t);
    const freshGreen = !!t && Number(t.exitCode) === 0 && Number(t.iteration) === s.counters.iterations;
    // A recorded snapshot must be revalidated: null means the shell could not recompute it
    // (deadline, unreadable tree), which is NOT a code change and gets its own instruction.
    const unverifiable = !!t && !!t.fingerprint && ctx.fingerprint == null;
    const stale = !!t && !!t.fingerprint && !unverifiable && t.fingerprint !== ctx.fingerprint;
    if (openSteps > 0) return go('claim-open', { openSteps });
    if (testRequired && !freshGreen) return go('claim-no-test');
    if (unverifiable) return go('claim-unverifiable');
    if (stale) return go('claim-stale');
    s.flags.repeated = false;
    s.counters.retries = 0;
    if (!s.flags.cleanedOnce) {
      s.flags.cleanedOnce = true;
      return go('claim-first');
    }
    return go('claim-again', {}, [{ type: 'dropArtifact', name: 'verify.json' }]);
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
