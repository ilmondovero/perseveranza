import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readFileSync, mkdirSync, rmSync, realpathSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { project, cli, arm, fire, sessionStart, activity, readActivity, watchdog, readState, writeState, patchState, writePlan, writeArtifact, requestIdFrom, gate, journal, spawnSync, CLI, WATCHDOG, freshDir } from '../helpers/cli.mjs';
import { spawn } from 'node:child_process';
import { ROOT, ARCHIVE_GATE_DIRNAME } from '../../src/shell/paths.mjs';
import { currentVersion } from '../../src/update.mjs';
import { alive } from '../../src/shell/watchdog.mjs';

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
  // resuming is the user's: /pf resume (or the CLI from a terminal), never Claude's tool
  assert.ok(esc.includes('the user resumes the loop: `/pf resume` in Claude Code') && esc.includes('Claude cannot resume it with the `perseveranza` tool'), esc);
  assert.equal(fire(p).blocked, false, 'paused: silent');
  cli(p, 'resume');
  assert.ok(!existsSync(gate(p, 'ESCALATION.md')));
  r = fire(p);
  assert.equal(r.blocked, true);
  assert.equal(r.state.counters.retries, 0);
});

test('advisor: the 2nd fix without externals carries the advisor hint with the armed model; --advisor off does not', () => {
  const p = project();
  arm(p, 't', ['--advisor-model', 'sonnet']);
  writePlan(p, PLAN);
  fire(p); fire(p); // -> review
  writeArtifact(p, 'review.json', { blocking: 1, findings: [{ severity: 'critical', desc: 'first try wrong' }] });
  let r = fire(p);
  assert.ok(r.reason.includes('attempt 1/3'));
  assert.ok(!r.reason.includes('pf-advisor'), 'the 1st fix goes without');
  fire(p); // -> review
  writeArtifact(p, 'review.json', { blocking: 1, findings: [{ severity: 'critical', desc: 'still wrong' }] });
  r = fire(p);
  assert.ok(r.reason.includes('attempt 2/3'));
  assert.equal(r.state.phase, 'implement', 'the advisor does not route');
  assert.ok(r.reason.includes('pf-advisor') && r.reason.includes('model=sonnet'), r.reason);
  assert.ok(!r.reason.includes('If no external model'), 'no externals: the advisor is the second opinion itself');
  assert.equal(r.state.priorReviews.length, 2);
  for (const n of r.state.priorReviews) {
    assert.ok(existsSync(gate(p, n)), `${n} kept on disk for the advisor`);
    assert.ok(r.reason.includes(`.perseveranza/${n}`), `${n} handed to the advisor`);
  }
  const hints = journal(p).filter((e) => e.type === 'advisor-hint');
  assert.ok(hints.some((e) => e.slot === 'fix' && e.reason === 'no-external' && e.model === 'sonnet'), JSON.stringify(hints));
  assert.ok(cli(p, 'history').out.includes('advisor fix: hint issued (no external model, model sonnet)'));
  // a missing opinion blocks nothing: no advisor file, the review round goes on as usual
  fire(p);
  writeArtifact(p, 'review.json', { blocking: 0 });
  r = fire(p);
  assert.equal(r.state.phase, 'implement');
  assert.ok(r.reason.includes('Review passed'), r.reason);
  assert.deepEqual(r.state.priorReviews, [], 'the next step starts clean');

  const off = project();
  arm(off, 't', ['--advisor', 'off']);
  writePlan(off, PLAN);
  fire(off); fire(off);
  writeArtifact(off, 'review.json', { blocking: 1 });
  fire(off); fire(off);
  writeArtifact(off, 'review.json', { blocking: 1 });
  r = fire(off);
  assert.ok(r.reason.includes('attempt 2/3'));
  assert.ok(!r.reason.includes('pf-advisor') && !r.reason.includes('advisor-fix'), r.reason);
  assert.ok(journal(off).some((e) => e.type === 'advisor-hint' && e.slot === 'fix' && e.reason === 'off'));
});

test('kill switch via STOP file and PERSEVERANZA_KILL, also on a corrupt state; run archived', () => {
  const p = project();
  arm(p);
  writeFileSync(gate(p, 'STOP'), '');
  const r = fire(p);
  assert.equal(r.blocked, false);
  assert.equal(r.state, null);
  assert.ok(cli(p, 'runs').out.includes('killed'));
  const q = project();
  arm(q);
  const r2 = fire(q, {}, { PERSEVERANZA_KILL: '1' });
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

test('token usage counts the subagent transcripts of the session, by agent kind', () => {
  const p = project();
  arm(p, 't', ['--budget-tokens', '100000']);
  const transcript = join(p.dir, 'sess.jsonl');
  const line = (id, i, o) => JSON.stringify({ type: 'assistant', timestamp: '2099-01-01T00:00:00Z', message: { id, usage: { input_tokens: i, output_tokens: o } } });
  writeFileSync(transcript, line('m', 1000, 200));
  const subs = join(p.dir, 'sess', 'subagents');
  mkdirSync(subs, { recursive: true });
  writeFileSync(join(subs, 'agent-1.jsonl'), line('r', 300, 100));
  writeFileSync(join(subs, 'agent-1.meta.json'), JSON.stringify({ agentType: 'perseveranza:pf-reviewer' }));
  const r = fire(p, { transcript_path: transcript, session_id: 'owner' });
  assert.equal(r.state.usage.source, 'transcript+subagents');
  assert.equal(r.state.usage.inputTokens + r.state.usage.outputTokens, 1600);
  assert.equal(r.state.usage.byAgent['perseveranza:pf-reviewer'].outputTokens, 100);
  assert.ok(existsSync(gate(p, 'usage-cache.json')));
  const status = cli(p, 'status').out;
  assert.ok(status.includes('by agent:') && status.includes('perseveranza:pf-reviewer'), status);
  assert.ok(cli(p, 'history').out.includes('subagents 400 in 1 transcript(s)'));
  // another session in the same repo: its transcripts are not read, the owner's cache stays
  const cacheBefore = readFileSync(gate(p, 'usage-cache.json'), 'utf8');
  const other = join(p.dir, 'other.jsonl');
  writeFileSync(other, line('o', 5, 5));
  mkdirSync(join(p.dir, 'other', 'subagents'), { recursive: true });
  writeFileSync(join(p.dir, 'other', 'subagents', 'agent-9.jsonl'), line('z', 5, 5));
  fire(p, { transcript_path: other, session_id: 'intruder' });
  assert.equal(readFileSync(gate(p, 'usage-cache.json'), 'utf8'), cacheBefore);
  assert.equal(readState(p).usage.outputTokens, 300);
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
  assert.ok(hist.includes('GAP: no sign of life for'));
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
  assert.ok(live.includes('do not touch .perseveranza/'));
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
  assert.ok(!sessionStart(p, { session_id: 'B' }, { PERSEVERANZA_STALE_MS: String(30 * 3600 * 1000) }).text.includes('ABANDONED'));
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
  // the header carries the plugin's own version (plugin.json), never a pinned one
  assert.ok(r.reason.startsWith(`[perseveranza v${currentVersion(ROOT)} `), r.reason.slice(0, 60));
  assert.ok(r.reason.includes('CUSTOM PLAN node "'));
  assert.equal(r.state.phase, 'plan');
  const q = project();
  delete q.env.PERSEVERANZA_LANG; // the Italian default, no flag
  arm(q);
  const r2 = fire(q);
  assert.ok(r2.reason.includes('FASE: plan'), r2.reason.slice(0, 200));
  assert.ok(r2.reason.startsWith(`[perseveranza v${currentVersion(ROOT)} `), 'header stays');
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
  assert.ok(r.reason.includes(`.perseveranza/review-${it}.json`), r.reason);
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

test('activity hook: dormant, heartbeat throttled, delegation pending until the subagent returns, foreign session ignored', () => {
  const p = project();
  assert.equal(activity(p, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }).code, 0);
  assert.ok(!existsSync(gate(p, 'activity.json')), 'dormant without state.json');
  arm(p, 'busy task');
  fire(p, { session_id: 'A' }); // A owns it
  // PostToolUse on a working tool: the heartbeat
  const r1 = activity(p, { session_id: 'A', hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.equal(r1.code, 0); assert.equal(r1.raw, '', 'never prints');
  let a = readActivity(p);
  assert.equal(a.event, 'tool'); assert.equal(a.tool, 'Bash'); assert.equal(a.session, 'A'); assert.deepEqual(a.pending, []);
  // throttled: a second tool a moment later does not rewrite the record
  activity(p, { session_id: 'A', hook_event_name: 'PostToolUse', tool_name: 'Edit' });
  assert.equal(readActivity(p).tool, 'Bash');
  // a delegation is always recorded, journaled, and stays pending
  activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'perseveranza:pf-reviewer', prompt: 'review it' } });
  a = readActivity(p);
  assert.equal(a.event, 'delegate'); assert.equal(a.agent, 'perseveranza:pf-reviewer'); assert.equal(a.pending[0].agent, 'perseveranza:pf-reviewer');
  assert.ok(journal(p).some((e) => e.type === 'activity' && e.event === 'delegate' && e.agent === 'perseveranza:pf-reviewer' && e.pending === 1));
  // a second, parallel delegation (Task is the older name of the tool): both pending
  activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { description: 'x'.repeat(500) } });
  a = readActivity(p);
  assert.equal(a.pending.length, 2);
  assert.equal(a.pending[1].agent.length, 120, 'a whole prompt as a name is cut');
  // other tools while the subagents run (throttled away here, so force the clock back)
  const back = Date.now() - 60 * 1000;
  writeFileSync(gate(p, 'activity.json'), JSON.stringify({ ...a, at: back, pending: a.pending.map((d) => ({ ...d, at: back })) }));
  activity(p, { session_id: 'A', hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  a = readActivity(p);
  assert.equal(a.tool, 'Bash'); assert.equal(a.pending.length, 2, 'still pending');
  assert.ok(cli(p, 'status').out.includes('perseveranza:pf-reviewer delegated 1m ago'));
  assert.ok(cli(p, 'status').out.includes('not back yet'));
  // the first to return, named: only its own entry closes
  activity(p, { session_id: 'A', hook_event_name: 'SubagentStop', agent_type: 'perseveranza:pf-reviewer' });
  a = readActivity(p);
  assert.equal(a.pending.length, 1); assert.notEqual(a.pending[0].agent, 'perseveranza:pf-reviewer');
  // PreToolUse on anything but Agent is nothing
  writeFileSync(gate(p, 'activity.json'), JSON.stringify({ ...a, at: back }));
  activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'Bash' });
  assert.equal(readActivity(p).at, back);
  // the last one returns, unnamed: the oldest pending closes, journaled
  activity(p, { session_id: 'A', hook_event_name: 'SubagentStop' });
  a = readActivity(p);
  assert.equal(a.event, 'subagent-stop'); assert.deepEqual(a.pending, []);
  assert.ok(journal(p).some((e) => e.type === 'activity' && e.event === 'subagent-stop' && e.agent === 'perseveranza:pf-reviewer'));
  assert.ok(cli(p, 'history').out.includes('subagent perseveranza:pf-reviewer finished'));
  // a returned foreground Agent call closes a pending delegation too
  writeFileSync(gate(p, 'activity.json'), JSON.stringify({ ...a, at: back, event: 'delegate', pending: [{ at: back, agent: 'x' }] }));
  activity(p, { session_id: 'A', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'x' } });
  assert.deepEqual(readActivity(p).pending, []);
  // the old single-slot shape is still read
  writeFileSync(gate(p, 'activity.json'), JSON.stringify({ at: Date.now(), session: 'A', event: 'tool', tool: 'Bash', delegate: { at: back, agent: 'legacy' } }));
  assert.equal(readActivity(p).delegate.agent, 'legacy');
  assert.ok(cli(p, 'status').out.includes('legacy delegated 1m ago'));
  // another session's tools are not this loop's life
  writeFileSync(gate(p, 'activity.json'), JSON.stringify({ ...a, at: back, pending: [] }));
  activity(p, { session_id: 'B', hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.equal(readActivity(p).at, back);
  // and a foreign record on disk is not shown beside a STALE owner
  patchState(p, (s) => { s.owner.lastFireAt = Date.now() - 20 * 3600 * 1000; });
  writeFileSync(gate(p, 'activity.json'), JSON.stringify({ at: Date.now(), session: 'B', event: 'delegate', agent: 'other', pending: [{ at: Date.now(), agent: 'other' }] }));
  const st = cli(p, 'status').out;
  assert.ok(st.includes('STALE') && !st.includes('activity:'), st);
  const rs = cli(p, 'resume').out;
  assert.ok(rs.includes('STALE'), rs);
  writeFileSync(gate(p, 'activity.json'), JSON.stringify({ at: Date.now(), session: 'A', event: 'tool', tool: 'Edit', pending: [] }));
  assert.ok(!cli(p, 'resume').out.includes('STALE'), 'resume sees the owner activity');
  patchState(p, (s) => { s.owner.lastFireAt = Date.now(); });
  writeFileSync(gate(p, 'activity.json'), JSON.stringify({ ...a, at: back, pending: [] }));
  activity(p, { session_id: 'B', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'z' } });
  assert.equal(readActivity(p).at, back);
  // garbage in, nothing out
  assert.equal(activity(p, {}, '{not json').code, 0);
  assert.equal(readState(p).owner.sessionId, 'A', 'the state is never touched');
});

