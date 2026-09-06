import { test } from 'node:test';
import assert from 'node:assert/strict';
import { step, finishProject, DEFAULT_TAKEOVER_MS } from '../../src/core/machine.mjs';
import { TRANSITIONS } from '../../src/core/transitions.mjs';
import { mk, ctx, ev, run, journal } from '../helpers/core.mjs';

const PLAN = '- [ ] step one\n- [ ] step two\n';
const PLAN_DONE = '- [x] step one\n- [x] step two\n';

// ---------------------------------------------------------------- plan
test('plan without plan.md -> plan-write, asked once', () => {
  const r = run(mk(), { planExists: false });
  assert.equal(r.outcome, 'no-plan');
  assert.equal(r.state.phase, 'plan');
  assert.equal(r.state.flags.repeated, true);
  assert.ok(r.reason.includes('PHASE: plan'));
  assert.ok(r.reason.startsWith('[perseveranza v2.0.0 ·'));
  assert.equal(r.state.counters.iterations, 1);
  // second miss: goes to implement anyway (tolerant, but never stuck in plan)
  const r2 = run(r.state, { planExists: false });
  assert.equal(r2.outcome, 'ready');
  assert.equal(r2.state.phase, 'implement');
});

test('plan with plan.md -> implement, adaptive budget when --max was not explicit', () => {
  const r = run(mk(), { planExists: true, planText: PLAN });
  assert.equal(r.state.phase, 'implement');
  assert.equal(r.state.limits.maxIterations, 8 + 3 * 2);
  assert.ok(r.reason.includes('PHASE: implement'));
  assert.ok(journal(r).some((j) => j.type === 'budget' && j.adaptive));
});

test('plan: explicit --max is never replaced by the adaptive budget', () => {
  const r = run(mk({ limits: { maxIterations: 40, maxIterationsExplicit: true } }), { planExists: true, planText: PLAN });
  assert.equal(r.state.limits.maxIterations, 40);
});

test('--approve-plan: one block presenting the plan, then pause, then normal after resume', () => {
  const r = run(mk({ options: { approvePlan: true } }), { planExists: true, planText: PLAN });
  assert.equal(r.outcome, 'approval');
  assert.equal(r.state.phase, 'plan');
  assert.equal(r.state.signals.paused, true);
  assert.equal(r.state.flags.planPresented, true);
  assert.ok(r.reason.includes('resume'));
  assert.ok(r.types.includes('notify'));
  // paused: silence
  const r2 = run(r.state, { planExists: true, planText: PLAN });
  assert.equal(r2.outcome, 'paused');
  assert.ok(!r2.blocked);
  // after resume (verb clears paused): goes to implement, gate not repeated
  const s3 = { ...r.state, signals: { ...r.state.signals, paused: false } };
  const r3 = run(s3, { planExists: true, planText: PLAN });
  assert.equal(r3.state.phase, 'implement');
});

// ---------------------------------------------------------------- implement / review
test('implement -> review, drops a stale review.json', () => {
  const r = run(mk({ phase: 'implement' }), { planText: PLAN });
  assert.equal(r.state.phase, 'review');
  assert.ok(r.reason.includes('PHASE: code review'));
  assert.ok(r.reason.includes('model=sonnet'));
  assert.ok(r.effects.some((e) => e.type === 'dropArtifact' && e.name === 'review.json'));
});

test('review model routing follows complexity', () => {
  assert.ok(run(mk({ phase: 'implement', complexity: 'low' })).reason.includes('model=haiku'));
  assert.ok(run(mk({ phase: 'implement', complexity: 'high' })).reason.includes('model=opus'));
  const r = run(mk({ phase: 'implement', complexity: 'high' }));
  assert.ok(!r.reason.includes('pf-executor')); // implHint is for implement phases, not delegation
});

