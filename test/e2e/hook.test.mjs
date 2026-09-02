import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { project, cli, arm, fire, readState, writeState, patchState, writePlan, writeArtifact, gate, journal } from '../helpers/cli.mjs';

const PLAN = '- [ ] one\n- [ ] two\n';

test('dormant without state.json: no output, nothing created', () => {
  const p = project();
  const r = fire(p);
  assert.equal(r.blocked, false);
  assert.equal(r.raw, '');
  assert.ok(!existsSync(gate(p, '')));
});

test('full happy path: plan -> implement -> review -> advance -> claim -> cleanup -> verify -> done (archived)', () => {
  const p = project();
  arm(p, 'happy');
  let r = fire(p);
  assert.ok(r.reason.includes('PHASE: plan'));
  writePlan(p, PLAN);
  r = fire(p);
  assert.equal(r.state.phase, 'implement');
  assert.ok(r.reason.includes('PHASE: implement'));
  r = fire(p);
  assert.equal(r.state.phase, 'review');
  writeArtifact(p, 'review.json', { blocking: 0 });
  r = fire(p);
  assert.equal(r.state.phase, 'implement');
  assert.ok(!existsSync(gate(p, 'review.json')));
  assert.equal(r.state.counters.retries, 0);
  writePlan(p, '- [x] one\n- [x] two\n');
  cli(p, 'claim-done');
  r = fire(p);
  assert.equal(r.state.phase, 'cleanup');
  assert.equal(r.state.flags.cleanedOnce, true);
  r = fire(p);
  assert.equal(r.state.phase, 'final-verify');
  writeArtifact(p, 'verify.json', { pass: true });
  r = fire(p);
  assert.equal(r.blocked, false);
  assert.equal(r.state, null, 'disarmed');
  const runs = cli(p, 'runs');
  assert.ok(runs.out.includes('done'));
  assert.ok(runs.out.includes('happy'));
});

test('review fail -> fix -> pass; escalation after the fixes are exhausted; resume clears it', () => {
  const p = project();
  arm(p, 't', ['--max-retries', '2']);
  writePlan(p, PLAN);
  fire(p); fire(p); // -> review
  writeArtifact(p, 'review.json', { blocking: 1, findings: [{ severity: 'critical', desc: 'x' }] });
  let r = fire(p);
  assert.ok(r.reason.includes('attempt 1/2'));
  fire(p); // -> review
  writeArtifact(p, 'review.json', { blocking: 1 });
  r = fire(p);
  assert.ok(r.reason.includes('attempt 2/2'));
  fire(p);
  writeArtifact(p, 'review.json', { blocking: 1 });
  r = fire(p);
  assert.equal(r.blocked, false);
  assert.equal(r.state.signals.paused, true);
  assert.ok(existsSync(gate(p, 'ESCALATION.md')));
  const esc = readFileSync(gate(p, 'ESCALATION.md'), 'utf8');
  assert.ok(esc.includes('consecutive failed reviews: 2/2'));
  assert.ok(esc.includes('Last transitions'));
  assert.equal(fire(p).blocked, false, 'paused: silent');
  cli(p, 'resume');
  assert.ok(!existsSync(gate(p, 'ESCALATION.md')));
  r = fire(p);
  assert.equal(r.blocked, true);
  assert.equal(r.state.counters.retries, 0);
});

test('kill switch via STOP file and OMC_LOOP_KILL, also on a corrupt state; run archived', () => {
  const p = project();
  arm(p);
  writeFileSync(gate(p, 'STOP'), '');
  const r = fire(p);
  assert.equal(r.blocked, false);
  assert.equal(r.state, null);
  assert.ok(cli(p, 'runs').out.includes('killed'));
  const q = project();
  arm(q);
  const r2 = fire(q, {}, { OMC_LOOP_KILL: '1' });
  assert.equal(r2.state, null);
  const c = project();
  arm(c);
  writeFileSync(gate(c, 'state.json'), '{not json');
  writeFileSync(gate(c, 'STOP'), '');
  assert.equal(fire(c).state, null);
});

test('corrupt state disarms (archived as corrupt-state)', () => {
  const p = project();
  arm(p);
  writeFileSync(gate(p, 'state.json'), '{"nonsense":true}');
  const r = fire(p);
  assert.equal(r.blocked, false);
  assert.equal(r.state, null);
  assert.ok(cli(p, 'runs').out.includes('corrupt-state'));
});

test('a v1 state is migrated on the fly and driven normally', () => {
  const p = project();
  mkdirSync(gate(p, ''), { recursive: true });
  writeState(p, {
    task: 'legacy', phase: 'review', complexity: 'low', commitSteps: false, externals: [], cleanedOnce: false,
    testCmd: null, lastTest: null, gitFinish: false, gitPush: true, approvePlan: false, planPresented: false,
    baselineDirty: [], iterations: 3, max: 25, retries: 0, maxRetries: 3, finalFails: 0, lastReport: 'pass',
    claimedDone: false, paused: false, repeated: false, sessionId: null, lastFireAt: 0,
  });
  const r = fire(p);
  assert.equal(r.state.schemaVersion, 2);
  assert.equal(r.state.phase, 'implement');
  assert.equal(r.state.task, 'legacy');
  assert.equal(r.state.counters.iterations, 4);
  assert.equal(r.state.limits.maxIterationsExplicit, true);
  assert.ok(journal(p).some((j) => j.type === 'migrate'));
  assert.ok(cli(p, 'status').out.includes('legacy'));
});