test('activity keeps a long turn alive for status, HUD, the SessionStart notice and the gap', () => {
  const p = project();
  arm(p, 'long turn');
  writePlan(p, PLAN);
  fire(p, { session_id: 'A' });
  patchState(p, (s) => { s.owner.lastFireAt = Date.now() - 20 * 3600 * 1000; });
  assert.ok(cli(p, 'status').out.includes('STALE'), 'silent: stale');
  activity(p, { session_id: 'A', hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  const st = cli(p, 'status').out;
  assert.ok(!st.includes('STALE'), st);
  assert.ok(/activity: {4}\d+s ago \(.*, tool Bash\)/.test(st), st);
  const notice = sessionStart(p, { session_id: 'B' }).text;
  assert.ok(notice.includes('driven by another session') && notice.includes('last activity'), notice);
  // the Stop that finally comes: no gap, the turn was working
  fire(p, { session_id: 'A' });
  assert.ok(!journal(p).some((e) => e.type === 'gap'));
});

test('watchdog: alerts on real silence, re-sleeps on life, yields to a newer one, exits on pause and disarm', () => {
  const p = project();
  arm(p, 'watched task');
  writePlan(p, PLAN);
  fire(p, { session_id: 'A' });
  patchState(p, (s) => { s.owner.lastFireAt = Date.now() - 20 * 3600 * 1000; });
  // 1 s threshold (the parse floor): the silence is real, the watchdog speaks at once
  let r = watchdog(p, { PERSEVERANZA_STALE_MS: '1000' });
  assert.equal(r.code, 0);
  let w = journal(p).find((e) => e.type === 'watchdog');
  assert.ok(w, 'journaled');
  assert.ok(w.silentMs > 19 * 3600 * 1000);
  assert.equal(w.via, 'fire'); assert.equal(w.phase, 'implement'); assert.equal(w.notified, false, 'PERSEVERANZA_NO_NOTIFY in the tests');
  assert.ok(w.text.includes('Loop silent for 20h00m') && w.text.includes('phase implement, 0/2 steps') && w.text.includes('resume --takeover'), w.text);
  assert.ok(cli(p, 'history').out.includes('WATCHDOG: silent for 20h00m'));
  // life inside the turn: it re-sleeps until the activity is stale, then speaks about the delegation
  activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'pf-reviewer' } });
  const t0 = Date.now();
  r = watchdog(p, { PERSEVERANZA_STALE_MS: '1000' });
  assert.ok(Date.now() - t0 >= 900, 'slept until the activity went stale');
  const ws = journal(p).filter((e) => e.type === 'watchdog');
  assert.equal(ws.length, 2);
  assert.equal(ws[1].via, 'activity');
  assert.equal(ws[1].activity.pending[0].agent, 'pf-reviewer');
  assert.ok(ws[1].text.includes('delegated to pf-reviewer), not back yet'), ws[1].text);
  assert.ok(cli(p, 'history').out.includes('pf-reviewer delegated and not back'));
  // a newer watchdog owns the gate: this one exits without a word
  writeFileSync(gate(p, 'watchdog.json'), JSON.stringify({ pid: 999999, spawnedAt: new Date().toISOString() }));
  r = watchdog(p, { PERSEVERANZA_STALE_MS: '1000' });
  assert.equal(r.code, 0);
  assert.equal(journal(p).filter((e) => e.type === 'watchdog').length, 2);
  writeFileSync(gate(p, 'watchdog.json'), '{broken');
  // paused: a human is expected, the watchdog has nothing to say
  cli(p, 'pause');
  watchdog(p, { PERSEVERANZA_STALE_MS: '1000' });
  assert.equal(journal(p).filter((e) => e.type === 'watchdog').length, 2);
  cli(p, 'resume');
  // the summary keeps the alerts
  cli(p, 'disarm');
  const id = cli(p, 'runs').out.trim().split('\n')[0].trim().split(/\s+/)[0];
  const summary = JSON.parse(readFileSync(join(p.home, 'runs', ...id.split('/'), 'summary.json'), 'utf8'));
  assert.equal(summary.watchdogAlerts.length, 2);
  assert.deepEqual(summary.watchdogAlerts[1].pending, ['pf-reviewer']);
  // disarmed: nothing to watch
  assert.equal(watchdog(p, { PERSEVERANZA_STALE_MS: '1000' }).code, 0);
  // no gate dir at all: exits 2 without an argument, 0 with a missing one
  assert.equal(spawnSync(process.execPath, [WATCHDOG], { encoding: 'utf8', env: p.env }).status, 2);
});

