// Phase 1 of docs/PIANO-MOD.md: the additive core the mod will drive. A pf-* subagent still
// running at a stop, the mod's usage by agent, the model routing and the verdict check of a
// judge about to stop, and the verbs rendered as the mod's tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeState, normalizeUsage, mergeModUsage, MAX_SUBAGENT_WAITS, mergeVerbFields, VERB_OWNED, defaultState } from '../../src/core/state.mjs';
import { canContinue, tokensSpent } from '../../src/core/budget.mjs';
import { runningLoopAgents, loopAgentName, MODEL_ROUTING, MAX_QUIET_STOPS } from '../../src/core/machine.mjs';
import { routeModel, subagentVerdictCheck, MAX_VERDICT_ASKS } from '../../src/core/subagents.mjs';
import { DEFAULT_PROMPTS, PROMPT_KEYS, renderPrompt, loopVar, validatePack } from '../../src/core/prompts.mjs';
import { sessionNotice, compactNotice, restorePrompt } from '../../src/core/staleness.mjs';
import { summary } from '../../src/cli/verbs/status.mjs';
import { handle } from '../../src/shell/mod-bridge.mjs';
import { subagentWaitMs, waitForSubagent, DEFAULT_SUBAGENT_WAIT_MS } from '../../src/shell/stop-core.mjs';
import { ROOT } from '../../src/shell/paths.mjs';
import { mk, run, journal, LOOP } from '../helpers/core.mjs';

const IT = validatePack(JSON.parse(readFileSync(join(ROOT, 'packs', 'it.json'), 'utf8'))).overrides;
const PLAN = '- [ ] step one\n- [ ] step two\n';
const PLAN_DONE = '- [x] step one\n- [x] step two\n';
const T = 1_700_000_000_000;
const task = (agent_type, status = 'running', description = 'the work') => ({ id: `t-${agent_type}`, type: 'local_agent', status, agent_type, description });
const RUNNING = [task('perseveranza:pf-reviewer')];

// ---------------------------------------------------------------- the loop's agents
test('loopAgentName: pf-* with and without the plugin prefix; anything else is not the loop\'s', () => {
  assert.equal(loopAgentName('pf-reviewer'), 'pf-reviewer');
  assert.equal(loopAgentName('perseveranza:pf-verifier'), 'pf-verifier');
  assert.equal(loopAgentName(' pf-executor '), 'pf-executor');
  for (const t of ['general-purpose', 'other:pf-reviewer', 'pf-', 'xpf-reviewer', '', null, 42, {}]) assert.equal(loopAgentName(t), null, String(t));
});

test('runningLoopAgents: only running pf-* tasks, garbage ignored', () => {
  const tasks = [task('pf-reviewer'), task('perseveranza:pf-verifier', 'RUNNING'), task('pf-executor', 'completed'), task('general-purpose'), null, 'x', { status: 'running' }, { status: 'running', agentType: 'pf-advisor' }];
  assert.deepEqual(runningLoopAgents(tasks).map((a) => a.agent), ['pf-reviewer', 'pf-verifier', 'pf-advisor']);
  assert.deepEqual(runningLoopAgents(undefined), []);
  assert.deepEqual(runningLoopAgents({ status: 'running' }), []);
  assert.equal(runningLoopAgents([task('pf-x', 'running', 'd'.repeat(500))])[0].description.length, 80);
});

// ---------------------------------------------------------------- subagent-running
test('subagent-running: each phase waits for its own role, with or without the prefix; the other pf-* do not hold it', () => {
  const states = {
    implement: [mk({ phase: 'implement', counters: { iterations: 4 } }), 'pf-executor'],
    review: [mk({ phase: 'review', counters: { iterations: 4 }, verdictRequestId: 'R1', verdictRequestedAt: T }), 'pf-reviewer'],
    'final-verify': [mk({ phase: 'final-verify', counters: { iterations: 4 }, verdictRequestId: 'R1', verdictRequestedAt: T }), 'pf-verifier'],
  };
  for (const [phase, [s, role]] of Object.entries(states)) {
    for (const type of [role, `perseveranza:${role}`]) {
      const r = run(s, { planText: PLAN, backgroundTasks: [task(type)] });
      assert.equal(r.outcome, 'subagent-running', `${phase} ${type}`);
      assert.equal(r.state.phase, phase, 'the phase does not change');
      assert.equal(r.state.counters.iterations, 4, 'a wait spends no iteration');
      assert.equal(r.state.counters.subagentWaits, 1);
      assert.equal(r.state.flags.repeated, false, 'a wait is not the missing outcome asked once');
      assert.equal(r.state.verdictRequestId, s.verdictRequestId, 'the request stays the same');
      assert.deepEqual(r.types.slice(-2), ['saveState', 'block']);
      assert.ok(r.reason.includes(`PHASE: ${phase} (a subagent is still running)`), r.reason);
      assert.ok(r.reason.includes(`${role} "the work"`) && r.reason.includes(`1/${MAX_SUBAGENT_WAITS}`), r.reason);
      const tr = journal(r).find((j) => j.type === 'transition');
      assert.deepEqual([tr.outcome, tr.from, tr.to, tr.waits, tr.prompt], ['subagent-running', phase, phase, 1, 'subagent-running']);
    }
    for (const other of ['pf-executor', 'pf-reviewer', 'perseveranza:pf-verifier', 'pf-advisor'].filter((t) => loopAgentName(t) !== role)) {
      assert.notEqual(run(s, { planText: PLAN, backgroundTasks: [task(other)] }).outcome, 'subagent-running', `${phase} must not wait for ${other}`);
    }
    // only the role is listed, even beside others
    const both = run(s, { planText: PLAN, backgroundTasks: [task('pf-advisor'), task(role)] });
    assert.ok(!both.reason.includes('pf-advisor'), both.reason);
  }
});