test('review.json blocking=0 -> advance, retries reset, artifact consumed', () => {
  const r = run(mk({ phase: 'review', counters: { retries: 2 } }), { artifacts: { review: '{"blocking":0,"findings":[]}' } });
  assert.equal(r.outcome, 'pass');
  assert.equal(r.state.phase, 'implement');
  assert.equal(r.state.counters.retries, 0);
  assert.ok(r.reason.includes('Review passed'));
  // consumed on read, kept for the fix phase and the archive: review.json -> review-<n>.json
  assert.ok(r.effects.some((e) => e.type === 'keepArtifact' && e.name === 'review.json' && e.as === 'review-0.json'));
  assert.ok(!r.effects.some((e) => e.type === 'dropArtifact' && e.name === 'review.json'));
  const v = journal(r).find((j) => j.type === 'verdict' && j.artifact === 'review.json');
  assert.equal(v.savedAs, 'review-0.json');
  assert.deepEqual(v.details, []);
});

test('review.json blocking>0: the fix instruction points at the kept findings file', () => {
  const r = run(mk({ phase: 'review', counters: { iterations: 4 } }), { artifacts: { review: '{"blocking":1,"findings":[{"severity":"critical","desc":"off by one","file":"a.js:3"}]}' } });
  assert.equal(r.outcome, 'fail');
  assert.ok(r.effects.some((e) => e.type === 'keepArtifact' && e.as === 'review-4.json'));
  assert.ok(r.reason.includes('.omc-loop/review-4.json'), r.reason);
  const v = journal(r).find((j) => j.type === 'verdict');
  assert.deepEqual(v.details, [{ severity: 'critical', desc: 'off by one', file: 'a.js:3' }]);
  // outcome recorded through the verb: no file to point at
  const viaVerb = run(mk({ phase: 'review', signals: { lastReport: 'fail' } }));
  assert.equal(viaVerb.outcome, 'fail');
  assert.ok(!viaVerb.reason.includes('review-'));
});

test('verify.json is kept as verify-<n>.json and the post-fix instruction points at it', () => {
  const r = run(mk({ phase: 'final-verify', counters: { iterations: 9 } }), { artifacts: { verify: '{"pass":false,"findings":[{"severity":"critical","desc":"x"}]}' } });
  assert.equal(r.outcome, 'fail');
  assert.ok(r.effects.some((e) => e.type === 'keepArtifact' && e.name === 'verify.json' && e.as === 'verify-9.json'));
  assert.ok(r.reason.includes('.omc-loop/verify-9.json'));
});

test('review.json blocking>0 -> fix on the same step, retries++', () => {
  const r = run(mk({ phase: 'review' }), { artifacts: { review: '{"blocking":1,"findings":[{"severity":"critical","desc":"x"}]}' } });
  assert.equal(r.outcome, 'fail');
  assert.equal(r.state.phase, 'implement');
  assert.equal(r.state.counters.retries, 1);
  assert.ok(r.reason.includes('attempt 1/3'));
});

test('maxRetries fixes are really granted: pause only on the (max+1)th failure', () => {
  let s = mk({ phase: 'review' });
  const fail = { artifacts: { review: '{"blocking":1}' } };
  for (let i = 1; i <= 3; i++) {
    const r = run(s, fail);
    assert.equal(r.state.phase, 'implement', `fix ${i}`);
    assert.ok(r.reason.includes(`attempt ${i}/3`));
    s = { ...r.state, phase: 'review' }; // implement -> review happens via the hook; shortcut here
  }
  const r4 = run(s, fail);
  assert.equal(r4.outcome, 'fail-limit');
  assert.equal(r4.state.signals.paused, true);
  assert.ok(r4.types.includes('writeEscalation'));
  assert.ok(r4.types.includes('notify'));
  assert.ok(!r4.blocked);
});

test('external diagnosis hint enters from the 2nd fix, only when externals exist', () => {
  const s = mk({ phase: 'review', counters: { retries: 1 }, options: { externals: ['codex'] } });
  const r = run(s, { artifacts: { review: '{"blocking":1}' } });
  assert.ok(r.reason.includes('external-fix'));
  const r1 = run(mk({ phase: 'review', options: { externals: ['codex'] } }), { artifacts: { review: '{"blocking":1}' } });
  assert.ok(!r1.reason.includes('external-fix'));
});

test('review: verb report is used when no artifact exists', () => {
  const r = run(mk({ phase: 'review', signals: { lastReport: 'pass' } }));
  assert.equal(r.outcome, 'pass');
  assert.equal(r.state.signals.lastReport, 'none');
});