test('the Stop hook and arm spawn ONE live watchdog per loop unless PERSEVERANZA_NO_WATCHDOG; a foreign or pausing Stop spawns none', async () => {
  const p = project();
  const env = { ...p.env }; delete env.PERSEVERANZA_NO_WATCHDOG;
  // a 1 s threshold makes the spawned watchdog speak and exit almost at once, leaving no stray process
  env.PERSEVERANZA_STALE_MS = '1000';
  const wait = (ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);
  const r = spawnSync(process.execPath, [CLI, 'arm', 'spawned', '--external', 'off', '--no-git-finish'], { cwd: p.dir, encoding: 'utf8', env });
  assert.equal(r.code ?? r.status, 0, r.stdout + r.stderr);
  const wd = JSON.parse(readFileSync(gate(p, 'watchdog.json'), 'utf8'));
  assert.ok(wd.pid > 0 && wd.spawnedAt);
  // the waits below end as soon as their condition holds; their limit is only for a loaded
  // machine, slow to start node
  const until = (cond, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end && !cond()) wait(200); return cond(); };
  // give the detached watchdog its second to speak and leave
  assert.ok(until(() => journal(p).some((e) => e.type === 'watchdog')), 'the detached watchdog really runs and journals');
  assert.ok(until(() => !alive(wd.pid)), 'and then exits');
  assert.equal(journal(p).filter((e) => e.type === 'watchdog').length, 1, 'once');
  // a live incumbent: a Stop spawns nothing (a process that surely outlives the Stop stands
  // for it; the 1 s watchdog itself may be gone before a slow Stop starts)
  const incumbent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  // the incumbent is this test's own child: on Linux and macOS a killed child stays a zombie (a
  // pid that signal 0 still reaches, alive() true) until its parent reaps it, and Node reaps
  // only from its event loop, which the synchronous waits above never yield to. So the end of
  // the incumbent is awaited (its 'exit' comes after the reap), then checked as before.
  const exited = new Promise((r) => { incumbent.once('exit', r); });
  const incumbentAt = new Date().toISOString();
  try {
    writeFileSync(gate(p, 'watchdog.json'), JSON.stringify({ pid: incumbent.pid, spawnedAt: incumbentAt }));
    fire(p, { session_id: 'A' }, { PERSEVERANZA_NO_WATCHDOG: '', PERSEVERANZA_STALE_MS: '1000' });
    assert.equal(JSON.parse(readFileSync(gate(p, 'watchdog.json'), 'utf8')).pid, incumbent.pid, 'one live watchdog per loop');
  } finally { incumbent.kill(); }
  await Promise.race([exited, new Promise((r) => { setTimeout(r, 60000).unref(); })]);
  assert.ok(until(() => !alive(incumbent.pid)), 'the incumbent is gone before the next Stop');
  // it exited: a foreign Stop still spawns nothing, the owner's Stop spawns a new one
  fire(p, { session_id: 'B' }, { PERSEVERANZA_NO_WATCHDOG: '', PERSEVERANZA_STALE_MS: '1000' });
  assert.equal(JSON.parse(readFileSync(gate(p, 'watchdog.json'), 'utf8')).pid, incumbent.pid, 'a foreign Stop spawns nothing');
  fire(p, { session_id: 'A' }, { PERSEVERANZA_NO_WATCHDOG: '', PERSEVERANZA_STALE_MS: '1000' });
  const wd2 = JSON.parse(readFileSync(gate(p, 'watchdog.json'), 'utf8'));
  assert.ok(wd2.pid > 0 && wd2.spawnedAt !== incumbentAt, 'the incumbent is gone: a fresh one');
  assert.ok(until(() => journal(p).filter((e) => e.type === 'watchdog').length >= 2));
  assert.equal(journal(p).filter((e) => e.type === 'watchdog').length, 2);
  assert.ok(until(() => !alive(wd2.pid)));
  // a Stop that pauses the loop (escalation) spawns none: a human is expected
  patchState(p, (s) => { s.phase = 'review'; s.counters.retries = 3; s.limits.maxRetries = 3; });
  writeArtifact(p, 'review.json', { blocking: 1 });
  const paused = fire(p, { session_id: 'A' }, { PERSEVERANZA_NO_WATCHDOG: '', PERSEVERANZA_STALE_MS: '1000' });
  assert.equal(paused.state.signals.paused, true);
  assert.equal(JSON.parse(readFileSync(gate(p, 'watchdog.json'), 'utf8')).pid, wd2.pid, 'no watchdog for a paused loop');
});

test('the test verb beats while the suite runs, so a long suite is not a silent loop', () => {
  const p = project();
  arm(p, 'slow suite');
  fire(p, { session_id: 'A' });
  patchState(p, (s) => { s.owner.lastFireAt = Date.now() - 20 * 3600 * 1000; });
  assert.ok(cli(p, 'status').out.includes('STALE'));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, 'test', '--', 'node -e "setTimeout(()=>{}, 3500)"'], { cwd: p.dir, encoding: 'utf8', env: { ...p.env, PERSEVERANZA_ACTIVITY_HEARTBEAT_MS: '1000' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const a = readActivity(p);
  assert.ok(a && a.tool.startsWith('test verb: node -e'), JSON.stringify(a));
  assert.ok(a.at >= t0 + 1500, 'the record was refreshed DURING the run, not only at its start');
  assert.equal(a.session, 'A', 'the beat is the owner\'s, never an anonymous one that would keep a foreign loop alive');
  assert.ok(!cli(p, 'status').out.includes('STALE'));
});

test('the transcript is the third sign of life: recorded by the Stop hook, read by status, HUD and SessionStart', () => {
  const p = project();
  arm(p, 'typing');
  writePlan(p, PLAN);
  const tdir = freshDir('prs-tr-');
  const transcript = join(tdir, 'sess-A.jsonl');
  writeFileSync(transcript, '{"type":"user"}\n');
  fire(p, { session_id: 'A', transcript_path: transcript });
  assert.equal(readState(p).owner.transcriptPath, transcript);
  patchState(p, (s) => { s.owner.lastFireAt = Date.now() - 20 * 3600 * 1000; });
  // the file is old (older than the fire? no: written a moment ago): the loop is alive
  let st = cli(p, 'status').out;
  assert.ok(!st.includes('STALE') && /transcript: {2}written \d+s ago/.test(st), st);
  // the transcript falls silent: stale
  const old = new Date(Date.now() - 20 * 3600 * 1000);
  spawnSync(process.execPath, ['-e', `require('fs').utimesSync(process.argv[1], ${old.getTime() / 1000}, ${old.getTime() / 1000})`, transcript]);
  st = cli(p, 'status').out;
  assert.ok(st.includes('STALE'), st);
  // a subagent transcript still being written counts too
  const sub = join(tdir, 'sess-A', 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'agent-1.jsonl'), '{"type":"assistant"}\n');
  st = cli(p, 'status').out;
  assert.ok(!st.includes('STALE'), st);
  const notice = sessionStart(p, { session_id: 'B' }).text;
  assert.ok(notice.includes('driven by another session') && notice.includes('last output'), notice);
  // the gap starts at the last sign of life: none here, the turn was writing
  fire(p, { session_id: 'A', transcript_path: transcript });
  assert.ok(!journal(p).some((e) => e.type === 'gap'));
  // PERSEVERANZA_RESTORE on: the hook looks for the Claude Code process above it. Under a plain
  // test runner there is none (0); under a Claude Code session running the suite it finds
  // that very session, with its start time: the walk works end to end either way.
  fire(p, { session_id: 'A', transcript_path: transcript }, { PERSEVERANZA_RESTORE: '1' });
  const o = readState(p).owner;
  assert.ok(o.claudePid === 0 || (o.claudePid > 0 && typeof o.claudeStartedAt === 'string'), JSON.stringify(o));
});