test('subagent-running: not in the other phases, not for other agents or finished ones, and nothing changes without backgroundTasks', () => {
  for (const [s, c] of [
    [mk(), { planText: PLAN, planExists: true }],
    [mk({ phase: 'cleanup' }), {}],
  ]) assert.notEqual(run(s, { ...c, backgroundTasks: RUNNING }).outcome, 'subagent-running');
  const review = mk({ phase: 'review' });
  for (const tasks of [undefined, [], [task('general-purpose')], [task('pf-reviewer', 'completed')], [task('other:pf-reviewer')]]) {
    const r = run(review, tasks === undefined ? {} : { backgroundTasks: tasks });
    assert.equal(r.outcome, 'missing', JSON.stringify(tasks));
    assert.equal(r.state.counters.subagentWaits, 0);
  }
  // the same states as before the mod: byte for byte the same decision
  const base = run(mk({ phase: 'implement' }), { planText: PLAN });
  const none = run(mk({ phase: 'implement' }), { planText: PLAN, backgroundTasks: [] });
  assert.deepEqual(none.state, base.state);
  assert.equal(none.reason, base.reason);
});

test('subagent-running: at most 3 waits per verdict request; missing does not buy three more; a new request does', () => {
  let s = mk({ phase: 'review', verdictRequestId: 'R1', verdictRequestedAt: T });
  for (let i = 1; i <= MAX_SUBAGENT_WAITS; i++) {
    const r = run(s, { backgroundTasks: RUNNING });
    assert.equal(r.outcome, 'subagent-running');
    assert.equal(r.state.counters.subagentWaits, i);
    assert.equal(r.state.counters.quietStops, i);
    assert.ok(r.reason.includes(`${i}/${MAX_SUBAGENT_WAITS}`));
    s = r.state;
  }
  const fourth = run(s, { backgroundTasks: RUNNING });
  assert.equal(fourth.outcome, 'missing', 'the usual logic: the outcome asked once');
  assert.equal(fourth.state.counters.subagentWaits, MAX_SUBAGENT_WAITS, 'same request: the waits are spent');
  assert.equal(fourth.state.counters.quietStops, 4);
  assert.ok(journal(fourth).some((j) => j.type === 'note' && /still running .* after 3 wait\(s\) for this request/.test(j.text)), JSON.stringify(journal(fourth)));
  const fifth = run(fourth.state, { backgroundTasks: RUNNING });
  assert.equal(fifth.outcome, 'missing-twice', 'no new waits after missing: the round is counted');
  assert.equal(fifth.state.phase, 'implement');
  assert.equal(fifth.state.counters.subagentWaits, 0, 'a phase change resets the waits');
  assert.equal(fifth.state.counters.quietStops, 5, 'missing-twice is no work: the run without work goes on');
  // work (the tree changed) ends the run; the next request waits again from 1
  const toReview = run(fifth.state, { planText: PLAN, fingerprint: 'changed' });
  assert.equal(toReview.outcome, 'always');
  assert.equal(toReview.state.counters.quietStops, 0);
  const again = run(toReview.state, { backgroundTasks: RUNNING, fingerprint: 'changed' });
  assert.equal(again.outcome, 'subagent-running');
  assert.equal(again.state.counters.subagentWaits, 1);
  const routed = run(again.state, { fingerprint: 'changed', artifacts: { review: JSON.stringify({ requestId: again.state.verdictRequestId, blocking: 0 }) } });
  assert.equal(routed.outcome, 'pass');
  assert.deepEqual([routed.state.counters.subagentWaits, routed.state.counters.quietStops], [0, 0], 'a verdict routed is work');
});

test('subagent-running: a new verdict request in the same phase resets the waits (claim-again in final-verify)', () => {
  let s = mk({ phase: 'final-verify', verdictRequestId: 'R1', verdictRequestedAt: T, verdictLenses: ['general'], flags: { cleanedOnce: true } });
  const verifier = [task('pf-verifier')];
  for (let i = 0; i < MAX_SUBAGENT_WAITS; i++) s = run(s, { planText: PLAN_DONE, backgroundTasks: verifier }, { now: T + i }).state;
  assert.equal(s.counters.subagentWaits, MAX_SUBAGENT_WAITS);
  // the main agent claims done again: a new request in the same phase
  s = { ...s, signals: { ...s.signals, claimedDone: true } };
  const claim = run(s, { planText: PLAN_DONE, backgroundTasks: verifier }, { now: T + 100 });
  assert.equal(claim.outcome, 'claim-again');
  assert.equal(claim.state.phase, 'final-verify');
  assert.notEqual(claim.state.verdictRequestId, 'R1');
  assert.equal(claim.state.counters.subagentWaits, 0, 'the waits belong to the request');
  const wait = run(claim.state, { planText: PLAN_DONE, backgroundTasks: verifier }, { now: T + 200 });
  assert.equal(wait.outcome, 'subagent-running');
});

test('subagent-running: the run that gave 9 continuations without work now has 3 waits and no more (was 3+3)', () => {
  // review with a stuck reviewer, the tree never changing, no test, no verdict: the reviewer
  // is still running when the loop moves to implement (where it is not the phase's role)
  let s = mk({ phase: 'review', verdictRequestId: 'R1', verdictRequestedAt: T, tree: { fingerprint: 'TA', iteration: 0 } });
  const outcomes = [];
  const quiet = [];
  for (let i = 0; i < 9; i++) {
    const r = run(s, { planText: PLAN, fingerprint: 'TA', backgroundTasks: [task('pf-reviewer'), task('pf-verifier')] }, { now: T + 1000 * (i + 1) });
    outcomes.push(r.outcome);
    quiet.push(r.state.counters.quietStops);
    s = r.state;
  }
  assert.deepEqual(outcomes.slice(0, 6), ['subagent-running', 'subagent-running', 'subagent-running', 'missing', 'missing-twice', 'idle'], outcomes.join(','));
  assert.equal(outcomes.filter((o) => o === 'subagent-running').length, 3, outcomes.join(','));
  assert.deepEqual(quiet.slice(0, 6), [1, 2, 3, 4, 5, 6], 'nothing but work resets the count');
  // past the cap no wait for the right role either, until work is done
  const later = run(mk({ phase: 'review', verdictRequestId: 'R2', counters: { quietStops: 6 }, tree: { fingerprint: 'TA', iteration: 0 } }), { fingerprint: 'TA', backgroundTasks: RUNNING });
  assert.equal(later.outcome, 'missing');
  const worked = run(mk({ phase: 'review', verdictRequestId: 'R2', counters: { quietStops: 6 }, tree: { fingerprint: 'TA', iteration: 0 } }), { fingerprint: 'TB', backgroundTasks: RUNNING });
  assert.equal(worked.outcome, 'subagent-running', 'a changed tree is work: waits are allowed again');
  assert.equal(worked.state.counters.quietStops, 0, 'the wait itself follows work: the run without work starts over');
});

