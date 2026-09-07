import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { project, cli, arm, fire, sessionStart, readState, writeState, patchState, writePlan, writeArtifact, gate, journal } from '../helpers/cli.mjs';

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
  // the owner silent for ages: still nothing implicit
  patchState(p, (s) => { s.owner.lastFireAt = 1; });
  const still = fire(p, { session_id: 'B' });
  assert.equal(still.blocked, false);
  assert.equal(still.state.owner.sessionId, 'A');
  // explicit hand-over: resume --takeover releases A, the next Stop of B claims the loop
  const rel = cli(p, 'resume', '--takeover');
  assert.equal(rel.code, 0);
  assert.ok(rel.out.includes('owner released'));
  assert.equal(readState(p).owner.sessionId, null);
  assert.equal(readState(p).owner.releasedFrom, 'A');
  // the release has a window: past it, the same Stop is a foreign session again
  patchState(p, (s) => { s.owner.releasedAt = Date.now() - 3 * 3600 * 1000; });
  const expired = fire(p, { session_id: 'B' });
  assert.equal(expired.blocked, false);
  assert.equal(expired.state.owner.sessionId, null);
  assert.ok(cli(p, 'status').out.includes('window closed (resume --takeover again)'));
  cli(p, 'resume', '--takeover'); // reopens it
  const take = fire(p, { session_id: 'B' });
  assert.equal(take.blocked, true);
  assert.equal(take.state.owner.sessionId, 'B');
  assert.equal(take.state.counters.iterations, 2);
  const j = journal(p);
  assert.ok(j.some((e) => e.type === 'session' && e.event === 'released' && e.from === 'A'));
  assert.ok(j.some((e) => e.type === 'session' && e.event === 'takeover' && e.from === 'A' && e.to === 'B'));
  assert.ok(j.some((e) => e.type === 'gap' && e.ms > 1000), 'the silence is on record');
  const hist = cli(p, 'history').out;
  assert.ok(hist.includes('GAP: no fire for'));
  assert.ok(hist.includes('session takeover A -> B'));
});