test('restore.mjs: what Claude Code looks like, the walk starts above the hook, kill fails closed, the env is scrubbed', async (t) => {
  // a failed assertion must not leave the spawned processes alive: they would keep the test
  // file (and the whole e2e run) from ever exiting
  const spawned = [];
  t.after(() => { for (const c of spawned) { try { c.kill(); } catch { /* gone */ } } });
  const { findClaudeProcess, looksLikeClaude, processInfo, sameProcess, killTree, cleanEnv } = await import('../../src/shell/restore.mjs');
  // the native binary, or node running the npm package; never our own hooks, however
  // "claude" their path (the shipped plugin lives under ~/.claude/plugins/...)
  assert.equal(looksLikeClaude('claude.exe', '"C:\\Users\\x\\.local\\bin\\claude.exe" --dangerously-skip-permissions'), true);
  assert.equal(looksLikeClaude('claude', '/usr/local/bin/claude'), true);
  assert.equal(looksLikeClaude('node', 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'), true);
  assert.equal(looksLikeClaude('node.exe', 'node "C:\\Users\\x\\.claude\\plugins\\cache\\perseveranza\\perseveranza\\2.4.0\\src\\shell\\stop.mjs"'), false, 'the Stop hook of the installed plugin');
  assert.equal(looksLikeClaude('node.exe', 'node C:\\x\\.claude\\plugins\\p\\src\\shell\\watchdog.mjs C:\\proj\.perseveranza'), false, 'the watchdog');
  assert.equal(looksLikeClaude('node', 'node /home/x/.claude/mcp/some-server.js'), false, 'an MCP server under ~/.claude');
  assert.equal(looksLikeClaude('bash.exe', 'bash -c claude'), false);
  // a dummy that looks like the npm package
  const dummy = spawn(process.execPath, ['-e', '/* @anthropic-ai/claude-code/cli.js dummy */ setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  spawned.push(dummy);
  // and a child under it, standing in for the hook: the walk must answer with the dummy, not the child
  await new Promise((r) => setTimeout(r, 800));
  const info = processInfo(dummy.pid);
  assert.equal(info.alive, true);
  assert.ok(looksLikeClaude(info.name, info.cmd), JSON.stringify(info));
  assert.equal(sameProcess(info, null), false, 'no recorded start time: not proven, a kill primitive fails closed');
  assert.equal(sameProcess({ ...info, startedAt: null }, info.startedAt), false);
  assert.equal(sameProcess(info, info.startedAt), true);
  assert.equal(sameProcess(info, new Date(Date.parse(info.startedAt) - 60_000).toISOString()), false, 'a different start: a reused pid');
  // The walk goes up from the parent of the pid it is given. Run inside a Claude Code session
  // (a Bash call of it), the suite has a real Claude Code above it, and a walk from below may
  // reach it within its 12 levels: that one is right to find. So: never the starting process,
  // never a plain node parent, and if anything, the Claude Code above this very test.
  const around = findClaudeProcess(process.pid);
  const above = (found) => found === null || (around !== null && found.pid === around.pid);
  const fromDummy = findClaudeProcess(dummy.pid);
  assert.ok(above(fromDummy) && (!fromDummy || fromDummy.pid !== dummy.pid), `the starting process is never a candidate: ${JSON.stringify(fromDummy)}`);
  const child = spawn(process.execPath, ['-e', `require('child_process').spawnSync(process.execPath, ['-e', 'setTimeout(()=>{}, 4000)'], { stdio: 'ignore' })`], { stdio: 'ignore' });
  spawned.push(child);
  await new Promise((r) => setTimeout(r, 1200));
  const grandchild = String((process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${child.pid} }).ProcessId`], { encoding: 'utf8' })
    : spawnSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' })).stdout || '').trim().split(/\s+/)[0];
  if (grandchild) {
    const fromGrandchild = findClaudeProcess(Number(grandchild));
    assert.ok(above(fromGrandchild), `plain node parents: none of them found: ${JSON.stringify(fromGrandchild)}`);
  }
  assert.equal(processInfo(process.pid).alive, true);
  assert.equal(killTree(dummy.pid), true);
  assert.equal(processInfo(dummy.pid).alive, false);
  assert.equal(processInfo(0).alive, false);
  child.kill();
  // re-arm: a live incumbent is kept unless `replace` is asked (the watchdog re-arming
  // after a restore is itself the incumbent)
  const { spawnWatchdog, alive } = await import('../../src/shell/watchdog.mjs');
  const emptyGate = join(freshDir('prs-gate-'), '.perseveranza');
  mkdirSync(emptyGate, { recursive: true });
  const envOn = { ...process.env, PERSEVERANZA_NO_WATCHDOG: '' };
  const incumbent = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  spawned.push(incumbent);
  await new Promise((r) => setTimeout(r, 500));
  writeFileSync(join(emptyGate, 'watchdog.json'), JSON.stringify({ pid: incumbent.pid, spawnedAt: new Date().toISOString() }));
  assert.equal(spawnWatchdog(emptyGate, envOn), incumbent.pid, 'alive incumbent: kept');
  const fresh = spawnWatchdog(emptyGate, envOn, { replace: true });
  assert.ok(fresh > 0 && fresh !== incumbent.pid, 'replace: a new one');
  assert.equal(JSON.parse(readFileSync(join(emptyGate, 'watchdog.json'), 'utf8')).pid, fresh);
  incumbent.kill();
  await new Promise((r) => setTimeout(r, 1500)); // no state.json in that gate: the new one exits at once
  assert.equal(alive(fresh), false, 'a watchdog on an unarmed gate leaves');
  assert.equal(spawnWatchdog(emptyGate, { PERSEVERANZA_NO_WATCHDOG: '1' }), 0);
  const env = cleanEnv({ PATH: 'x', CLAUDE_CONFIG_DIR: 'keep', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_MESSAGING_SOCKET: 's', CLAUDE_CODE_BRIDGE_SESSION_ID: 'b', CLAUDE_CODE_SESSION_ID: 'i', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'gone' });
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CONFIG_DIR', 'PATH'], 'everything Claude Code sets about its own session is stripped; the user config dir is not');
});

test('a replacement watchdog gives the restored session a fresh startup interval', async () => {
  const p = project();
  arm(p, 'restore grace');
  const T = Date.now();
  patchState(p, (s) => {
    s.owner.lastFireAt = T - 60_000;
    s.signals.interrupted = { at: new Date(T - 100).toISOString(), silentMs: 60_000, phase: 'implement', pending: [] };
  });
  const { decide } = await import('../../src/shell/watchdog.mjs');
  const grace = decide(gate(p, ''), { now: T, staleMs: 1000, pid: process.pid, startedAt: T - 100 });
  assert.equal(grace.action, 'sleep');
  assert.ok(grace.ms >= 900 && grace.ms <= 1500, JSON.stringify(grace));
  const expired = decide(gate(p, ''), { now: T + 1001, staleMs: 1000, pid: process.pid, startedAt: T - 100 });
  assert.equal(expired.action, 'alert');
  assert.equal(expired.via, 'restore');
  // the killed turn's pending delegation is still reported after the restore
  writeFileSync(gate(p, 'activity.json'), JSON.stringify({ ...readActivity(p), session: null, at: T - 50_000, pending: [{ at: T - 50_000, agent: 'pf-reviewer' }] }));
  const withPending = decide(gate(p, ''), { now: T + 1001, staleMs: 1000, pid: process.pid, startedAt: T - 100 });
  assert.equal(withPending.via, 'restore');
  assert.deepEqual(withPending.activity.pending.map((x) => x.agent), ['pf-reviewer']);
  // a launch time in the future is no sign of life: it cannot hold the alert back
  patchState(p, (s) => { s.signals.interrupted.at = new Date(T + 10 * 3600 * 1000).toISOString(); });
  const future = decide(gate(p, ''), { now: T + 1001, staleMs: 1000, pid: process.pid, startedAt: T - 100 });
  assert.equal(future.action, 'alert');
  assert.notEqual(future.via, 'restore');
});

test('watchdog with PERSEVERANZA_RESTORE: kills the recorded Claude process, reopens the session with the restore prompt, guards pid reuse and the restore limit', async (t) => {
  // a failed assertion must not leave the spawned processes alive: they would keep the test
  // file (and the whole e2e run) from ever exiting
  const spawned = [];
  t.after(() => { for (const c of spawned) { try { c.kill(); } catch { /* gone */ } } });
  const p = project();
  arm(p, 'hung review');
  writePlan(p, '- [x] one\n- [ ] two\n');
  fire(p, { session_id: 'sess-A-full' });
  activity(p, { session_id: 'sess-A-full', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'pf-reviewer' } });
  // a fake claude that records how it was called
  const out = join(freshDir('prs-fake-'), 'call.json');
  const fake = join(freshDir('prs-fake-'), 'claude.mjs');
  writeFileSync(fake, `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.FAKE_CLAUDE_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), child: process.env.CLAUDE_CODE_CHILD_SESSION ?? null, sock: process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? null }));`);
  const env = { PERSEVERANZA_RESTORE: '1', PERSEVERANZA_RESTORE_AFTER_MS: '1000', PERSEVERANZA_CLAUDE_BIN: fake, FAKE_CLAUDE_OUT: out, PERSEVERANZA_STALE_MS: '1000', CLAUDE_CODE_CHILD_SESSION: 'inherited', CLAUDE_CODE_MESSAGING_SOCKET: 'inherited' };
  // the hung "Claude Code": a dummy whose command line looks like the npm package
  const dummy = spawn(process.execPath, ['-e', '/* @anthropic-ai/claude-code/cli.js dummy */ setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  spawned.push(dummy);
  await new Promise((r) => setTimeout(r, 800));
  const { processInfo } = await import('../../src/shell/restore.mjs');
  const info = processInfo(dummy.pid);
  const T20 = Date.now() - 20 * 3600 * 1000;
  patchState(p, (s) => { s.owner.lastFireAt = T20; s.owner.claudePid = dummy.pid; s.owner.claudeStartedAt = info.startedAt; });
  // strictly after the fire (same millisecond would make the fire the last sign of life)
  writeFileSync(gate(p, 'activity.json'), JSON.stringify({ ...readActivity(p), at: T20 + 1000, pending: [{ at: T20 + 1000, agent: 'pf-reviewer' }] }));
  const r = watchdog(p, env);
  assert.equal(r.code, 0, r.stderr);
  // two stages: the alert first (the human's chance), the restore after the second threshold
  const ws = journal(p).filter((e) => e.type === 'watchdog');
  assert.deepEqual(ws.map((e) => e.action), ['alerted', 'restored'], JSON.stringify(ws.map((e) => e.text)));
  assert.ok(ws[0].text.includes('will be terminated and restored in'), ws[0].text);
  const w = ws[1];
  assert.equal(w.restore.killed, true); assert.equal(w.restore.wasAlive, true); assert.equal(w.restore.how, 'direct');
  assert.equal(processInfo(dummy.pid).alive, false, 'the hung process tree is gone');
  assert.ok(w.text.includes('Terminated the hung session; reopened it'), w.text);
  assert.equal(w.restore.watchdog, 0, 'the re-arm ran (PERSEVERANZA_NO_WATCHDOG=1 in the tests makes it a no-op: see the spawnWatchdog test)');
  const until = Date.now() + 10000;
  while (Date.now() < until && !existsSync(out)) await new Promise((res) => setTimeout(res, 100));
  assert.ok(existsSync(out), 'the fake claude was launched');
  const call = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(call.argv.slice(0, 2), ['-r', 'sess-A-full'], 'same session id: it keeps owning the loop');
  assert.ok(/interrupted by the watchdog after (19h59m|20h00m)/.test(call.argv[2]), call.argv[2]);
  assert.ok(call.argv[2].includes('pending and never returned (pf-reviewer)'));
  assert.ok(call.argv[2].includes('Phase `implement`'));
  // real paths: on macOS the temp dir /var/... is /private/var/... seen from the child
  assert.equal(realpathSync(call.cwd).replace(/\\/g, '/'), realpathSync(p.dir).replace(/\\/g, '/'), 'launched from the project');
  assert.equal(call.child, null, 'the inherited child marker is stripped, so the restored session saves its transcript');
  assert.equal(call.sock, null);
  assert.ok(call.argv[2].includes('RECONCILE FIRST, READ-ONLY'), 'the restored session reconciles before anything else');
  const intr = readState(p).signals.interrupted;
  assert.ok(intr && intr.silentMs > 19 * 3600 * 1000 && intr.phase === 'implement' && intr.pending.includes('pf-reviewer'), JSON.stringify(intr));
  assert.ok(cli(p, 'status').out.includes('interrupted:'), 'status says it');
  // the launch is on record in its own file too (the guard against a second restore)
  const sentinel = JSON.parse(readFileSync(gate(p, 'restore-launched.json'), 'utf8'));
  assert.equal(sentinel.session, 'sess-A-full'); assert.equal(sentinel.at, intr.at);
  // the rest of this test is about the watchdog, not the reconciliation: the restored session's
  // first Stop is played by clearing both marks (dropRestoreSentinel does it at a real Stop)
  const restoredStopped = () => { patchState(p, (s) => { s.signals.interrupted = null; }); rmSync(gate(p, 'restore-launched.json'), { force: true }); };
  restoredStopped();
  assert.ok(cli(p, 'history').out.includes('WATCHDOG (killed and restored)'));
  // the recorded process is gone (client died): nothing to kill, still restored
  patchState(p, (s) => { s.owner.lastFireAt = Date.now() - 20 * 3600 * 1000; });
  writeFileSync(gate(p, 'watchdog.json'), '');
  rmSync(out, { force: true });
  watchdog(p, env);
  const w2 = journal(p).filter((e) => e.type === 'watchdog').pop();
  assert.equal(w2.action, 'restored'); assert.equal(w2.restore.wasAlive, false); assert.equal(w2.restore.killed, false);
  assert.ok(w2.text.includes('Its process was already gone; reopened it'));
  // the restored session never reached a Stop (a trust prompt, typically): the pid on record
  // is the one just terminated, so a dead pid proves nothing. No second `claude -r` beside it.
  const launches = () => (existsSync(out) ? readFileSync(out, 'utf8') : '');
  const settle = Date.now() + 10000; // the previous launch writes its record asynchronously
  while (Date.now() < settle && !launches()) await new Promise((res) => setTimeout(res, 100));
  rmSync(out, { force: true });
  writeFileSync(gate(p, 'watchdog.json'), '');
  watchdog(p, env);
  const w2a = journal(p).filter((e) => e.type === 'watchdog').pop();
  assert.equal(w2a.action, 'alerted');
  assert.ok(w2a.restore.why.includes('has not reached a Stop yet'), w2a.restore.why);
  await new Promise((res) => setTimeout(res, 1500));
  assert.equal(launches(), '', 'nothing relaunched');
  restoredStopped();
  // never recorded (flag turned on mid-run, walk failed): a blind relaunch beside a possibly
  // live session is refused
  patchState(p, (s) => { s.owner.lastFireAt = Date.now() - 20 * 3600 * 1000; s.owner.claudePid = 0; });
  writeFileSync(gate(p, 'watchdog.json'), '');
  watchdog(p, env);
  const w2b = journal(p).filter((e) => e.type === 'watchdog').pop();
  assert.equal(w2b.action, 'alerted');
  assert.ok(w2b.restore.why.includes('refusing a blind relaunch'), w2b.restore.why);
  patchState(p, (s) => { s.owner.claudePid = dummy.pid; s.owner.claudeStartedAt = info.startedAt; });
  // pid reuse: a live process that is not Claude Code is never killed, and neither is one
  // that looks like it but whose start time is unknown
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  spawned.push(other);
  await new Promise((r) => setTimeout(r, 800));
  patchState(p, (s) => { s.owner.lastFireAt = Date.now() - 20 * 3600 * 1000; s.owner.claudePid = other.pid; s.owner.claudeStartedAt = processInfo(other.pid).startedAt; });
  watchdog(p, env);
  const w3 = journal(p).filter((e) => e.type === 'watchdog').pop();
  assert.equal(w3.action, 'alerted');
  assert.ok(w3.restore.why.includes('not the recorded Claude Code process'), w3.restore.why);
  assert.equal(processInfo(other.pid).alive, true, 'untouched');
  other.kill();
  // the restore limit: a session that dies at every restore is a problem for a human. The
  // count is taken from the WHOLE journal: an overnight run outgrows the tail window
  patchState(p, (s) => { s.owner.lastFireAt = Date.now() - 20 * 3600 * 1000; s.owner.claudePid = dummy.pid; s.owner.claudeStartedAt = info.startedAt; });
  writeFileSync(gate(p, 'watchdog.json'), '');
  watchdog(p, env); // third restore
  assert.equal(journal(p).filter((e) => e.type === 'watchdog' && e.action === 'restored').length, 3);
  restoredStopped();
  const pad = JSON.stringify({ ts: new Date().toISOString(), type: 'note', text: 'x'.repeat(200) });
  writeFileSync(gate(p, 'journal.jsonl'), `${readFileSync(gate(p, 'journal.jsonl'), 'utf8')}${(pad + '\n').repeat(600)}`);
  patchState(p, (s) => { s.owner.lastFireAt = Date.now() - 20 * 3600 * 1000; });
  writeFileSync(gate(p, 'watchdog.json'), '');
  watchdog(p, env);
  const w5 = journal(p).filter((e) => e.type === 'watchdog').pop();
  assert.equal(w5.action, 'alerted');
  assert.ok(w5.restore.why.includes('restore limit (3)'), w5.restore.why);
  // without the flag: alert only, nothing killed, nothing launched
  const alive2 = spawn(process.execPath, ['-e', '/* @anthropic-ai/claude-code/cli.js dummy */ setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  spawned.push(alive2);
  await new Promise((r) => setTimeout(r, 800));
  patchState(p, (s) => { s.owner.lastFireAt = Date.now() - 20 * 3600 * 1000; s.owner.claudePid = alive2.pid; s.owner.claudeStartedAt = processInfo(alive2.pid).startedAt; });
  writeFileSync(gate(p, 'watchdog.json'), '');
  const before = existsSync(out) ? readFileSync(out, 'utf8') : '';
  watchdog(p, { PERSEVERANZA_STALE_MS: '1000', PERSEVERANZA_CLAUDE_BIN: fake, FAKE_CLAUDE_OUT: out });
  const w6 = journal(p).filter((e) => e.type === 'watchdog').pop();
  assert.equal(w6.action, 'alerted'); assert.equal(w6.restore, null);
  assert.ok(w6.text.includes('Check the session'));
  assert.equal(processInfo(alive2.pid).alive, true, 'nothing killed');
  assert.equal(existsSync(out) ? readFileSync(out, 'utf8') : '', before, 'nothing launched');
  alive2.kill();
  cli(p, 'disarm');
  const id = cli(p, 'runs').out.trim().split('\n')[0].trim().split(/\s+/)[0];
  const summary = JSON.parse(readFileSync(join(p.home, 'runs', ...id.split('/'), 'summary.json'), 'utf8'));
  assert.equal(summary.watchdogAlerts.filter((a) => a.action === 'restored').length, 3);
});

// The verifier's reproduction, as a test: real watchdog processes, three in a row on the same
// hung loop, a fake claude that appends a line per launch. A state standing only in its pending
// copy (a crash in a write in place) gives no launch at all; a whole one gives exactly one.
test('watchdog with PERSEVERANZA_RESTORE, three watchdogs in a row: 0 launches on a pending-only state, 1 on a whole one', async (t) => {
  const spawned = [];
  t.after(() => { for (const c of spawned) { try { c.kill(); } catch { /* gone */ } } });
  const fake = join(freshDir('prs-fake3-'), 'claude.mjs');
  writeFileSync(fake, "import { appendFileSync } from 'node:fs'; appendFileSync(process.env.FAKE_CLAUDE_OUT, JSON.stringify(process.argv.slice(2, 4)) + '\\n');");
  const { processInfo } = await import('../../src/shell/restore.mjs');
  const hung = async (pending) => {
    const p = project();
    arm(p, 'hung, three watchdogs');
    fire(p, { session_id: 'sess-H' });
    const dummy = spawn(process.execPath, ['-e', '/* @anthropic-ai/claude-code/cli.js dummy */ setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
    spawned.push(dummy);
    await new Promise((r) => setTimeout(r, 800));
    const info = processInfo(dummy.pid);
    patchState(p, (s) => { s.owner.lastFireAt = Date.now() - 20 * 3600 * 1000; s.owner.claudePid = dummy.pid; s.owner.claudeStartedAt = info.startedAt; });
    if (pending) { writeFileSync(gate(p, 'state.json.pending'), readFileSync(gate(p, 'state.json'), 'utf8')); rmSync(gate(p, 'state.json')); }
    const out = join(freshDir('prs-fake3-'), 'launches.txt');
    const env = { PERSEVERANZA_RESTORE: '1', PERSEVERANZA_RESTORE_AFTER_MS: '1000', PERSEVERANZA_STALE_MS: '1000', PERSEVERANZA_CLAUDE_BIN: fake, FAKE_CLAUDE_OUT: out };
    const launches = async () => {
      await new Promise((r) => setTimeout(r, 1500)); // a launch writes its line asynchronously
      return existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    };
    return { p, dummy, out, env, launches };
  };

  // pending-only: each watchdog alerts, says no restore, and keeps watching (it does not exit by
  // itself: stopped here after its second threshold has long passed)
  const a = await hung(true);
  const pendingText = readFileSync(gate(a.p, 'state.json.pending'), 'utf8');
  for (let i = 0; i < 3; i++) {
    writeFileSync(gate(a.p, 'watchdog.json'), '');
    const wd = spawn(process.execPath, [WATCHDOG, gate(a.p, '')], { stdio: 'ignore', env: { ...a.p.env, ...a.env } });
    spawned.push(wd);
    // its alert on record (a loaded machine starts node slowly), then past its second threshold
    const until = Date.now() + 30000;
    while (Date.now() < until && journal(a.p).filter((e) => e.type === 'watchdog').length < i + 1) await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(alive(wd.pid), true, `watchdog ${i + 1} still watching`);
    wd.kill();
  }
  assert.equal(await a.launches(), 0, 'no claude -r on a pending-only state');
  assert.equal(alive(a.dummy.pid), true, 'the session is not terminated');
  assert.equal(existsSync(gate(a.p, 'state.json')), false, 'nothing promoted or written');
  assert.equal(readFileSync(gate(a.p, 'state.json.pending'), 'utf8'), pendingText);
  assert.equal(existsSync(gate(a.p, 'restore-launched.json')), false);
  const wa = journal(a.p).filter((e) => e.type === 'watchdog');
  assert.deepEqual(wa.map((e) => e.action), ['alerted', 'alerted', 'alerted'], 'one alert per watchdog');
  assert.ok(wa.every((e) => e.text.includes('No restore: state.json stands only in its pending copy')), wa[0].text);

  // whole: the first restores, the next two find the launch on record and refuse
  const b = await hung(false);
  for (let i = 0; i < 3; i++) {
    writeFileSync(gate(b.p, 'watchdog.json'), '');
    const r = watchdog(b.p, b.env);
    assert.equal(r.code, 0, r.stderr);
    // the second and third would not depend on signals.interrupted: it is cleared after the first
    if (i === 0) patchState(b.p, (s) => { s.signals.interrupted = null; });
  }
  assert.equal(await b.launches(), 1, 'exactly one claude -r on a whole state');
  const wb = journal(b.p).filter((e) => e.type === 'watchdog');
  assert.deepEqual(wb.map((e) => e.action), ['alerted', 'restored', 'alerted', 'alerted', 'alerted', 'alerted']);
  assert.ok(wb[3].restore.why.includes('has not reached a Stop yet') && wb[5].restore.why.includes('has not reached a Stop yet'), wb[5].restore.why);
  assert.ok(existsSync(gate(b.p, 'restore-launched.json')), 'the sentinel is on record');
  // the restored session's first Stop drops it
  fire(b.p, { session_id: 'sess-H' });
  assert.equal(existsSync(gate(b.p, 'restore-launched.json')), false, 'dropped at the first Stop of the restored session');
});

// manual-302: two watchdogs that both believe they own the gate (watchdog.json lost: no pid on
// record) race for the same restore at the same instant. The sentinel's exclusive creation
// decides: one launch per race, never two.
test('two watchdogs racing for the same restore: exactly one launch, every time', async () => {
  const RACER = join(ROOT, 'test', 'helpers', 'restore-racer.mjs');
  const RACES = 10;
  for (let k = 0; k < RACES; k++) {
    const p = project();
    arm(p, 'hung, two watchdogs');
    patchState(p, (s) => { s.owner.sessionId = 'sess-H'; s.owner.lastFireAt = Date.now() - 20 * 3600 * 1000; s.owner.claudePid = 999999; s.owner.claudeStartedAt = new Date(Date.now() - 21 * 3600 * 1000).toISOString(); });
    writeFileSync(gate(p, 'watchdog.json'), JSON.stringify({ pid: 0 }));
    const out = join(p.dir, 'launches.txt');
    const startAt = Date.now() + 4000;
    const kids = [0, 1].map(() => spawn(process.execPath, [RACER, gate(p, ''), String(startAt), out], { env: p.env, stdio: 'ignore' }));
    await Promise.all(kids.map((c) => new Promise((r) => c.on('exit', r))));
    const launches = existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    const whys = existsSync(`${out}.why`) ? readFileSync(`${out}.why`, 'utf8') : '';
    assert.equal(launches, 1, `race ${k}: ${whys}`);
    // the loser lost the claim, or (a loaded machine started it after the winner's launch) read
    // the launch as a sign of life or as a restore on record
    assert.match(whys, /another watchdog has just claimed this restore|has not reached a Stop yet|decide: sleep/, `race ${k}: the loser says why: ${whys}`);
  }
});

// manual-302: a watchdog killed between its marks and the launch left both behind. A real
// watchdog process later finds them abandoned (their watchdog gone, the interval past) and
// restores; it does not refuse for ever.
test('watchdog with PERSEVERANZA_RESTORE: the marks of a watchdog killed before its launch expire, the next one restores', async () => {
  const p = project();
  arm(p, 'abandoned claim');
  fire(p, { session_id: 'sess-H' });
  const at = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  patchState(p, (s) => { s.owner.lastFireAt = Date.now() - 20 * 3600 * 1000; s.owner.claudePid = 999999; s.owner.claudeStartedAt = new Date(Date.now() - 21 * 3600 * 1000).toISOString(); s.signals.interrupted = { at, silentMs: 1, phase: 'plan', pending: [] }; });
  writeFileSync(gate(p, 'restore-launched.json'), JSON.stringify({ at, session: 'sess-H', by: 999999, nonce: 'killed', phase: 'claimed' }));
  writeFileSync(gate(p, 'watchdog.json'), '');
  const fake = join(freshDir('prs-fake5-'), 'claude.mjs');
  const out = join(freshDir('prs-fake5-'), 'launches.txt');
  writeFileSync(fake, "import { appendFileSync } from 'node:fs'; appendFileSync(process.env.FAKE_CLAUDE_OUT, 'x\\n');");
  const r = watchdog(p, { PERSEVERANZA_RESTORE: '1', PERSEVERANZA_RESTORE_AFTER_MS: '1000', PERSEVERANZA_STALE_MS: '1000', PERSEVERANZA_CLAUDE_BIN: fake, FAKE_CLAUDE_OUT: out });
  assert.equal(r.code, 0, r.stderr);
  const ws = journal(p).filter((e) => e.type === 'watchdog').map((e) => e.action);
  assert.deepEqual(ws, ['alerted', 'restore-abandoned', 'restored'], JSON.stringify(ws));
  const until = Date.now() + 10000;
  while (Date.now() < until && !existsSync(out)) await new Promise((res) => setTimeout(res, 100));
  assert.equal(readFileSync(out, 'utf8'), 'x\n', 'one launch');
  const s = JSON.parse(readFileSync(gate(p, 'restore-launched.json'), 'utf8'));
  assert.equal(s.phase, 'launched'); assert.notEqual(s.nonce, 'killed');
  assert.equal(readState(p).signals.interrupted.at, s.at, 'the interruption is the new attempt\'s');
});

test('a review.json older than the review request is set aside through the real hook', () => {
  const p = project();
  arm(p, 'late verdict');
  writePlan(p, PLAN);
  fire(p, { session_id: 'A' }); fire(p, { session_id: 'A' }); // -> review, request stamped now
  assert.ok(readState(p).verdictRequestedAt > 0);
  writeArtifact(p, 'review.json', { blocking: 0 });
  const old = (Date.now() - 60 * 1000) / 1000;
  spawnSync(process.execPath, ['-e', `require('fs').utimesSync(process.argv[1], ${old}, ${old})`, gate(p, 'review.json')]);
  let r = fire(p, { session_id: 'A' });
  assert.equal(r.state.phase, 'review', 'not advanced on a stale verdict');
  assert.ok(r.reason.includes('outcome missing'), r.reason);
  assert.ok(!existsSync(gate(p, 'review.json')));
  assert.ok(existsSync(gate(p, 'review-stale-2.json')), 'kept aside, never lost');
  assert.ok(cli(p, 'history').out.includes('STALE (written'));
  // a fresh verdict is read normally
  writeArtifact(p, 'review.json', { blocking: 0 });
  r = fire(p, { session_id: 'A' });
  assert.equal(r.state.phase, 'implement');
  assert.ok(existsSync(gate(p, 'review-3.json')));
});

test('the request id travels through the rendered prompt, in both languages', () => {
  for (const lang of ['en', 'it']) {
    const p = project();
    arm(p, 'request id', ['--lang', lang]);
    writePlan(p, '- [ ] one\n');
    fire(p, { session_id: 'A' });
    let r = fire(p, { session_id: 'A' }); // -> review
    assert.equal(r.state.phase, 'review');
    const id = requestIdFrom(r.reason);
    assert.equal(id, r.state.verdictRequestId, `${lang}: the prompt hands out the current id: ${r.reason}`);
    assert.ok(cli(p, 'status').out.includes(`verdict request: ${id}`), `${lang}: status shows it (after a compaction)`);
    // an earlier request's verdict, written after this one: set aside
    writeArtifact(p, 'review.json', { requestId: 'earlier-request', blocking: 0 });
    r = fire(p, { session_id: 'A' });
    assert.equal(r.state.phase, 'review', `${lang}: not advanced on another request's verdict`);
    assert.ok(cli(p, 'history').out.includes('answers request earlier-request'), `${lang}: history names the reason`);
    // the id copied from the prompt counts
    writeArtifact(p, 'review.json', { requestId: requestIdFrom(r.reason) || id, blocking: 0 });
    r = fire(p, { session_id: 'A' });
    assert.equal(r.state.phase, 'implement', `${lang}: ${r.reason}`);
  }
});