test('subagent-running: what counts as work since the previous stop', () => {
  const base = { phase: 'review', verdictRequestId: 'R1', verdictRequestedAt: T, counters: { quietStops: 4 }, tree: { fingerprint: 'TA', iteration: 0 }, owner: { sessionId: 'sess-1', lastFireAt: T } };
  const quietAfter = (over, c) => run(mk({ ...base, ...over }), { fingerprint: 'TA', ...c }, { now: T + 5000 }).state.counters.quietStops;
  assert.equal(quietAfter({}, {}), 5, 'nothing: one more');
  assert.equal(quietAfter({}, { fingerprint: 'TB' }), 0, 'the tree changed');
  assert.equal(quietAfter({}, { fingerprint: null }), 5, 'an unknown tree is no evidence');
  assert.equal(quietAfter({ lastTest: { cmd: 'x', exitCode: 1, iteration: 0, at: new Date(T + 1000).toISOString() } }, {}), 0, 'a suite run recorded since');
  assert.equal(quietAfter({ lastTest: { cmd: 'x', exitCode: 1, iteration: 0, at: new Date(T - 1000).toISOString() } }, {}), 5, 'a run from before the previous stop');
  assert.equal(quietAfter({ signals: { lastReport: 'fail' } }, {}), 0, 'a report routed');
  assert.equal(quietAfter({}, { artifacts: { review: JSON.stringify({ requestId: 'R1', blocking: 1 }) } }), 0, 'a verdict routed');
  assert.equal(quietAfter({}, { artifacts: { review: '{bad' } }), 5, 'an unreadable verdict is no verdict');
  assert.equal(quietAfter({ phase: 'implement', signals: { claimedDone: true } }, { planText: PLAN }), 0, 'a claim');
  // a stop that lets Claude stop ends the run
  assert.equal(quietAfter({ signals: { paused: true } }, {}), 0);
});

test('subagent-running: the cap on quiet stops in a row refuses a wait even with waits left', () => {
  assert.equal(MAX_QUIET_STOPS, 5);
  const capped = run(mk({ phase: 'review', counters: { quietStops: MAX_QUIET_STOPS } }), { backgroundTasks: RUNNING });
  assert.equal(capped.outcome, 'missing');
  assert.equal(run(mk({ phase: 'review', counters: { quietStops: MAX_QUIET_STOPS - 1 } }), { backgroundTasks: RUNNING }).outcome, 'subagent-running');
  assert.equal(normalizeState({ phase: 'review', counters: { quietStops: '-3' } }).counters.quietStops, 0);
});

test('subagent-running: a wait does not move the reference tree (the changes of the executor are not an idle step)', () => {
  const s = mk({ phase: 'implement', tree: { fingerprint: 'TA', iteration: 2 }, counters: { iterations: 2 } });
  const wait = run(s, { planText: PLAN, fingerprint: 'TB', codeFingerprint: 'cb', backgroundTasks: [task('perseveranza:pf-executor')] });
  assert.equal(wait.outcome, 'subagent-running');
  assert.deepEqual(wait.state.tree, { fingerprint: 'TA', iteration: 2 });
  assert.equal(wait.state.counters.iterations, 2);
  const next = run(wait.state, { planText: PLAN, fingerprint: 'TB', codeFingerprint: 'cb' });
  assert.equal(next.outcome, 'always', 'the step was implemented while the turn waited');
  assert.equal(next.state.phase, 'review');
  // a test run in the iteration before the wait still counts as this iteration's
  const tested = mk({ phase: 'implement', tree: { fingerprint: 'TB', iteration: 2 }, counters: { iterations: 2 }, lastTest: { cmd: 'x', exitCode: 0, iteration: 2, fingerprint: 'TB' } });
  const w2 = run(tested, { planText: PLAN, fingerprint: 'TB', backgroundTasks: [task('pf-executor')] });
  assert.equal(run(w2.state, { planText: PLAN, fingerprint: 'TB' }).outcome, 'always', 'ranTest still holds after a wait');
});

test('subagent-running: a wait consumes and moves no verdict file (a judge may be rewriting it)', () => {
  const review = mk({ phase: 'review', verdictRequestId: 'R1', verdictRequestedAt: T, counters: { iterations: 3 } });
  for (const text of ['{"blocking": 0, "findings": [', JSON.stringify({ requestId: 'R0', blocking: 0 })]) {
    const r = run(review, { backgroundTasks: RUNNING, artifacts: { review: text } });
    assert.equal(r.outcome, 'subagent-running');
    assert.ok(!r.effects.some((e) => ['keepArtifact', 'dropArtifact', 'writeArtifact'].includes(e.type)), JSON.stringify(r.effects));
    assert.ok(!journal(r).some((j) => j.type === 'verdict'));
    assert.ok(journal(r).some((j) => j.type === 'note' && j.text.includes('left in place') && j.text.includes('review.json')));
  }
  const fv = mk({ phase: 'final-verify', verdictLenses: ['correctness', 'security'], verdictRequestId: 'R1', verdictRequestedAt: T });
  const r = run(fv, { planText: PLAN_DONE, backgroundTasks: [task('pf-verifier')], artifacts: { verify: '{"pass":', verifyLenses: { security: JSON.stringify({ requestId: 'R0', pass: true }) } } });
  assert.equal(r.outcome, 'subagent-running');
  assert.ok(!r.effects.some((e) => ['keepArtifact', 'dropArtifact', 'writeArtifact'].includes(e.type)), JSON.stringify(r.effects));
  // without a subagent running the same files are read (and set aside) as before
  assert.ok(run(review, { artifacts: { review: '{"blocking": 0, "findings": [' } }).effects.some((e) => e.type === 'keepArtifact'));
});