test('review: missing outcome asked once, then counted as a failure', () => {
  const r = run(mk({ phase: 'review' }));
  assert.equal(r.outcome, 'missing');
  assert.equal(r.state.phase, 'review');
  assert.ok(r.reason.includes('outcome missing'));
  const r2 = run(r.state);
  assert.equal(r2.outcome, 'missing-twice');
  assert.equal(r2.state.phase, 'implement');
  assert.equal(r2.state.counters.retries, 1);
});

test('review: malformed review.json is journaled and treated as missing', () => {
  const r = run(mk({ phase: 'review' }), { artifacts: { review: '{"blocking":"lots"}' } });
  assert.equal(r.outcome, 'missing');
  assert.ok(journal(r).some((j) => j.type === 'verdict' && j.error));
  assert.ok(r.effects.some((e) => e.type === 'keepArtifact'));
});

test('review: artifact wins over a stale verb report', () => {
  const r = run(mk({ phase: 'review', signals: { lastReport: 'pass' } }), { artifacts: { review: '{"blocking":1}' } });
  assert.equal(r.outcome, 'fail');
});

test('malformed verdict artifacts override a previous pass in both review phases', () => {
  for (const [phase, name] of [['review', 'review'], ['final-verify', 'verify']]) {
    const r = run(mk({ phase, signals: { lastReport: 'pass' } }), { artifacts: { [name]: '{broken' } });
    assert.equal(r.outcome, 'missing', phase);
    assert.equal(r.state.phase, phase);
    assert.ok(!r.types.includes('gitFinish'));
  }
});

// ---------------------------------------------------------------- claim-done
test('claim-done refused with open steps', () => {
  const r = run(mk({ phase: 'implement', signals: { claimedDone: true } }), { planText: PLAN });
  assert.equal(r.outcome, 'claim-open');
  assert.equal(r.state.phase, 'implement');
  assert.ok(r.reason.includes('2 unchecked'));
});

test('claim-done refused without a fresh green test when a suite is known', () => {
  const s = mk({ phase: 'implement', signals: { claimedDone: true }, options: { testCmd: 'npm test' }, counters: { iterations: 5 } });
  const r = run(s, { planText: PLAN_DONE });
  assert.equal(r.outcome, 'claim-no-test');
  assert.ok(r.reason.includes('test --if-needed -- npm test'));
  // an older green without a fingerprint (no git at test time) cannot be tied to this tree
  const old = { ...s, lastTest: { cmd: 'npm test', exitCode: 0, iteration: 4, at: 'x', fingerprint: null } };
  assert.equal(run(old, { planText: PLAN_DONE }).outcome, 'claim-no-test');
  // an older green WITH a fingerprint that still matches the tree is a valid proof
  const sameTree = { ...s, lastTest: { cmd: 'npm test', exitCode: 0, iteration: 2, at: 'x', fingerprint: 'fp', codeFingerprint: 'cfp' } };
  const ok = run(sameTree, { planText: PLAN_DONE, fingerprint: 'fp', codeFingerprint: 'cfp' });
  assert.equal(ok.outcome, 'claim-first');
  assert.equal(journal(ok).find((j) => j.type === 'transition').testProof, 'same-tree');
  // only documentation changed since: the code fingerprint still matches
  const docs = run(sameTree, { planText: PLAN_DONE, fingerprint: 'other', codeFingerprint: 'cfp' });
  assert.equal(docs.outcome, 'claim-first');
  assert.equal(journal(docs).find((j) => j.type === 'transition').testProof, 'docs-only');
  // code changed: stale, whatever the iteration
  assert.equal(run(sameTree, { planText: PLAN_DONE, fingerprint: 'other', codeFingerprint: 'other' }).outcome, 'claim-stale');
  // older green, tree not computable: no proof for this tree
  assert.equal(run(sameTree, { planText: PLAN_DONE, fingerprint: null, codeFingerprint: null }).outcome, 'claim-unverifiable');
  const red = { ...s, lastTest: { cmd: 'npm test', exitCode: 1, iteration: 5, at: 'x', fingerprint: null } };
  assert.equal(run(red, { planText: PLAN_DONE }).outcome, 'claim-no-test');
});