test('the final gate closes outside git, and in git only on the code the verifier judged', () => {
  // outside git with a suite: the green recorded at cleanup is iterations old at the verdict
  const p = project();
  arm(p, 'no git', ['--test', 'node -e 0']);
  writePlan(p, '- [ ] one\n');
  fire(p); fire(p);
  writeArtifact(p, 'review.json', { blocking: 0 });
  fire(p);
  writePlan(p, '- [x] one\n');
  cli(p, 'test');
  cli(p, 'claim-done');
  let r = fire(p);
  assert.equal(r.state.phase, 'cleanup');
  cli(p, 'test', '--if-needed');
  r = fire(p);
  assert.equal(r.state.phase, 'final-verify');
  writeArtifact(p, 'verify.json', { requestId: requestIdFrom(r.reason), pass: true });
  r = fire(p);
  assert.equal(r.state, null, `closed and disarmed: ${r.reason}`);

  // in git: code edited while the verifier ran, even a file git does not track yet (every file
  // the loop creates, until the closing commit), does not close: back to implement, nothing
  // committed. Documentation touched meanwhile does not count.
  const g = project({ git: true });
  writeFileSync(join(g.dir, '.gitignore'), 'coverage/\n');
  arm(g, 'git', ['--test', 'node -e 0']);
  writePlan(g, '- [x] one\n');
  writeFileSync(join(g.dir, 'new.js'), 'module.exports = 1;\n');
  cli(g, 'test');
  cli(g, 'claim-done');
  fire(g); // -> cleanup
  r = fire(g); // -> final-verify
  assert.equal(r.state.phase, 'final-verify');
  writeFileSync(join(g.dir, 'README.md'), 'hello, edited while the verifier ran\n');
  writeFileSync(join(g.dir, 'new.js'), 'module.exports = 2;\n');
  writeArtifact(g, 'verify.json', { requestId: requestIdFrom(r.reason), pass: true });
  r = fire(g);
  assert.equal(r.state.phase, 'implement', r.reason);
  assert.ok(r.reason.includes('nothing was committed'), r.reason);
  assert.ok(cli(g, 'history').out.includes('gate=code-changed'));
  // proven and claimed again: a new round, whose pass survives the coverage output the
  // verifier's own run rewrites, because the repo ignores it
  cli(g, 'test');
  cli(g, 'claim-done');
  r = fire(g);
  assert.equal(r.state.phase, 'final-verify');
  mkdirSync(join(g.dir, 'coverage'), { recursive: true });
  writeFileSync(join(g.dir, 'coverage', 'lcov.info'), `TN:${Date.now()}\n`);
  writeArtifact(g, 'verify.json', { requestId: requestIdFrom(r.reason), pass: true });
  r = fire(g);
  assert.equal(r.state, null, `closed: ${r.reason}`);
});