test('subagent-running: a verdict, a report or a claim decide even with a subagent running', () => {
  const review = mk({ phase: 'review', verdictRequestId: 'R1', verdictRequestedAt: T });
  assert.equal(run(review, { backgroundTasks: RUNNING, artifacts: { review: JSON.stringify({ requestId: 'R1', blocking: 0 }) } }).outcome, 'pass');
  assert.equal(run(mk({ phase: 'review', signals: { lastReport: 'fail' } }), { backgroundTasks: RUNNING }).outcome, 'fail');
  assert.equal(run(mk({ phase: 'final-verify', verdictRequestId: 'R1', verdictLenses: ['general'] }), { planText: PLAN_DONE, backgroundTasks: RUNNING, artifacts: { verify: JSON.stringify({ requestId: 'R1', pass: false }) } }).outcome, 'fail');
  assert.equal(run(mk({ phase: 'implement', signals: { claimedDone: true } }), { planText: PLAN_DONE, backgroundTasks: [task('pf-executor')] }).outcome, 'claim-first');
  // a malformed verdict is no verdict: the judge may still be rewriting it
  assert.equal(run(review, { backgroundTasks: RUNNING, artifacts: { review: '{bad' } }).outcome, 'subagent-running');
  // implement waits even over a stray report (implement ignores reports)
  assert.equal(run(mk({ phase: 'implement', signals: { lastReport: 'pass' } }), { planText: PLAN, backgroundTasks: [task('pf-executor')] }).outcome, 'subagent-running');
});

test('subagent-running: a lens round stays open while a verifier still runs (no file consumed, no merge)', () => {
  const s = mk({ phase: 'final-verify', verdictLenses: ['correctness', 'security', 'tests'], verdictRequestId: 'R1', verdictRequestedAt: T, counters: { iterations: 7 } });
  const lens = (l) => JSON.stringify({ requestId: 'R1', lens: l, pass: true, findings: [] });
  const r = run(s, { planText: PLAN_DONE, backgroundTasks: [task('pf-verifier')], artifacts: { verifyLenses: { correctness: lens('correctness') } } }, { now: T + 1000 });
  assert.equal(r.outcome, 'subagent-running');
  assert.ok(!r.effects.some((e) => e.type === 'keepArtifact' || e.type === 'writeArtifact'), JSON.stringify(r.effects.map((e) => e.type)));
  // the next stop, every lens on disk: the round passes as usual
  const done = run(r.state, { planText: PLAN_DONE, backgroundTasks: [], artifacts: { verifyLenses: { correctness: lens('correctness'), security: lens('security'), tests: lens('tests') } } }, { now: T + 2000 });
  assert.equal(done.outcome, 'pass');
});

test('subagent-running: the counter is normalized like the others (additive field)', () => {
  assert.equal(normalizeState({ phase: 'review' }).counters.subagentWaits, 0);
  assert.equal(normalizeState({ phase: 'review', counters: { subagentWaits: '2' } }).counters.subagentWaits, 2);
  assert.equal(normalizeState({ phase: 'review', counters: { subagentWaits: -4 } }).counters.subagentWaits, 0);
  assert.equal(normalizeState({ phase: 'review', counters: { subagentWaits: 'x' } }).counters.subagentWaits, 0);
  // a state written before the field: a running subagent waits from 1
  const old = normalizeState({ phase: 'review', counters: { iterations: 2, retries: 0, finalFails: 0, staleGates: 0 } });
  assert.equal(run(old, { backgroundTasks: RUNNING }).state.counters.subagentWaits, 1);
});

test('subagent-running: the prompt exists in both languages with its placeholders', () => {
  for (const prompts of [DEFAULT_PROMPTS, IT]) {
    for (const v of ['phase', 'agents', 'waits', 'maxWaits']) assert.ok(prompts['subagent-running'].includes(`{{${v}}}`), v);
  }
  const it = run(mk({ phase: 'review' }), { backgroundTasks: RUNNING, overrides: [IT] });
  assert.ok(it.reason.includes('FASE: review (un subagent sta ancora lavorando)'), it.reason);
});

// ---------------------------------------------------------------- usage measured by the mod
const tok = (i, o, cr = 0, cc = 0) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheCreationTokens: cc });

test('normalizeUsage source mod: the totals are at least the sum by agent; past the cap the rest is folded, never dropped', () => {
  const u = normalizeUsage({ source: 'mod', byAgent: { main: tok(10, 5), a1: tok(100, 50, 7) } });
  assert.deepEqual([u.inputTokens, u.outputTokens, u.cacheReadTokens], [110, 55, 7]);
  assert.equal(tokensSpent(u), 165);
  // declared totals above the sum are kept (never undercount)
  assert.equal(normalizeUsage({ source: 'mod', inputTokens: 1000, byAgent: { main: tok(10, 5) } }).inputTokens, 1000);
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`agent-${i}`, tok(i + 1, 1)]));
  const big = normalizeUsage({ source: 'mod', byAgent: { main: tok(1, 1), ...many } });
  assert.equal(Object.keys(big.byAgent).length, 16);
  assert.ok(big.byAgent.main && big.byAgent.other);
  const sumIn = Object.values(big.byAgent).reduce((a, v) => a + v.inputTokens, 0);
  assert.equal(sumIn, 1 + (30 * 31) / 2, 'every token still counted');
  assert.equal(big.inputTokens, sumIn);
  assert.ok(big.byAgent['agent-29'] && !big.byAgent['agent-0'], 'the biggest spenders keep their row');
  // the other sources keep their reading as before
  assert.equal(normalizeUsage({ source: 'transcript+subagents', inputTokens: 5, byAgent: { main: tok(1, 1) } }).inputTokens, 5);
});

test('mergeModUsage: deltas accumulate per agent, a reading of another source becomes main, garbage is ignored', () => {
  let u = mergeModUsage(null, { main: tok(10, 1), a1: tok(5, 5, 2) });
  assert.equal(u.source, 'mod');
  assert.deepEqual(u.byAgent, { main: tok(10, 1), a1: tok(5, 5, 2) });
  assert.deepEqual(u.subagents, { files: 1, ...tok(5, 5, 2) });
  u = mergeModUsage(u, { a1: tok(1, 1), a2: tok(3, 0), bad: 'x', arr: [1] });
  assert.deepEqual(u.byAgent, { main: tok(10, 1), a1: tok(6, 6, 2), a2: tok(3, 0) });
  assert.equal(tokensSpent(u), 26);
  // from a transcript reading: what was already spent is the main row
  const t = mergeModUsage({ ...tok(1000, 100), source: 'transcript+subagents', byAgent: { main: tok(600, 60), 'pf-reviewer': tok(400, 40) } }, { a9: tok(1, 1) });
  assert.deepEqual(t.byAgent, { main: tok(1000, 100), a9: tok(1, 1) });
  assert.equal(tokensSpent(t), 1102);
  // hostile keys stay data
  const p = mergeModUsage(null, JSON.parse('{"__proto__": {"inputTokens": 3, "outputTokens": 0}}'));
  assert.equal(tokensSpent(p), 3);
  assert.equal(Object.getPrototypeOf(p.byAgent), Object.prototype);
  // an empty or missing delta is the reading unchanged
  assert.deepEqual(mergeModUsage(u, undefined).byAgent, u.byAgent);
});