test('claim-done refused when the code changed after the green test (fingerprint)', () => {
  const s = mk({ phase: 'implement', signals: { claimedDone: true }, counters: { iterations: 5 }, lastTest: { cmd: 'npm test', exitCode: 0, iteration: 5, at: 'x', fingerprint: 'aaa' } });
  const r = run(s, { planText: PLAN_DONE, fingerprint: 'bbb' });
  assert.equal(r.outcome, 'claim-stale');
  assert.ok(r.reason.includes('stale'));
  assert.equal(run(s, { planText: PLAN_DONE, fingerprint: 'aaa' }).outcome, 'claim-first');
  // a snapshot the shell could not recompute is refused too, but as its own outcome: it is not a code change
  const u = run(s, { planText: PLAN_DONE, fingerprint: null });
  assert.equal(u.outcome, 'claim-unverifiable');
  assert.equal(u.state.phase, 'implement');
  assert.ok(u.effects.find((e) => e.type === 'block').reason.includes('NOT a code change'));
  assert.equal(run(s, { planText: PLAN_DONE }).outcome, 'claim-unverifiable'); // undefined counts as "not computed"
  // no recorded snapshot (test outside git): nothing to revalidate
  const noFp = { ...s, lastTest: { ...s.lastTest, fingerprint: null } };
  assert.equal(run(noFp, { planText: PLAN_DONE, fingerprint: null }).outcome, 'claim-first');
});

test('claim-done without a suite -> cleanup once, then final-verify', () => {
  const r = run(mk({ phase: 'implement', signals: { claimedDone: true } }), { planText: PLAN_DONE });
  assert.equal(r.outcome, 'claim-first');
  assert.equal(r.state.phase, 'cleanup');
  assert.equal(r.state.flags.cleanedOnce, true);
  const r2 = run({ ...r.state, signals: { ...r.state.signals, claimedDone: true } }, { planText: PLAN_DONE });
  assert.equal(r2.outcome, 'claim-again');
  assert.equal(r2.state.phase, 'final-verify');
  assert.ok(r2.effects.some((e) => e.type === 'dropArtifact' && e.name === 'verify.json'));
});

test('cleanup -> final-verify with the security lens only for high complexity', () => {
  const r = run(mk({ phase: 'cleanup' }));
  assert.equal(r.state.phase, 'final-verify');
  assert.ok(r.reason.includes('model=opus'));
  assert.ok(!r.reason.includes('security lens'));
  assert.ok(run(mk({ phase: 'cleanup', complexity: 'high' })).reason.includes('security lens'));
  assert.ok(run(mk({ phase: 'cleanup', complexity: 'low' })).reason.includes('model=sonnet'));
});

// ---------------------------------------------------------------- final-verify
test('verify.json pass:true -> git-finish effect (closure happens in finishProject)', () => {
  const r = run(mk({ phase: 'final-verify' }), { artifacts: { verify: '{"pass":true}' } });
  assert.equal(r.outcome, 'pass');
  assert.equal(r.state.phase, 'git-finish');
  assert.ok(r.types.includes('gitFinish'));
  assert.ok(!r.blocked);
});

test('verify.json pass:false -> post-verification fix, finalFails++', () => {
  const r = run(mk({ phase: 'final-verify' }), { artifacts: { verify: '{"pass":false,"findings":[{"severity":"critical","desc":"x"}]}' } });
  assert.equal(r.outcome, 'fail');
  assert.equal(r.state.phase, 'implement');
  assert.equal(r.state.counters.finalFails, 1);
  assert.ok(r.reason.includes('rejection 1/3'));
});

test('final verification: missing twice = rejection; pause after maxRetries rejections', () => {
  const r = run(mk({ phase: 'final-verify' }));
  assert.equal(r.outcome, 'missing');
  const r2 = run(r.state);
  assert.equal(r2.outcome, 'missing-twice');
  assert.equal(r2.state.counters.finalFails, 1);
  const r3 = run(mk({ phase: 'final-verify', counters: { finalFails: 3 } }), { artifacts: { verify: '{"pass":false}' } });
  assert.equal(r3.outcome, 'fail-limit');
  assert.equal(r3.state.signals.paused, true);
});