test('reconciliation through the real hooks: mutating tools refused, inspection allowed, the file routes the loop', () => {
  const p = project();
  arm(p, 'restored task');
  writePlan(p, PLAN);
  fire(p, { session_id: 'A' }); // implement
  patchState(p, (s) => { s.signals.interrupted = { at: new Date().toISOString(), silentMs: 31 * 60 * 1000, phase: 'implement', pending: ['pf-reviewer'] }; });
  const deny = (r) => { const o = JSON.parse(r.raw); return o.hookSpecificOutput.permissionDecision === 'deny' ? o.hookSpecificOutput.permissionDecisionReason : null; };
  // the one write the reconciliation exists to produce is allowed, in every path shape
  for (const file_path of [join(p.dir, '.perseveranza', 'reconcile.json'), '.perseveranza/reconcile.json', `${p.dir.replace(/\\/g, '/')}/.perseveranza/reconcile.json`]) {
    assert.equal(activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path, content: '{}' } }).raw, '', `allowed: Write ${file_path}`);
    assert.equal(activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path } }).raw, '', `allowed: Edit ${file_path}`);
  }
  assert.ok(deny(activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(p.dir, '.perseveranza', 'plan.md') } })), 'any other file is refused');
  // refused: edits, writes, delegations, mutating and chained commands
  assert.ok(deny(activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'x' } })).includes('Edit is refused until .perseveranza/reconcile.json'));
  assert.ok(deny(activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'x' } })));
  assert.ok(deny(activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'pf-executor' } })));
  assert.ok(deny(activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })).includes('only read-only commands'));
  assert.ok(deny(activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status && npm test' } })));
  assert.ok(deny(activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat a > b' } })));
  assert.ok(deny(activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command: 'Remove-Item x' } })));
  assert.ok(deny(activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node scripts/migrate.mjs' } })));
  // bypasses a review found: every segment is judged, not only the first
  for (const command of ['find . -name "*.mjs" -delete', 'git branch -D main', 'git branch -m main other', 'ls\ngit commit -am wip', 'ls & git commit -am wip', 'ls\nnpm ci', 'cat a.txt & git push --force', 'git log | tee out.txt', 'git stash', 'git checkout -- .']) {
    assert.ok(deny(activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })), `refused: ${command}`);
  }
  assert.ok(deny(activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem *.mjs | ForEach-Object { $_.Delete() }' } })), 'no scriptblocks');
  // allowed: inspection, filters, the read-only verbs, a format string with angle brackets, a path with spaces
  for (const command of ['git status', 'git diff --stat', 'git log --oneline -5 | head -3', 'cat .perseveranza/notes.md', 'tasklist | findstr node', 'ls -la', `node "${CLI}" status`, 'Get-Process node | Select-Object Id', 'git log --pretty=format:"%h %an <%ae>" -5', 'node "C:/Program Files/tools/src/cli/perseveranza.mjs" history --tail 5', 'grep -rn foo src/', 'rg foo | head', 'sed -n 1,20p f', 'git branch --show-current', 'git log --oneline | grep -i del']) {
    const r = activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: command.startsWith('Get-') ? 'PowerShell' : 'Bash', tool_input: { command } });
    assert.equal(r.raw, '', `allowed: ${command}`);
  }
  assert.ok(journal(p).filter((e) => e.type === 'activity' && e.event === 'refused').length >= 8);
  assert.ok(cli(p, 'history').out.includes('REFUSED Edit (reconciling)'));
  // another session is not reconciling this loop's turn: nothing printed; nor an event without a session
  assert.equal(activity(p, { session_id: 'B', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} }).raw, '');
  assert.equal(activity(p, { session_id: '', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} }).raw, '');
  // the Stop without the file: asked once
  let r = fire(p, { session_id: 'A' });
  assert.ok(r.reason.includes('RECONCILIATION (after a restore)'), r.reason);
  assert.equal(r.state.phase, 'implement');
  // the file, written THROUGH the hook's permission (the harness only mirrors what Write would do)
  assert.equal(activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(p.dir, '.perseveranza', 'reconcile.json'), content: '{}' } }).raw, '');
  writeArtifact(p, 'reconcile.json', { disposition: 'partial', running: [], next: 'implement', summary: 'one file of two edited' });
  r = fire(p, { session_id: 'A' });
  assert.equal(r.state.phase, 'implement');
  assert.ok(r.reason.includes('after reconciliation: the step was partial'), r.reason);
  assert.equal(r.state.signals.interrupted, null);
  assert.ok(!existsSync(gate(p, 'reconcile.json')) && existsSync(gate(p, 'reconcile-2.json')), 'kept under the iteration it was read at');
  assert.ok(cli(p, 'history').out.includes('reconcile: partial -> reconcile-implement (one file of two edited)'));
  assert.equal(activity(p, { session_id: 'A', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} }).raw, '', 'edits allowed again');
  // a command still running: a human
  patchState(p, (s) => { s.signals.interrupted = { at: new Date().toISOString(), silentMs: 1, phase: 'implement', pending: [] }; });
  writeArtifact(p, 'reconcile.json', { disposition: 'partial', running: ['node server.js --port 3000'] });
  r = fire(p, { session_id: 'A' });
  assert.equal(r.blocked, false);
  assert.equal(r.state.signals.paused, true);
  assert.ok(existsSync(gate(p, 'ESCALATION.md')));
  assert.ok(readFileSync(gate(p, 'ESCALATION.md'), 'utf8').includes('node server.js --port 3000'));
});