test('the token budget counts every agent of a mod reading', () => {
  const s = mk({ phase: 'implement', limits: { maxTokens: 1000 } });
  const usage = { source: 'mod', byAgent: { main: tok(100, 10), 'a-reviewer': tok(800, 200) } };
  assert.equal(canContinue(normalizeState({ ...s, usage: normalizeUsage(usage) })).ok, false);
  const r = run(s, { planText: PLAN, usage });
  assert.equal(r.outcome, 'budget');
  assert.equal(r.state.usage.source, 'mod');
  const j = journal(r).find((e) => e.type === 'usage');
  assert.deepEqual([j.spent, j.source], [1110, 'mod']);
  assert.equal(run(s, { planText: PLAN, usage: { source: 'mod', byAgent: { main: tok(100, 10) } } }).outcome, 'always');
});

test('status shows the mod reading and its split by agent', () => {
  const s = normalizeState({ phase: 'implement', task: 't', usage: mergeModUsage(null, { main: tok(2000, 100), a1b2c3: tok(9000, 900) }) });
  const out = summary(s, PLAN);
  assert.ok(out.includes('(measured by the mod, every agent)'), out);
  assert.ok(/by agent:\s+a1b2c3 .*, main /.test(out), out);
});

// ---------------------------------------------------------------- routeModel
test('routeModel: reviewer, verifier and executor by complexity, with or without the prefix; null otherwise', () => {
  for (const c of ['low', 'medium', 'high']) {
    const s = mk({ complexity: c });
    assert.equal(routeModel(s, 'pf-reviewer'), MODEL_ROUTING.review[c]);
    assert.equal(routeModel(s, 'perseveranza:pf-reviewer'), MODEL_ROUTING.review[c]);
    assert.equal(routeModel(s, 'pf-verifier'), MODEL_ROUTING.verify[c]);
    assert.equal(routeModel(s, 'perseveranza:pf-verifier'), MODEL_ROUTING.verify[c]);
    assert.equal(routeModel(s, 'perseveranza:pf-executor'), MODEL_ROUTING.execute[c]);
    for (const other of ['pf-advisor', 'general-purpose', 'oh-my-claudecode:executor', '', null]) assert.equal(routeModel(s, other), null, String(other));
  }
  assert.deepEqual(['low', 'medium', 'high'].map((c) => routeModel(mk({ complexity: c }), 'pf-reviewer')), ['haiku', 'sonnet', 'opus']);
  assert.deepEqual(['low', 'medium', 'high'].map((c) => routeModel(mk({ complexity: c }), 'pf-verifier')), ['sonnet', 'opus', 'opus']);
  assert.equal(routeModel(mk({ complexity: 'high' }), 'pf-executor'), 'opus');
  // unknown complexity or no state: medium
  assert.equal(routeModel({ complexity: 'weird' }, 'pf-reviewer'), 'sonnet');
  assert.equal(routeModel(null, 'pf-verifier'), 'opus');
});

// ---------------------------------------------------------------- subagentVerdictCheck
const reviewState = mk({ phase: 'review', verdictRequestId: 'R1', verdictRequestedAt: T });
const rv = (o) => JSON.stringify({ requestId: 'R1', blocking: 0, findings: [], ...o });
const vf = (o) => JSON.stringify({ requestId: 'R1', pass: true, findings: [], ...o });

test('subagentVerdictCheck: the reviewer, verdict absent / malformed / stale / valid', () => {
  for (const type of ['pf-reviewer', 'perseveranza:pf-reviewer']) {
    assert.deepEqual(subagentVerdictCheck(reviewState, type, {}), { ok: false, reason: 'missing', file: 'review.json' });
    assert.deepEqual(subagentVerdictCheck(reviewState, type, { review: rv() }), { ok: true, reason: 'valid', file: 'review.json' });
  }
  const bad = subagentVerdictCheck(reviewState, 'pf-reviewer', { review: '{"blocking":"two"}' });
  assert.equal(bad.ok, false);
  assert.ok(bad.reason.startsWith('malformed: blocking must be'), bad.reason);
  assert.equal(subagentVerdictCheck(reviewState, 'pf-reviewer', { review: '' }).reason, 'malformed: empty');
  assert.deepEqual(subagentVerdictCheck(reviewState, 'pf-reviewer', { review: rv({ requestId: 'R0' }) }), { ok: false, reason: 'stale', file: 'review.json' });
  assert.equal(subagentVerdictCheck(reviewState, 'pf-reviewer', { review: rv({ requestId: '"R1".' }) }).ok, true, 'an id copied with quotes is the same id');
  // without an id: the file clock decides, with one second of tolerance
  const noId = JSON.stringify({ blocking: 1 });
  assert.equal(subagentVerdictCheck(reviewState, 'pf-reviewer', { review: noId }, { artifactAt: { review: T - 5000 } }).reason, 'stale');
  assert.equal(subagentVerdictCheck(reviewState, 'pf-reviewer', { review: noId }, { artifactAt: { review: T - 500 } }).ok, true);
  assert.equal(subagentVerdictCheck(reviewState, 'pf-reviewer', { review: noId }).ok, true, 'no clock known: read like the machine');
});