test('git-finish phase (after resume) retries the closure', () => {
  const r = run(mk({ phase: 'git-finish' }));
  assert.equal(r.outcome, 'retry');
  assert.ok(r.effects.some((e) => e.type === 'gitFinish' && e.retry === true));
});

// ---------------------------------------------------------------- finishProject
test('finishProject: confirmed -> archive, disarm, notify', () => {
  const r = finishProject(mk({ phase: 'git-finish' }), { ran: true, confirmed: true, committed: true, pushed: true, hasUpstream: true }, { projectName: 'p' });
  assert.equal(r.outcome, 'done');
  const types = r.effects.map((e) => e.type);
  assert.ok(types.includes('archiveRun') && types.includes('disarm') && types.includes('notify') && types.includes('allowStop'));
  assert.ok(r.effects.find((e) => e.type === 'notify').message.includes('commit+push confirmed'));
});

test('finishProject: not confirmed -> pause in git-finish, no disarm', () => {
  const r = finishProject(mk({ phase: 'git-finish' }), { ran: true, confirmed: false, committed: true, pushed: false, hasUpstream: false });
  assert.equal(r.outcome, 'git-unconfirmed');
  assert.equal(r.state.signals.paused, true);
  assert.equal(r.state.phase, 'git-finish');
  assert.ok(!r.effects.some((e) => e.type === 'disarm'));
  assert.ok(r.effects.find((e) => e.type === 'notify').message.includes('no upstream'));
});

test('finishProject: --no-push, baseline dirty and external note are reported', () => {
  const r = finishProject(mk({ baselineDirty: ['a.js', 'b.js'] }), { ran: true, confirmed: true, committed: true, pushSkipped: true, hasUpstream: true, ahead: 1 }, { externalNote: 'no external opinion' });
  const msg = r.effects.find((e) => e.type === 'notify').message;
  assert.ok(msg.includes('--no-push'));
  assert.ok(msg.includes('1 ahead'));
  assert.ok(msg.includes('2 file(s) already modified'));
  assert.ok(msg.includes('external opinion'));
  assert.ok(journal(r).some((j) => j.type === 'external-gate'));
});

test('finishProject: outside git -> still done', () => {
  const r = finishProject(mk(), { ran: false });
  assert.equal(r.outcome, 'done');
});

// ---------------------------------------------------------------- guards
test('paused loop: allowStop, nothing else', () => {
  const r = run(mk({ phase: 'review', signals: { paused: true } }));
  assert.equal(r.outcome, 'paused');
  assert.deepEqual(r.types.filter((t) => t !== 'journal'), ['saveState', 'allowStop']);
});

test('budget exhausted: archive, disarm, notify, allowStop; grace on the exit ramp', () => {
  const r = run(mk({ phase: 'implement', counters: { iterations: 25 } }));
  assert.equal(r.outcome, 'budget');
  assert.ok(r.types.includes('archiveRun') && r.types.includes('disarm'));
  const ramp = run(mk({ phase: 'final-verify', counters: { iterations: 25 } }));
  assert.notEqual(ramp.outcome, 'budget');
  const tok = run(mk({ phase: 'implement', limits: { maxTokens: 10 } }), { usage: { inputTokens: 8, outputTokens: 5 } });
  assert.equal(tok.outcome, 'budget');
  assert.ok(journal(tok).some((j) => j.type === 'budget' && j.reason === 'tokens'));
});

test('session scoping: first fire claims, foreign session is ignored, takeover after inactivity', () => {
  const r = run(mk(), {}, { sessionId: 'A' });
  assert.equal(r.state.owner.sessionId, 'A');
  const foreign = step(r.state, ev({ sessionId: 'B', now: r.state.owner.lastFireAt + 1000 }), ctx());
  assert.equal(foreign.outcome, 'foreign-session');
  assert.deepEqual(foreign.effects.map((e) => e.type), ['allowStop']);
  assert.equal(foreign.state, r.state); // untouched
  const late = step(r.state, ev({ sessionId: 'B', now: r.state.owner.lastFireAt + DEFAULT_TAKEOVER_MS + 1 }), ctx());
  assert.equal(late.state.owner.sessionId, 'B');
  assert.ok(late.effects.some((e) => e.type === 'journal' && e.entry.type === 'session' && e.entry.event === 'takeover'));
});