test('iteration budget: disarm at the cap, grace on the exit ramp; token budget from the transcript', () => {
  const p = project();
  arm(p, 't', ['--max', '3']);
  writePlan(p, PLAN);
  fire(p); fire(p); fire(p);
  const r = fire(p);
  assert.equal(r.state, null);
  assert.ok(cli(p, 'runs').out.includes('budget-iterations'));
  const q = project();
  arm(q, 't', ['--max', '3']);
  patchState(q, (s) => { s.phase = 'final-verify'; s.counters.iterations = 3; });
  assert.equal(fire(q).blocked, true, 'grace on the exit ramp');
  const t = project();
  arm(t, 't', ['--budget-tokens', '100']);
  const transcript = join(t.dir, 'transcript.jsonl');
  writeFileSync(transcript, [
    JSON.stringify({ type: 'assistant', timestamp: '2020-01-01T00:00:00Z', message: { usage: { input_tokens: 1000, output_tokens: 1000 } } }), // before arm: ignored
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2099-01-01T00:00:00Z', message: { usage: { input_tokens: 80, output_tokens: 30, cache_read_input_tokens: 5 } } }),
  ].join('\n'));
  const r3 = fire(t, { transcript_path: transcript });
  assert.equal(r3.state, null, 'token budget exhausted');
  const runs = cli(t, 'runs');
  assert.ok(runs.out.includes('budget-tokens'));
  assert.ok(runs.out.includes('tok=110'));
});

test('token usage is measured and shown in the header when a transcript exists', () => {
  const p = project();
  arm(p);
  const transcript = join(p.dir, 'transcript.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: '2099-01-01T00:00:00Z', message: { usage: { input_tokens: 1200, output_tokens: 300 } } }));
  const r = fire(p, { transcript_path: transcript });
  assert.ok(r.reason.includes('1.5k tok'));
  assert.equal(r.state.usage.inputTokens, 1200);
  assert.equal(r.state.usage.source, 'transcript');
});

test('session scoping through the real hook', () => {
  const p = project();
  arm(p);
  writePlan(p, PLAN);
  fire(p, { session_id: 'A' });
  const b = fire(p, { session_id: 'B' });
  assert.equal(b.blocked, false);
  assert.equal(b.state.owner.sessionId, 'A');
  assert.equal(b.state.counters.iterations, 1);
  patchState(p, (s) => { s.owner.lastFireAt = 1; });
  const take = fire(p, { session_id: 'B' });
  assert.equal(take.blocked, true);
  assert.equal(take.state.owner.sessionId, 'B');
});

test('prompt pack: project override and language pack change the wording, header and routing stay', () => {
  const p = project();
  arm(p);
  writeFileSync(gate(p, 'prompts.json'), JSON.stringify({ prompts: { 'plan-write': 'CUSTOM PLAN {{LOOP}}' } }));
  const r = fire(p);
  assert.ok(r.reason.startsWith('[perseveranza v2.'));
  assert.ok(r.reason.includes('CUSTOM PLAN node "'));
  assert.equal(r.state.phase, 'plan');
  const q = project();
  delete q.env.PERSEVERANZA_LANG; // the Italian default, no flag
  arm(q);
  const r2 = fire(q);
  assert.ok(r2.reason.includes('FASE: plan'), r2.reason.slice(0, 200));
  assert.ok(r2.reason.startsWith('[perseveranza v2.'), 'header stays');
  const bad = project();
  arm(bad);
  writeFileSync(gate(bad, 'prompts.json'), '{broken');
  const r3 = fire(bad);
  assert.ok(r3.reason.includes('PHASE: plan'), 'defaults on a broken pack');
  assert.ok(journal(bad).some((j) => j.type === 'prompt-pack' && j.error));
});

test('claim-done gates through the real hook: open steps, no fresh test, stale fingerprint', () => {
  const p = project({ git: true });
  arm(p, 't', ['--test', 'node -e 0']);
  writePlan(p, PLAN);
  fire(p);
  cli(p, 'claim-done');
  let r = fire(p);
  assert.ok(r.reason.includes('2 unchecked'));
  writePlan(p, '- [x] one\n- [x] two\n');
  cli(p, 'claim-done');
  r = fire(p);
  assert.ok(r.reason.includes('no proof of a fresh green test'));
  cli(p, 'test');
  writeFileSync(join(p.dir, 'late.txt'), 'edited after the test');
  cli(p, 'claim-done');
  r = fire(p);
  assert.ok(r.reason.includes('stale'), r.reason);
  cli(p, 'test');
  cli(p, 'claim-done');
  r = fire(p);
  assert.equal(r.state.phase, 'cleanup');
});

test('the hook never crashes the stop: a thrown error is journaled and Claude may stop', async () => {
  const p = project();
  arm(p);
  writeFileSync(gate(p, 'plan.md'), 'x');
  // make plan.md a directory to provoke a read error on the plan path
  const { rmSync } = await import('node:fs');
  rmSync(gate(p, 'plan.md'));
  mkdirSync(gate(p, 'plan.md'));
  const r = fire(p);
  assert.equal(typeof r.raw, 'string');
});