test('subagentVerdictCheck: askedTimes lets go at the limit; other agents and other phases are not its business', () => {
  assert.equal(MAX_VERDICT_ASKS, 2);
  assert.equal(subagentVerdictCheck(reviewState, 'pf-reviewer', {}, { askedTimes: 1 }).ok, false);
  assert.deepEqual(subagentVerdictCheck(reviewState, 'pf-reviewer', {}, { askedTimes: 2 }), { ok: true, reason: 'asked-enough: missing', file: 'review.json' });
  assert.equal(subagentVerdictCheck(reviewState, 'pf-reviewer', { review: rv({ requestId: 'R0' }) }, { askedTimes: 5 }).reason, 'asked-enough: stale');
  for (const type of ['pf-executor', 'perseveranza:pf-advisor', 'general-purpose', '', undefined]) assert.deepEqual(subagentVerdictCheck(reviewState, type, {}), { ok: true, reason: 'not-a-judge', file: null });
  assert.equal(subagentVerdictCheck(mk({ phase: 'implement' }), 'pf-reviewer', {}).reason, 'not-awaited');
  assert.equal(subagentVerdictCheck(reviewState, 'pf-verifier', {}).reason, 'not-awaited');
  assert.equal(subagentVerdictCheck(null, 'pf-reviewer', null).reason, 'not-awaited');
  // no request id (a v1 state): nothing to bind a verdict to, never a block with an empty id
  assert.deepEqual(subagentVerdictCheck(mk({ phase: 'review' }), 'pf-reviewer', {}), { ok: true, reason: 'no-request', file: null });
  assert.deepEqual(subagentVerdictCheck(mk({ phase: 'final-verify' }), 'pf-verifier', { verify: '{x' }), { ok: true, reason: 'no-request', file: null });
});

test('subagentVerdictCheck: the single verifier (verify.json, or verify-general.json)', () => {
  const s = mk({ phase: 'final-verify', verdictLenses: ['general'], verdictRequestId: 'R1', verdictRequestedAt: T });
  assert.deepEqual(subagentVerdictCheck(s, 'pf-verifier', {}), { ok: false, reason: 'missing', file: 'verify.json' });
  assert.deepEqual(subagentVerdictCheck(s, 'perseveranza:pf-verifier', { verify: vf({ pass: false }) }), { ok: true, reason: 'valid', file: 'verify.json' });
  assert.deepEqual(subagentVerdictCheck(s, 'pf-verifier', { verifyLenses: { general: vf() } }), { ok: true, reason: 'valid', file: 'verify-general.json' });
  assert.deepEqual(subagentVerdictCheck(s, 'pf-verifier', { verify: '{"pass":"yes"}' }), { ok: false, reason: 'malformed: pass must be a boolean (got "yes")', file: 'verify.json' });
  assert.equal(subagentVerdictCheck(s, 'pf-verifier', { verify: vf({ requestId: 'R0' }) }).reason, 'stale');
  // a state from before the lenses: the single verifier
  assert.equal(subagentVerdictCheck(mk({ phase: 'final-verify', verdictRequestId: 'R1' }), 'pf-verifier', { verify: vf() }).ok, true);
});

test('subagentVerdictCheck: a round by lenses, with and without the lens of the verifier', () => {
  const s = mk({ phase: 'final-verify', verdictLenses: ['correctness', 'security', 'tests'], verdictRequestId: 'R1', verdictRequestedAt: T });
  const lens = (l, o) => vf({ lens: l, ...o });
  // the caller knows the lens
  assert.deepEqual(subagentVerdictCheck(s, 'pf-verifier', { verifyLenses: { security: lens('security') } }, { lens: 'security' }), { ok: true, reason: 'valid', file: 'verify-security.json' });
  assert.deepEqual(subagentVerdictCheck(s, 'pf-verifier', { verifyLenses: { correctness: lens('correctness') } }, { lens: 'security' }), { ok: false, reason: 'missing', file: 'verify-security.json' });
  assert.equal(subagentVerdictCheck(s, 'pf-verifier', { verifyLenses: { security: lens('security', { requestId: 'R0' }) } }, { lens: 'security' }).reason, 'stale');
  // verify.json covers a lens that wrote no file, not one whose file is wrong
  assert.equal(subagentVerdictCheck(s, 'pf-verifier', { verify: vf() }, { lens: 'tests' }).file, 'verify.json');
  assert.equal(subagentVerdictCheck(s, 'pf-verifier', { verify: vf(), verifyLenses: { tests: '{x' } }, { lens: 'tests' }).ok, false);
  // without the lens: any valid file of the round lets it go; otherwise the most telling problem
  assert.equal(subagentVerdictCheck(s, 'pf-verifier', { verifyLenses: { tests: lens('tests') } }).ok, true);
  assert.deepEqual(subagentVerdictCheck(s, 'pf-verifier', {}), { ok: false, reason: 'missing', file: 'verify-correctness.json' });
  const r = subagentVerdictCheck(s, 'pf-verifier', { verifyLenses: { security: '{"pass": 1}' } });
  assert.deepEqual([r.ok, r.file], [false, 'verify-security.json']);
  assert.ok(r.reason.startsWith('malformed'), r.reason);
  // a lens the round did not ask for is no verdict of this round
  assert.equal(subagentVerdictCheck(s, 'pf-verifier', { verifyLenses: { general: lens('general') } }).ok, false);
});