// the archived loop folder of the only run in a test home
function archivedGate(p) {
  const base = join(p.home, 'runs');
  const proj = readdirSync(base)[0];
  const stamp = readdirSync(join(base, proj))[0];
  return join(base, proj, stamp, ARCHIVE_GATE_DIRNAME);
}

// plan -> one reviewed step -> claim -> cleanup -> final-verify, returning the last fire
function toFinalVerify(p) {
  writePlan(p, '- [ ] one\n');
  fire(p); fire(p); // -> implement -> review
  writeArtifact(p, 'review.json', { blocking: 0 });
  fire(p); // -> implement (advance)
  writePlan(p, '- [x] one\n');
  cli(p, 'claim-done');
  fire(p); // -> cleanup
  return fire(p); // -> final-verify
}

test('a final verification by three lenses through the real hook: a missing lens is asked alone, then the round closes', () => {
  const p = project();
  const armed = arm(p, 'lenses', ['--complexity', 'high']);
  assert.ok(armed.out.includes('Final verification lenses: auto'), armed.out);
  let r = toFinalVerify(p);
  assert.equal(r.state.phase, 'final-verify');
  assert.deepEqual(r.state.verdictLenses, ['correctness', 'security', 'tests']);
  const id = requestIdFrom(r.reason);
  assert.equal(id, r.state.verdictRequestId, r.reason);
  for (const l of ['correctness', 'security', 'tests']) assert.ok(r.reason.includes(`.perseveranza/verify-${l}.json with requestId ${id}`), `${l}: ${r.reason}`);
  assert.ok(cli(p, 'status').out.includes('lenses:      expected correctness, security, tests; arrived none'));
  // two lenses write, one (the security verifier, launched in the background) does not
  writeArtifact(p, 'verify-correctness.json', { requestId: id, lens: 'correctness', pass: true, findings: [] });
  writeArtifact(p, 'verify-tests.json', { requestId: id, lens: 'tests', pass: false, findings: [{ severity: 'warning', desc: 'the README claims a flag that does not exist', file: 'README.md:3' }] });
  assert.ok(cli(p, 'status').out.includes('arrived correctness, tests; missing security'));
  r = fire(p);
  assert.equal(r.state.phase, 'final-verify', r.reason);
  assert.ok(r.reason.includes('lens(es) security are missing') && !r.reason.includes('[lens correctness'), r.reason);
  assert.equal(r.state.verdictRequestId, id, 'the same request');
  assert.ok(existsSync(gate(p, 'verify-correctness.json')) && existsSync(gate(p, 'verify-tests.json')), 'the lenses that wrote stay valid on disk');
  assert.ok(journal(p).some((j) => j.type === 'lenses' && j.result === 'partial' && j.missing.join() === 'security'));
  // the missing lens arrives: every lens wrote, no critical (tests said pass:false with a warning)
  writeArtifact(p, 'verify-security.json', { requestId: id, lens: 'security', pass: true, findings: [] });
  r = fire(p);
  assert.equal(r.state, null, `closed and disarmed: ${r.reason}`);
  const g = archivedGate(p);
  const merged = readdirSync(g).filter((n) => /^verify-\d+\.json$/.test(n));
  assert.equal(merged.length, 1, readdirSync(g).join(', '));
  const doc = JSON.parse(readFileSync(join(g, merged[0]), 'utf8'));
  assert.equal(doc.pass, true);
  assert.deepEqual(doc.lenses.covered, { correctness: 'verify-correctness.json', security: 'verify-security.json', tests: 'verify-tests.json' });
  assert.deepEqual(doc.blockedBy, []);
  assert.deepEqual(doc.findings, [{ severity: 'warning', desc: 'the README claims a flag that does not exist', file: 'README.md:3', lens: 'tests', from: 'verify-tests.json' }]);
  for (const l of ['correctness', 'security', 'tests']) assert.ok(existsSync(join(g, merged[0].replace('verify-', `verify-${l}-`))), `${l} kept`);
  assert.ok(readFileSync(join(g, 'journal.jsonl'), 'utf8').includes('pass=false without a critical finding: read as a pass with warnings'));
});