test('SessionStart hook: dormant, silent for the owner, a notice for a foreign session (stale or not), compact reminder', () => {
  const p = project();
  assert.equal(sessionStart(p, { session_id: 'A' }).text, null, 'dormant without state.json');
  arm(p, 'orphan task');
  writePlan(p, '- [x] one\n- [ ] two\n- [ ] three\n');
  // armed a moment ago, nobody fired yet: the arming session has simply not stopped
  const fresh = sessionStart(p, { session_id: 'B' }).text;
  assert.ok(fresh.includes('just armed in this project'), fresh);
  assert.ok(!fresh.includes('ABANDONED'));
  fire(p, { session_id: 'A' }); fire(p, { session_id: 'A' }); // A owns it, phase review (review-delegate injected)
  assert.equal(sessionStart(p, { session_id: 'A', source: 'startup' }).text, null, 'the owner needs no notice');
  const compact = sessionStart(p, { session_id: 'A', source: 'compact' }).text;
  assert.ok(compact.includes('this session drives an armed loop'));
  assert.ok(compact.includes('phase `review`'));
  // another session, owner fired a moment ago: informed, not asked to take over
  const live = sessionStart(p, { session_id: 'B', source: 'startup' }).text;
  assert.ok(live.includes('driven by another session (session A'));
  assert.ok(live.includes('do not touch .omc-loop/'));
  assert.ok(!live.includes('ABANDONED'));
  // the owner silent for 20 h: the abandoned-loop question
  patchState(p, (s) => { s.owner.lastFireAt = Date.now() - 20 * 3600 * 1000; });
  const stale = sessionStart(p, { session_id: 'B', source: 'startup' });
  assert.ok(stale.text.includes('ABANDONED'));
  assert.ok(stale.text.includes('last fire 20h00m ago'));
  assert.ok(stale.text.includes('1/3 steps done'));
  assert.ok(stale.text.includes('last instruction `review-delegate`'), stale.text);
  assert.ok(stale.text.includes('resume --takeover'));
  assert.ok(stale.text.includes('disarm'));
  assert.ok(stale.text.includes('Task: orphan task'));
  assert.equal(stale.out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(journal(p).some((e) => e.type === 'session' && e.event === 'seen' && e.to === 'B' && e.stale === true && e.kind === 'abandoned'));
  // custom threshold: 30 h makes the same loop look alive
  assert.ok(!sessionStart(p, { session_id: 'B' }, { OMC_LOOP_STALE_MS: String(30 * 3600 * 1000) }).text.includes('ABANDONED'));
  // the state is never touched by the notice
  assert.equal(readState(p).owner.sessionId, 'A');
  // paused for 20 h: a human is expected, not an orphan
  cli(p, 'pause');
  const waiting = sessionStart(p, { session_id: 'B' }).text;
  assert.ok(waiting.includes('is PAUSED and waits for a human'), waiting);
  assert.ok(!waiting.includes('ABANDONED'));
  assert.ok(journal(p).some((e) => e.type === 'session' && e.event === 'seen' && e.kind === 'waiting'));
  patchState(p, (s) => { s.signals.paused = false; });
  // released by resume --takeover: waiting for a claim, not abandoned
  cli(p, 'resume', '--takeover');
  const rel = sessionStart(p, { session_id: 'C' }).text;
  assert.ok(rel.includes('released by session A'), rel);
  assert.ok(rel.includes('waiting for a claim'));
  assert.ok(!rel.includes('ABANDONED'));
  assert.equal(readState(p).owner.sessionId, null, 'still unclaimed: the notice claims nothing');
});

test('SessionStart hook speaks the language of the loop and reads only the tail of a huge journal', () => {
  const p = project();
  delete p.env.PERSEVERANZA_LANG; // the Italian default
  arm(p, 'compito orfano');
  writePlan(p, '- [x] uno\n- [ ] due\n');
  fire(p, { session_id: 'A' }); fire(p, { session_id: 'A' });
  // bury the last transition under megabytes of later noise: the tail must still find it
  const noise = JSON.stringify({ ts: new Date().toISOString(), type: 'note', text: 'x'.repeat(200) });
  writeFileSync(gate(p, 'journal.jsonl'), `${readFileSync(gate(p, 'journal.jsonl'), 'utf8')}${(noise + '\n').repeat(2000)}`);
  patchState(p, (s) => { s.owner.lastFireAt = Date.now() - 20 * 3600 * 1000; });
  const t0 = Date.now();
  const r = sessionStart(p, { session_id: 'B' });
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(r.text.includes('sembra ABBANDONATO'), r.text);
  assert.ok(r.text.includes('fase `review`'));
  assert.ok(r.text.includes('ultimo fire 20h00m fa'));
  assert.ok(r.text.includes('1/2 passi fatti'));
  assert.ok(!r.text.includes('ultima istruzione'), 'the transition is beyond the tail window: the hint is simply omitted');
  assert.ok(r.text.includes('resume --takeover'));
  // a project override of the notice wins over the language pack
  writeFileSync(gate(p, 'prompts.json'), JSON.stringify({ prompts: { 'session-abandoned': 'CUSTOM {{owner}} {{steps}}' } }));
  assert.equal(sessionStart(p, { session_id: 'B' }).text, 'CUSTOM sessione A 1/2 passi fatti');
});

test('a gap while paused is marked as such in the journal and the summary', () => {
  const p = project();
  arm(p, 'paused task');
  writePlan(p, PLAN);
  fire(p, { session_id: 'A' });
  cli(p, 'pause');
  patchState(p, (s) => { s.owner.lastFireAt = Date.now() - 20 * 3600 * 1000; });
  fire(p, { session_id: 'A' }); // paused: silent, but the silence is on record
  const gap = journal(p).find((e) => e.type === 'gap');
  assert.ok(gap && gap.paused === true);
  assert.ok(cli(p, 'history').out.includes('while paused'));
  // the usual shape: the human comes back, runs resume, then the turn ends
  patchState(p, (s) => { s.owner.lastFireAt = Date.now() - 20 * 3600 * 1000; });
  cli(p, 'resume');
  assert.ok(readState(p).signals.resumedAt > 0);
  fire(p, { session_id: 'A' });
  const gaps = journal(p).filter((e) => e.type === 'gap');
  assert.equal(gaps.length, 2);
  assert.equal(gaps[1].paused, true, 'resumed since the last fire: a pause, not a dead session');
  assert.equal(readState(p).signals.resumedAt, 0, 'consumed by the fire');
  // a plain silence after that is what it looks like
  patchState(p, (s) => { s.owner.lastFireAt = Date.now() - 20 * 3600 * 1000; });
  fire(p, { session_id: 'A' });
  assert.equal(journal(p).filter((e) => e.type === 'gap').pop().paused, false);
  cli(p, 'disarm');
  const id = cli(p, 'runs').out.trim().split('\n')[0].trim().split(/\s+/)[0];
  const summary = JSON.parse(readFileSync(join(p.home, 'runs', ...id.split('/'), 'summary.json'), 'utf8'));
  assert.equal(summary.gaps[0].paused, true);
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

test('a consumed verdict is kept as review-<n>.json / verify-<n>.json and the fix instruction names it', () => {
  const p = project();
  arm(p);
  writePlan(p, PLAN);
  fire(p); // plan -> implement
  fire(p); // implement -> review
  const it = readState(p).counters.iterations;
  writeArtifact(p, 'review.json', { blocking: 1, findings: [{ severity: 'critical', desc: 'wrong', file: 'a.js:1' }] });
  let r = fire(p);
  assert.equal(r.state.phase, 'implement');
  assert.ok(!existsSync(gate(p, 'review.json')));
  const kept = gate(p, `review-${it}.json`);
  assert.ok(existsSync(kept), 'review-<n>.json kept');
  assert.equal(JSON.parse(readFileSync(kept, 'utf8')).findings[0].desc, 'wrong');
  assert.ok(r.reason.includes(`.omc-loop/review-${it}.json`), r.reason);
  assert.ok(journal(p).some((j) => j.type === 'verdict' && j.savedAs === `review-${it}.json` && j.details[0].desc === 'wrong'));
  // the history renders where it went
  assert.ok(cli(p, 'history').out.includes(`-> review-${it}.json`));
});

test('implement: an unchanged tree after a stop is asked to implement once, through the real hook', () => {
  const p = project({ git: true });
  arm(p);
  writePlan(p, PLAN);
  let r = fire(p); // plan -> implement, tree recorded
  assert.equal(r.state.phase, 'implement');
  r = fire(p); // nothing changed: idle, still implement
  assert.equal(r.state.phase, 'implement');
  assert.ok(r.reason.includes('nothing changed'), r.reason);
  assert.ok(journal(p).some((j) => j.type === 'transition' && j.outcome === 'idle'));
  r = fire(p); // asked once: now review
  assert.equal(r.state.phase, 'review');
  // a real change is never mistaken for idle
  writeArtifact(p, 'review.json', { blocking: 0 });
  r = fire(p);
  assert.equal(r.state.phase, 'implement');
  writeFileSync(join(p.dir, 'work.js'), 'changed');
  r = fire(p);
  assert.equal(r.state.phase, 'review');
  assert.equal(journal(p).filter((j) => j.type === 'transition' && j.outcome === 'idle').length, 1);
});

test('claim-done through the real hook: an older green on the same tree, or after docs-only edits, is accepted', () => {
  const p = project({ git: true });
  arm(p, 't', ['--test', 'node -e 0']);
  writePlan(p, '- [x] one\n');
  fire(p);
  cli(p, 'test');
  const testIt = readState(p).lastTest.iteration;
  // burn iterations without touching the code
  writeFileSync(join(p.dir, 'x.js'), 'a');
  fire(p);
  writeFileSync(join(p.dir, 'x.js'), 'b');
  fire(p);
  assert.ok(readState(p).counters.iterations > testIt);
  // code changed since the test: stale
  cli(p, 'claim-done');
  let r = fire(p);
  assert.ok(r.reason.includes('stale'), r.reason);
  cli(p, 'test');
  fire(p);
  // documentation only since the green: accepted, journaled as docs-only
  writeFileSync(join(p.dir, 'README.md'), 'hello\ndocs changed\n');
  cli(p, 'claim-done');
  r = fire(p);
  assert.equal(r.state.phase, 'cleanup', r.reason);
  assert.ok(journal(p).some((j) => j.type === 'transition' && j.testProof === 'docs-only'));
  // the cleanup instruction says the suite is not rerun for documentation
  assert.ok(r.reason.includes('test --if-needed -- node -e 0'), r.reason);
});