test('src/core has no node: import (the mod imports it and has no Node API)', () => {
  for (const f of ['subagents.mjs', 'machine.mjs', 'state.mjs', 'prompts.mjs', 'transitions.mjs', 'budget.mjs', 'verdicts.mjs', 'plan.mjs', 'staleness.mjs', 'time.mjs']) {
    const text = readFileSync(join(ROOT, 'src', 'core', f), 'utf8');
    assert.ok(!/from\s+['"]node:|require\(|import\(['"]node:/.test(text), f);
  }
});

// ---------------------------------------------------------------- the verbs as the mod's tool
const SHELLISH = /node |perseveranza.mjs/;
// tool mode still names the CLI for what the tool does not run (test, ask), as a Bash command:
// those mentions taken out, nothing of the shell may remain
const withoutBash = (text, layers = []) => String(text)
  .replaceAll(`${renderPrompt('loop-bash', {}, layers)} ${LOOP} test`, '<BASH test>')
  .replaceAll(`${renderPrompt('loop-bash', {}, layers)} ${LOOP} ask`, '<BASH ask>')
  .replaceAll(`| ${LOOP} ask`, '| <BASH ask>');

test('loopVar: shell by default, the tool in tool mode, worded by the pack', () => {
  assert.equal(loopVar(undefined, LOOP), LOOP);
  assert.equal(loopVar('shell', LOOP), LOOP);
  assert.equal(loopVar('weird', LOOP), LOOP);
  assert.equal(loopVar('tool', LOOP), 'the `perseveranza` tool ({"verb": "<the first word>", "args": "<the words after it, if any>"}):');
  assert.equal(loopVar('tool', LOOP, [IT]), 'lo strumento `perseveranza` ({"verb": "<la prima parola>", "args": "<le parole dopo, se ci sono>"}):');
  assert.equal(renderPrompt('review-missing-outcome', { LOOP: loopVar('tool', LOOP) }).includes('"<the words after it, if any>"}): report pass'), true);
});

test('tool mode: no prompt, in either language, contains a shell command of the verbs but test and ask sent to Bash', () => {
  for (const layers of [[], [IT]]) {
    const L = loopVar('tool', LOOP, layers);
    for (const key of PROMPT_KEYS) {
      if (key === 'hint-ask') continue; // the CLI in both modes: the machine puts the Bash words before it
      const text = renderPrompt(key, { LOOP: L, USER: '/pf', testRun: `${renderPrompt('loop-bash', {}, layers)} ${LOOP} test --if-needed -- npm test` }, layers);
      assert.ok(!SHELLISH.test(withoutBash(text, layers)), `${key}: ${text}`);
    }
  }
});

test('tool mode: the machine renders every phase with the tool, never node or perseveranza.mjs', () => {
  const R = { verdictRequestId: 'R1', verdictRequestedAt: T };
  const cases = [
    [mk(), { planExists: false }],
    [mk({ options: { externals: ['codex'] } }), { planExists: false }],
    [mk({ options: { approvePlan: true } }), { planExists: true, planText: PLAN }],
    [mk(), { planExists: true, planText: PLAN }],
    [mk({ phase: 'implement', complexity: 'high', options: { testCmd: 'npm test' } }), { planText: PLAN, fingerprint: 'f' }],
    [mk({ phase: 'review', ...R }), {}],
    [mk({ phase: 'review', ...R, counters: { retries: 1 }, options: { externals: ['codex'] } }), { artifacts: { review: rv({ blocking: 1 }) } }],
    [mk({ phase: 'review', ...R }), { artifacts: { review: rv() }, planText: PLAN }],
    [mk({ phase: 'review', ...R }), { backgroundTasks: RUNNING }],
    [mk({ phase: 'implement', signals: { claimedDone: true } }), { planText: PLAN }],
    [mk({ phase: 'implement', signals: { claimedDone: true }, options: { testCmd: 'npm test' } }), { planText: PLAN_DONE }],
    [mk({ phase: 'implement', signals: { claimedDone: true } }), { planText: PLAN_DONE }],
    [mk({ phase: 'cleanup', options: { externals: ['codex'] } }), { planText: PLAN_DONE }],
    [mk({ phase: 'cleanup', complexity: 'high' }), { planText: PLAN_DONE }],
    [mk({ phase: 'final-verify', ...R, verdictLenses: ['general'] }), { planText: PLAN_DONE }],
    [mk({ phase: 'final-verify', ...R, verdictLenses: ['correctness', 'security'] }), { planText: PLAN_DONE }],
    [mk({ phase: 'final-verify', ...R, verdictLenses: ['general'], counters: { finalFails: 1 } }), { planText: PLAN_DONE, artifacts: { verify: vf({ pass: false }) } }],
    [mk({ phase: 'review', signals: { interrupted: { at: 'x', silentMs: 1, phase: 'review', pending: [] } } }), {}],
    [mk({ phase: 'review', signals: { interrupted: { at: 'x', silentMs: 1, phase: 'review', pending: [] } } }), { artifacts: { reconcile: '{"disposition":"partial"}' } }],
  ];
  for (const layers of [[], [IT]]) {
    const tool = loopVar('tool', LOOP, layers);
    for (const [s, c] of cases) {
      const r = run(s, { ...c, overrides: layers, loopMode: 'tool' }, { now: T + 1000 });
      if (!r.blocked) continue;
      assert.ok(!SHELLISH.test(withoutBash(r.reason, layers)), `${r.outcome}: ${r.reason}`);
      if (/LOOP/.test(JSON.stringify(DEFAULT_PROMPTS[journal(r).find((j) => j.type === 'transition')?.prompt] || ''))) assert.ok(r.reason.includes(tool), `${r.outcome}: ${r.reason}`);
    }
    // the external models: never the tool, a shell command for Bash (its stdin form too)
    const ext = run(mk({ options: { externals: ['codex'] } }), { planExists: false, overrides: layers, loopMode: 'tool' });
    assert.ok(ext.reason.includes(`${renderPrompt('loop-bash', {}, layers)} ${LOOP} ask <provider> plan`), ext.reason);
    assert.ok(!ext.reason.includes(`${tool} ask`), ext.reason);
  }
  // shell mode (the default) is the shell command as before
  const shell = run(mk(), { planExists: false });
  assert.ok(shell.reason.includes(`${LOOP} complexity low|medium|high`));
});

test('tool mode: the session notices take the tool wording too (the mod renders them with loopVar)', () => {
  for (const layers of [[], [IT]]) {
    const L = loopVar('tool', LOOP, layers);
    const s = normalizeState({ phase: 'review', task: 't', owner: { sessionId: 'other-session', lastFireAt: T } });
    for (const text of [
      sessionNotice(s, { now: T + 10 * 3600_000, sessionId: 'me', LOOP: L, USER: '/pf', layers }),
      sessionNotice(normalizeState({ ...s, signals: { paused: true } }), { now: T + 60_000, sessionId: 'me', LOOP: L, USER: '/pf', layers }),
      compactNotice(s, { LOOP: L, USER: '/pf', layers }),
      restorePrompt(s, { silentMs: 1000, LOOP: L, layers }),
    ]) {
      assert.ok(text && !SHELLISH.test(text), text);
    }
  }
});

// ---------------------------------------------------------------- the bridge, in process
test('mod bridge handle(): never throws, every error is an answer', () => {
  assert.deepEqual(handle(null), { ok: false, error: 'request is not a JSON object' });
  assert.deepEqual(handle([]), { ok: false, error: 'request is not a JSON object' });
  assert.deepEqual(handle({ op: 'stop' }), { ok: false, error: 'cwd missing' });
  assert.equal(handle({ op: 'nope', cwd: tmpdir() }).ok, false);
  assert.ok(handle({ op: 'nope', cwd: tmpdir() }).error.includes('unknown op'));
  // a fact that throws when read: an answer, not a crash
  const dir = mkdtempSync(join(tmpdir(), 'prs-bridge-'));
  try {
    const hostile = { op: 'stop', cwd: dir, get facts() { throw new Error('boom'); } };
    assert.deepEqual(handle(hostile), { ok: false, error: 'boom' });
    assert.deepEqual(handle({ op: 'usage-flush', cwd: dir, facts: { usage: { byAgent: { main: { inputTokens: 1 } } } } }), { ok: false, error: 'no-loop' });
    assert.ok(!existsSync(join(dir, '.perseveranza')), 'a flush with no loop creates nothing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- the Stop's merge of the verbs
test('mergeVerbFields: a verb-owned field changed on disk since the start wins; the rest is the Stop\'s', () => {
  const start = normalizeState(defaultState({ task: 't' }));
  const ours = JSON.parse(JSON.stringify(start));
  ours.phase = 'implement';
  ours.counters.iterations = 4;
  ours.signals.lastReport = 'none'; // the Stop consumed a report
  ours.usage.inputTokens = 900;
  const disk = JSON.parse(JSON.stringify(start));
  disk.signals.claimedDone = true; // claim-done meanwhile
  disk.lastTest = { cmd: 'npm test', exitCode: 0 }; // the test verb meanwhile
  disk.counters.iterations = 0; // not a verb's field: the Stop's value stays
  disk.usage.inputTokens = 1; // not a verb's field
  const m = mergeVerbFields(ours, start, disk);
  assert.deepEqual(m.taken.sort(), ['lastTest', 'signals.claimedDone']);
  assert.equal(m.state.signals.claimedDone, true);
  assert.deepEqual(m.state.lastTest, { cmd: 'npm test', exitCode: 0 });
  assert.deepEqual([m.state.phase, m.state.counters.iterations, m.state.usage.inputTokens, m.state.signals.lastReport], ['implement', 4, 900, 'none']);
  // nothing changed on disk: ours untouched (the Stop's consumption of a report stands)
  const same = mergeVerbFields(ours, start, JSON.parse(JSON.stringify(start)));
  assert.deepEqual(same.taken, []);
  assert.deepEqual(same.state, ours);
  // a new report written while the Stop consumed the old one: the new one stays
  const again = JSON.parse(JSON.stringify(start));
  again.signals.lastReport = 'fail';
  assert.equal(mergeVerbFields(ours, start, again).state.signals.lastReport, 'fail');
  // odd input never throws, never drops ours
  for (const bad of [null, 'x', 42, []]) assert.deepEqual(mergeVerbFields(ours, start, bad).state.phase, 'implement');
  assert.deepEqual(mergeVerbFields(ours, null, disk).taken, []);
  // every owned path is one a verb or the watchdog writes, never usage or the phase
  assert.ok(!VERB_OWNED.some((p) => /^(usage|phase|usageInboxSeen|rev|counters\.iterations)/.test(p)));
});

test('rev: a counter of saves, normalized to a non-negative integer', () => {
  for (const [v, want] of [[undefined, 0], [-3, 0], ['7', 7], [2.9, 2], [NaN, 0], [12, 12]]) {
    assert.equal(normalizeState({ ...defaultState({ task: 't' }), rev: v }).rev, want, String(v));
  }
});


test('runningLoopAgents: hostile entries (a status that is not a string, an entry that is not an object) are ignored, never thrown on', () => {
  const tasks = [
    { status: { toString: 1 }, agent_type: 'pf-executor' },
    { status: { toString: () => 'running' }, agent_type: 'pf-executor' },
    { status: 1, agent_type: 'pf-executor' },
    { status: null, agent_type: 'pf-executor' },
    { status: ['running'], agent_type: 'pf-executor' },
    ['running'],
    'running',
    7,
    null,
    { status: 'running', agent_type: { toString: 1 }, description: { toString: 1 } },
    { status: 'RUNNING', agent_type: 'pf-reviewer', description: 'ok' },
  ];
  assert.deepEqual(runningLoopAgents(tasks), [{ agent: 'pf-reviewer', description: 'ok' }]);
});

// ---------------------------------------------------------------- the wait for a running subagent
test('PERSEVERANZA_SUBAGENT_WAIT_MS: a whole number of ms, 0 turns the wait off, anything else the default', () => {
  assert.equal(DEFAULT_SUBAGENT_WAIT_MS, 30000);
  for (const [raw, ms] of [[undefined, 30000], ['', 30000], ['0', 0], [' 0 ', 0], ['1200', 1200], ['-5', 30000], ['1.5', 30000], ['abc', 30000], ['99999999', 30000]]) {
    assert.equal(subagentWaitMs(raw === undefined ? {} : { PERSEVERANZA_SUBAGENT_WAIT_MS: raw }), ms, String(raw));
  }
});

test('waitForSubagent: a new verdict file ends the wait, an old one does not; the subagent\'s return too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prs-wait-'));
  try {
    let t = 1000;
    const clock = { now: () => t, sleep: (ms) => { t += ms; } };
    // nothing happens: the whole budget, then nothing landed
    assert.deepEqual(waitForSubagent(dir, 'review', 2000, clock), { waitedMs: 2000, landed: null, returned: false });
    // the verdict written during the wait (after the first poll)
    let polls = 0;
    const writing = { now: () => t, sleep: (ms) => { t += ms; if (++polls === 2) writeFileSync(join(dir, 'verify-security.json'), '{}'); } };
    const w = waitForSubagent(dir, 'final-verify', 10000, writing);
    assert.equal(w.landed, 'verify-security.json');
    assert.ok(w.waitedMs < 10000);
    // the same file again, unchanged: an old verdict, not a new one
    assert.equal(waitForSubagent(dir, 'final-verify', 2000, clock).landed, null);
    // an activity record of the subagent's return, dated after the start
    const at = t + 1;
    writeFileSync(join(dir, 'activity.json'), JSON.stringify({ at, event: 'subagent-stop', agent: 'perseveranza:pf-reviewer', pending: [] }));
    t = at - 1;
    const r = waitForSubagent(dir, 'review', 10000, clock);
    assert.equal(r.returned, true);
    // another agent's return does not count
    writeFileSync(join(dir, 'activity.json'), JSON.stringify({ at: t + 1, event: 'subagent-stop', agent: 'perseveranza:pf-executor', pending: [] }));
    assert.equal(waitForSubagent(dir, 'review', 2000, clock).returned, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