test('lenses through the real hook: a lens missing twice rejects, the merged findings are on disk and rechecked by the next round', () => {
  const p = project();
  arm(p, 'lens missing', ['--verifiers', 'correctness,tests']);
  let r = toFinalVerify(p);
  assert.deepEqual(r.state.verdictLenses, ['correctness', 'tests']);
  const id = requestIdFrom(r.reason);
  writeArtifact(p, 'verify-correctness.json', { requestId: id, lens: 'correctness', pass: false, findings: [{ severity: 'warning', desc: 'empty input not handled', file: 'a.js:1' }] });
  r = fire(p); // tests missing
  assert.ok(r.reason.includes('lens(es) tests are missing'), r.reason);
  r = fire(p); // still missing: a rejection
  assert.equal(r.state.phase, 'implement', r.reason);
  assert.equal(r.state.counters.finalFails, 1);
  const kept = r.state.priorVerifies[0];
  assert.match(kept, /^verify-\d+\.json$/);
  assert.ok(r.reason.includes(`.perseveranza/${kept}`), r.reason);
  const doc = JSON.parse(readFileSync(gate(p, kept), 'utf8'));
  assert.equal(doc.result, 'missing-twice');
  assert.deepEqual(doc.lenses.missing, ['tests']);
  assert.equal(doc.findings[0].lens, 'correctness');
  assert.ok(!existsSync(gate(p, 'verify-correctness.json')), 'kept, not left to answer the next round');
  assert.ok(existsSync(gate(p, kept.replace('verify-', 'verify-correctness-'))));
  assert.ok(cli(p, 'history').out.includes('lenses partial'));
  // fixed and claimed again: the new round rechecks those findings by name
  fire(p); // -> review
  writeArtifact(p, 'review.json', { blocking: 0 });
  fire(p);
  cli(p, 'claim-done');
  r = fire(p);
  assert.equal(r.state.phase, 'final-verify', r.reason);
  assert.ok(r.reason.includes(`their findings are in .perseveranza/${kept}`), r.reason);
  // an agent that wrote verify.json for the round (it did not read the lenses): lens-fallback
  writeArtifact(p, 'verify.json', { requestId: requestIdFrom(r.reason), pass: true });
  r = fire(p);
  assert.equal(r.state, null, `closed on the fallback: ${r.reason}`);
  assert.ok(readFileSync(join(archivedGate(p), 'journal.jsonl'), 'utf8').includes('"type":"lens-fallback"'));
});

test('arm --verifiers validates the lenses; status shows them', () => {
  const p = project();
  const bad = cli(p, 'arm', 'x', '--external', 'off', '--verifiers', 'correctness,style');
  assert.equal(bad.code, 1);
  assert.ok(bad.out.includes('Invalid --verifiers (style)') && bad.out.includes('general, correctness, security, tests'), bad.out);
  assert.equal(cli(p, 'arm', 'x', '--external', 'off', '--verifiers', ' , ').code, 1);
  arm(p, 'x', ['--verifiers', 'Security,tests,security']);
  assert.deepEqual(readState(p).options.verifiers, ['security', 'tests']);
  assert.ok(cli(p, 'status').out.includes('verifiers: security,tests'));
  const q = project();
  arm(q, 'x', ['--verifiers', 'auto']);
  assert.equal(readState(q).options.verifiers, null);
  assert.ok(cli(q, 'status').out.includes('verifiers: auto (now general)'));
});
