// The Stop's real-time wait for a pf-* subagent (src/shell/stop-core.mjs), run in process with a
// fake clock (io.wait): what lands, or comes back, at a known poll of the wait. When the wait
// ends early the stop runs again from the disk, and the subagent that came back is no longer
// counted as running: the stop routes on its work, spending no wait and no quiet stop. In
// implement (no verdict file) the return is the only early end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, arm, writePlan, readState, patchState, journal, gate, writeFileSync, join } from '../helpers/cli.mjs';
import { runStopFromFacts, settleReturned, DEFAULT_SUBAGENT_WAIT_MS, SUBAGENT_POLL_MS } from '../../src/shell/stop-core.mjs';
import { MAX_SUBAGENT_WAITS } from '../../src/core/state.mjs';

const PLAN = '- [ ] one\n- [ ] two\n';
const task = (agent, status = 'running') => ({ id: `t-${agent}`, type: 'local_agent', status, agent_type: `perseveranza:${agent}`, description: `${agent} at work` });
// the default wait (30 s): the test's project turns it off, these tests want it as shipped
const envOf = (p) => { const env = { ...p.env }; delete env.PERSEVERANZA_SUBAGENT_WAIT_MS; return env; };
// a fake clock for the wait; at the `at`-th sleep it runs `act(t)` (the subagent's doing)
function clock(at, act) {
  let t = Date.now();
  let polls = 0;
  return { now: () => t, sleep: (ms) => { t += ms; polls += 1; if (act && polls === at) act(t); } };
}
const stopIn = (p, facts = {}, wait = undefined) => runStopFromFacts({ evt: { cwd: p.dir, session_id: 't-sess' }, env: envOf(p), facts, io: wait ? { wait } : {} });
const returned = (p, agent, t, pending = []) => writeFileSync(gate(p, 'activity.json'), JSON.stringify({ at: t, session: 't-sess', event: 'subagent-stop', tool: '', agent: `perseveranza:${agent}`, pending }));
const waits = (p) => journal(p).filter((j) => j.type === 'subagent-wait');
const outcomes = (p) => journal(p).filter((j) => j.type === 'transition').map((j) => j.outcome);

// a loop in implement, its tree recorded by the stop that got there
function inImplement() {
  const p = project({ git: true });
  arm(p, 'wait for the executor');
  assert.equal(stopIn(p).outcome, 'no-plan');
  writePlan(p, PLAN);
  assert.equal(stopIn(p).outcome, 'ready');
  assert.equal(readState(p).phase, 'implement');
  return p;
}

test('implement: the executor comes back during the wait with its work on disk: the stop goes on to review, no wait nor quiet stop spent', () => {
  const p = inImplement();
  const before = readState(p).counters;
  const r = stopIn(p, { backgroundTasks: [task('pf-executor')] }, clock(2, (t) => {
    writeFileSync(join(p.dir, 'hello.txt'), 'the step\n');
    returned(p, 'pf-executor', t);
  }));
  assert.equal(r.outcome, 'always', JSON.stringify(r));
  assert.ok(r.output && String(r.output.reason).includes('PHASE: code review'), JSON.stringify(r.output));
  const s = readState(p);
  assert.equal(s.phase, 'review');
  assert.equal(s.counters.subagentWaits, 0, 'no wait spent');
  assert.equal(s.counters.quietStops, 0, 'no quiet stop');
  assert.equal(s.counters.iterations, before.iterations + 1);
  const w = waits(p);
  assert.equal(w.length, 1, 'one wait per stop, the rerun does not wait again');
  assert.equal(w[0].returned, true);
  assert.equal(w[0].ms, 2 * SUBAGENT_POLL_MS, 'ended at the return');
  assert.ok(!outcomes(p).includes('subagent-running'), JSON.stringify(outcomes(p)));
});

test('implement: a return recorded before the wait (an earlier executor) does not end it: the whole window, then subagent-running', () => {
  const p = inImplement();
  // the record on disk when the stop starts: the previous executor came back a minute ago
  returned(p, 'pf-executor', Date.now() - 60_000);
  const r = stopIn(p, { backgroundTasks: [task('pf-executor')] }, clock(0));
  assert.equal(r.outcome, 'subagent-running', JSON.stringify(r));
  assert.equal(readState(p).counters.subagentWaits, 1);
  assert.deepEqual(waits(p).map((w) => [w.ms, !!w.returned]), [[30000, false]]);
});

test('implement: two executors, one comes back (the other still pending): the stop still waits for the other, as before', () => {
  const p = inImplement();
  const r = stopIn(p, { backgroundTasks: [task('pf-executor'), { ...task('pf-executor'), id: 't-2' }] }, clock(1, (t) => {
    returned(p, 'pf-executor', t, [{ at: t - 5, agent: 'perseveranza:pf-executor' }]);
  }));
  assert.equal(r.outcome, 'subagent-running', JSON.stringify(r));
  assert.equal(readState(p).counters.subagentWaits, 1);
  assert.equal(waits(p).length, 1);
});

test('implement: nothing comes back: the whole 30 s window, then subagent-running, three times at most (the timeout exit as before)', () => {
  const p = inImplement();
  assert.equal(DEFAULT_SUBAGENT_WAIT_MS, 30000);
  for (let i = 1; i <= MAX_SUBAGENT_WAITS; i++) {
    const r = stopIn(p, { backgroundTasks: [task('pf-executor')] }, clock(0));
    assert.equal(r.outcome, 'subagent-running', `${i}: ${JSON.stringify(r)}`);
    assert.equal(readState(p).counters.subagentWaits, i);
    assert.ok(String(r.output.reason).includes(`${i}/${MAX_SUBAGENT_WAITS}`), r.output.reason);
  }
  assert.deepEqual(waits(p).map((w) => [w.ms, !!w.returned, !!w.landed]), Array(MAX_SUBAGENT_WAITS).fill([30000, false, false]));
  // the fourth: no wait left, the usual logic (nothing changed: the idle step)
  const r = stopIn(p, { backgroundTasks: [task('pf-executor')] }, clock(0));
  assert.equal(r.outcome, 'idle', JSON.stringify(r));
});