test('no session id in the payload: no scoping, same behaviour', () => {
  const r = step(mk({ owner: { sessionId: 'A', lastFireAt: 1 } }), { now: 2, payloadKeys: [] }, ctx());
  assert.notEqual(r.outcome, 'foreign-session');
});

test('usage from the shell is merged and journaled', () => {
  const r = run(mk(), { usage: { inputTokens: 100, outputTokens: 50 } });
  assert.equal(r.state.usage.inputTokens, 100);
  assert.equal(r.state.usage.source, 'transcript');
  assert.ok(journal(r).some((j) => j.type === 'usage' && j.spent === 150));
});

test('unknown phase: restart from plan', () => {
  const r = run(mk({ phase: 'weird' }));
  assert.equal(r.outcome, 'unknown-phase');
  assert.equal(r.state.phase, 'plan');
  assert.ok(r.reason.includes('inconsistent state'));
});

test('prompt pack overrides change the text but never the routing', () => {
  const r = run(mk({ phase: 'implement' }), { overrides: [{ 'review-delegate': 'CUSTOM REVIEW {{reviewModel}}' }] });
  assert.equal(r.state.phase, 'review');
  assert.ok(r.reason.endsWith('CUSTOM REVIEW sonnet'));
  assert.ok(r.reason.startsWith('[perseveranza'));
});

test('the fire journal entry records the payload keys, never the values', () => {
  const r = run(mk(), {}, { payloadKeys: ['session_id', 'transcript_path'] });
  const fire = journal(r).find((j) => j.type === 'fire');
  assert.deepEqual(fire.payloadKeys, ['session_id', 'transcript_path']);
});

// ---------------------------------------------------------------- table coverage
test('every regular transition row is reachable through step()', () => {
  const reached = new Set();
  const note = (r) => reached.add(r.outcome);
  note(run(mk(), { planExists: false }));
  note(run(mk({ options: { approvePlan: true } }), { planExists: true, planText: PLAN }));
  note(run(mk(), { planExists: true, planText: PLAN }));
  note(run(mk({ phase: 'implement' })));
  note(run(mk({ phase: 'implement', tree: { fingerprint: 'same', iteration: 0 } }), { fingerprint: 'same' }));
  note(run(mk({ phase: 'review' }), { artifacts: { review: '{"blocking":0}' } }));
  note(run(mk({ phase: 'review' }), { artifacts: { review: '{"blocking":1}' } }));
  note(run(mk({ phase: 'review', counters: { retries: 3 } }), { artifacts: { review: '{"blocking":1}' } }));
  note(run(mk({ phase: 'review' })));
  note(run(mk({ phase: 'review', flags: { repeated: true } })));
  note(run(mk({ phase: 'implement', signals: { claimedDone: true } }), { planText: PLAN }));
  note(run(mk({ phase: 'implement', signals: { claimedDone: true }, options: { testCmd: 'x' } }), { planText: PLAN_DONE }));
  note(run(mk({ phase: 'implement', signals: { claimedDone: true }, lastTest: { cmd: 'x', exitCode: 0, iteration: 0, fingerprint: 'a' } }), { planText: PLAN_DONE, fingerprint: 'b' }));
  note(run(mk({ phase: 'implement', signals: { claimedDone: true }, lastTest: { cmd: 'x', exitCode: 0, iteration: 0, fingerprint: 'a' } }), { planText: PLAN_DONE, fingerprint: null }));
  note(run(mk({ phase: 'implement', signals: { claimedDone: true } }), { planText: PLAN_DONE }));
  note(run(mk({ phase: 'implement', signals: { claimedDone: true }, flags: { cleanedOnce: true } }), { planText: PLAN_DONE }));
  note(run(mk({ phase: 'cleanup' })));
  note(run(mk({ phase: 'final-verify' }), { artifacts: { verify: '{"pass":true}' } }));
  note(run(mk({ phase: 'final-verify' }), { artifacts: { verify: '{"pass":false}' } }));
  note(run(mk({ phase: 'final-verify', counters: { finalFails: 3 } }), { artifacts: { verify: '{"pass":false}' } }));
  note(run(mk({ phase: 'final-verify' })));
  note(run(mk({ phase: 'final-verify', flags: { repeated: true } })));
  note(run(mk({ phase: 'git-finish' })));
  note(run(mk({ counters: { iterations: 99 } })));
  note(run(mk({ phase: 'weird' })));
  const expected = TRANSITIONS.map((r) => r.outcome).filter((o) => o !== 'kill'); // kill lives in the shell
  for (const o of new Set(expected)) assert.ok(reached.has(o), `outcome "${o}" never produced by step()`);
});