test('implement: another agent\'s return does not end the wait for the executor', () => {
  const p = inImplement();
  const r = stopIn(p, { backgroundTasks: [task('pf-executor')] }, clock(1, (t) => returned(p, 'pf-reviewer', t)));
  assert.equal(r.outcome, 'subagent-running');
  assert.equal(waits(p)[0].ms, 30000);
});

// a loop in review, the reviewer delegated
function inReview() {
  const p = inImplement();
  writeFileSync(join(p.dir, 'hello.txt'), 'the step\n');
  assert.equal(stopIn(p).outcome, 'always');
  assert.equal(readState(p).phase, 'review');
  return p;
}

test('review: the verdict lands during the wait: read by the rerun (pass), no wait spent', () => {
  const p = inReview();
  const requestId = readState(p).verdictRequestId;
  const r = stopIn(p, { backgroundTasks: [task('pf-reviewer')] }, clock(3, () => writeFileSync(gate(p, 'review.json'), JSON.stringify({ requestId, blocking: 0, findings: [] }))));
  assert.equal(r.outcome, 'pass', JSON.stringify(r));
  assert.equal(readState(p).counters.subagentWaits, 0);
  assert.equal(waits(p)[0].landed, 'review.json');
});

test('review: the reviewer comes back WITHOUT its verdict: the rerun asks for the outcome (missing), it does not say a subagent is still running', () => {
  const p = inReview();
  const r = stopIn(p, { backgroundTasks: [task('pf-reviewer')] }, clock(2, (t) => returned(p, 'pf-reviewer', t)));
  assert.equal(r.outcome, 'missing', JSON.stringify(r));
  assert.ok(!String(r.output.reason).includes('still running'), r.output.reason);
  assert.equal(readState(p).counters.subagentWaits, 0);
  assert.equal(waits(p)[0].returned, true);
});

// a loop in the final verification (the single verifier)
function inFinalVerify() {
  const p = inReview();
  writePlan(p, '- [x] one\n- [x] two\n');
  patchState(p, (s) => { s.phase = 'final-verify'; s.verdictLenses = ['general']; s.verdictRequestId = 'R-final'; s.verdictRequestedAt = Date.now() - 1000; });
  return p;
}

test('final-verify: the verdict lands during the wait (a rejection): routed at once, no wait spent', () => {
  const p = inFinalVerify();
  const r = stopIn(p, { backgroundTasks: [task('pf-verifier')] }, clock(2, () => writeFileSync(gate(p, 'verify.json'), JSON.stringify({ requestId: 'R-final', pass: false, findings: [{ severity: 'critical', desc: 'wrong' }] }))));
  assert.equal(r.outcome, 'fail', JSON.stringify(r));
  assert.equal(readState(p).counters.subagentWaits, 0);
  assert.equal(waits(p)[0].landed, 'verify.json');
});

test('final-verify: the verifier comes back without a verdict: missing, not a wait', () => {
  const p = inFinalVerify();
  const r = stopIn(p, { backgroundTasks: [task('pf-verifier')] }, clock(1, (t) => returned(p, 'pf-verifier', t)));
  assert.equal(r.outcome, 'missing', JSON.stringify(r));
  assert.equal(readState(p).counters.subagentWaits, 0);
});

test('settleReturned: the returned tasks of the role marked completed, as many as are not pending, one at least; nothing else touched', () => {
  const ex = (id, status = 'running') => ({ id, status, agent_type: 'perseveranza:pf-executor' });
  const tasks = [ex('a'), { id: 'r', status: 'running', agent_type: 'pf-reviewer' }, ex('b'), 'junk', ex('c', 'completed')];
  const frozen = JSON.stringify(tasks);
  const pend = (n) => ({ pending: Array.from({ length: n }, (_, i) => ({ at: i + 1, agent: 'pf-executor' })) });
  const status = (out) => out.map((t) => (t && typeof t === 'object' ? `${t.id}:${t.status}` : t));
  assert.deepEqual(status(settleReturned(tasks, 'pf-executor', pend(0))), ['a:completed', 'r:running', 'b:completed', 'junk', 'c:completed']);
  assert.deepEqual(status(settleReturned(tasks, 'pf-executor', pend(1))), ['a:completed', 'r:running', 'b:running', 'junk', 'c:completed']);
  // a record that says more are pending than run: the one whose return was seen still is settled
  assert.deepEqual(status(settleReturned(tasks, 'pf-executor', pend(5))), ['a:completed', 'r:running', 'b:running', 'junk', 'c:completed']);
  assert.deepEqual(status(settleReturned(tasks, 'pf-executor', null)), ['a:completed', 'r:running', 'b:completed', 'junk', 'c:completed']);
  // another role's pending delegations do not hold this role's tasks
  assert.deepEqual(status(settleReturned(tasks, 'pf-executor', { pending: [{ at: 1, agent: 'pf-reviewer' }] })), ['a:completed', 'r:running', 'b:completed', 'junk', 'c:completed']);
  assert.equal(JSON.stringify(tasks), frozen, 'the input is not changed');
  assert.equal(settleReturned(undefined, 'pf-executor', null), undefined);
});