// ---------------------------------------------------------------- 2.1: idle stop, test proof
test('implement: a stop that changed nothing and ran no test is asked to implement, once', () => {
  const s = mk({ phase: 'implement', tree: { fingerprint: 'same', iteration: 3 }, counters: { iterations: 3 } });
  const r = run(s, { fingerprint: 'same', codeFingerprint: 'c' });
  assert.equal(r.outcome, 'idle');
  assert.equal(r.state.phase, 'implement');
  assert.equal(r.state.flags.repeated, true);
  assert.ok(r.reason.includes('nothing changed'), r.reason);
  assert.ok(!r.effects.some((e) => e.type === 'dropArtifact'));
  // asked once: the second identical stop goes to review anyway
  const again = run({ ...r.state, signals: { ...r.state.signals } }, { fingerprint: 'same', codeFingerprint: 'c' });
  assert.equal(again.outcome, 'always');
  assert.equal(again.state.phase, 'review');
  assert.equal(again.state.flags.repeated, false);
  // the tree the hook saw is recorded for the next stop
  assert.equal(again.state.tree.fingerprint, 'same');
});

test('implement: a changed tree, a test in this iteration, or an unknown tree never count as idle', () => {
  const base = { phase: 'implement', tree: { fingerprint: 'same', iteration: 3 }, counters: { iterations: 3 } };
  assert.equal(run(mk(base), { fingerprint: 'changed' }).outcome, 'always');
  assert.equal(run(mk({ ...base, lastTest: { cmd: 'x', exitCode: 1, iteration: 3, fingerprint: 'same' } }), { fingerprint: 'same' }).outcome, 'always');
  assert.equal(run(mk(base), { fingerprint: null }).outcome, 'always');
  assert.equal(run(mk({ phase: 'implement' }), { fingerprint: 'first' }).outcome, 'always'); // nothing recorded yet
});

test('test proof hint: green for this tree, docs-only, or none, in every phase that runs tests', () => {
  const green = { cmd: 'npm test', exitCode: 0, iteration: 2, at: 'x', fingerprint: 'fp', codeFingerprint: 'cfp' };
  const s = mk({ phase: 'review', lastTest: green, options: { testCmd: 'npm test' } });
  const r = run(s, { fingerprint: 'fp', codeFingerprint: 'cfp', artifacts: { review: '{"blocking":1,"findings":[]}' } });
  assert.ok(r.reason.includes('Test proof: the full suite is GREEN'), r.reason);
  assert.ok(r.reason.includes('test --if-needed -- npm test'));
  assert.ok(!r.reason.includes('only documentation changed'));
  const docs = run(s, { fingerprint: 'other', codeFingerprint: 'cfp', artifacts: { review: '{"blocking":1,"findings":[]}' } });
  assert.ok(docs.reason.includes('(only documentation changed since)'), docs.reason);
  const none = run(s, { fingerprint: 'other', codeFingerprint: 'other', artifacts: { review: '{"blocking":1,"findings":[]}' } });
  assert.ok(none.reason.includes('Test proof: no green full-suite run'), none.reason);
  // no suite known and never run: nothing to say
  const quiet = run(mk({ phase: 'implement' }), { fingerprint: 'a' });
  assert.ok(!quiet.reason.includes('Test proof'));
  // the review delegation carries it too, so the reviewer is told not to rerun the suite
  const delegate = run(mk({ phase: 'implement', lastTest: green, tree: { fingerprint: 'old', iteration: 1 } }), { fingerprint: 'fp', codeFingerprint: 'cfp' });
  assert.equal(delegate.outcome, 'always');
  assert.ok(delegate.reason.includes('Test proof: the full suite is GREEN'));
});
