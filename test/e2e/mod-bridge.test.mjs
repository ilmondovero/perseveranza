// The mod bridge as the mod will call it: `node src/shell/mod-bridge.mjs`, one JSON request on
// stdin, one JSON answer on stdout, exit 0 whatever happens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, utimesSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { project, cli, arm, armWithMod, fire, readState, patchState, writePlan, writeArtifact, requestIdFrom, gate, journal, spawnSync, readFileSync, writeFileSync, existsSync, join, NODE, howItEnded, runNode } from '../helpers/cli.mjs';
import { ROOT } from '../../src/shell/paths.mjs';
import { pathToFileURL } from 'node:url';

const BRIDGE = join(ROOT, 'src', 'shell', 'mod-bridge.mjs');
const PLAN = '- [ ] one\n- [ ] two\n';
const RUNNING = [{ id: 'a1', type: 'local_agent', status: 'running', agent_type: 'perseveranza:pf-reviewer', description: 'review of step one' }];

// -> { code, res (parsed stdout), raw }
function bridge(p, req, rawInput = null) {
  const input = rawInput != null ? rawInput : JSON.stringify({ cwd: p.dir, ...req, event: { session_id: 't-sess', ...(req.event || {}) } });
  const r = runNode([BRIDGE], { input, encoding: 'utf8', env: p.env });
  let res = null;
  try { res = JSON.parse(r.stdout); } catch { /* reported by the assertions */ }
  if (res == null && rawInput == null) assert.fail(`the bridge gave no JSON answer: ${howItEnded(r)}`);
  return { code: r.status, res, raw: r.stdout, stderr: r.stderr };
}
const stop = (p, facts = {}, event = {}) => bridge(p, { op: 'stop', event, facts });
// a preload that writes a verdict file during the bridge's real-time wait (test/helpers/land-during-wait.mjs)
const LAND = pathToFileURL(join(ROOT, 'test', 'helpers', 'land-during-wait.mjs')).href;
const landDuring = (file, verdict, poll = 3) => ({ LAND_FILE: file, LAND_TEXT: JSON.stringify(verdict), LAND_AT_POLL: String(poll) });

test('bridge stop: dormant without state, then the phase prompt exactly like the Stop hook', () => {
  const p = project();
  let r = stop(p);
  assert.equal(r.code, 0);
  assert.deepEqual(r.res, { ok: true, decision: { allowStop: true }, outcome: 'dormant' });
  arm(p, 'bridge');
  r = stop(p);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.res.ok, true);
  assert.equal(r.res.outcome, 'no-plan');
  assert.ok(r.res.decision.block.includes('PHASE: plan'), r.raw);
  assert.ok(r.res.decision.block.includes('perseveranza.mjs" complexity'), 'shell mode by default');
  assert.equal(readState(p).owner.sessionId, 't-sess');
  // the Stop hook and the bridge drive the same loop: one each, same state
  writePlan(p, PLAN);
  const h = fire(p);
  assert.equal(h.state.phase, 'implement');
  r = stop(p);
  assert.equal(r.res.outcome, 'always');
  assert.equal(readState(p).phase, 'review');
  assert.ok(r.res.decision.block.includes('PHASE: code review'));
});

test('bridge stop: a running pf-* subagent -> subagent-running, three times, then the usual logic', () => {
  const p = project();
  arm(p, 'waits');
  writePlan(p, PLAN);
  stop(p); stop(p); // -> review
  const before = readState(p);
  assert.equal(before.phase, 'review');
  for (let i = 1; i <= 3; i++) {
    const r = stop(p, { backgroundTasks: RUNNING });
    assert.equal(r.res.outcome, 'subagent-running', r.raw);
    assert.ok(r.res.decision.block.includes('pf-reviewer "review of step one"') && r.res.decision.block.includes(`${i}/3`), r.res.decision.block);
    const s = readState(p);
    assert.equal(s.phase, 'review');
    assert.equal(s.counters.subagentWaits, i);
    assert.equal(s.counters.iterations, before.counters.iterations, 'no iteration spent');
  }
  let r = stop(p, { backgroundTasks: RUNNING });
  assert.equal(r.res.outcome, 'missing');
  assert.equal(readState(p).counters.subagentWaits, 3, 'same request: the waits stay spent (missing buys no new ones)');
  assert.ok(journal(p).some((j) => j.type === 'transition' && j.outcome === 'subagent-running' && j.waits === 3));
  // the verdict arrives: it routes, subagent or not
  writeArtifact(p, 'review.json', { requestId: readState(p).verdictRequestId, blocking: 0 });
  r = stop(p, { backgroundTasks: RUNNING });
  assert.equal(r.res.outcome, 'pass');
  // a finished subagent, or no facts at all: the Stop hook's behaviour
  r = stop(p, { backgroundTasks: [{ ...RUNNING[0], status: 'completed' }] });
  assert.equal(r.res.outcome, 'always');
});

test('bridge stop: a running subagent is waited for in real time; a verdict that lands meanwhile is read at once', async () => {
  const p = project();
  arm(p, 'real waits');
  writePlan(p, PLAN);
  stop(p); stop(p); // -> review
  const requestId = readState(p).verdictRequestId;
  // the reviewer writes its verdict during the wait, after three real polls (~1.5 s): the stop
  // waits for it and routes it, instead of spending a wait (and, three stops later, counting a
  // missing review). The landing is placed inside the wait (landDuring), not on a timer beside
  // it: on a loaded machine the bridge may start later than any timer.
  const env = { ...p.env, PERSEVERANZA_SUBAGENT_WAIT_MS: '20000', ...landDuring(gate(p, 'review.json'), { requestId, blocking: 0, findings: [] }) };
  const tA = Date.now();
  const r0 = spawnSync(NODE, ['--import', LAND, BRIDGE], { input: JSON.stringify({ op: 'stop', cwd: p.dir, event: { session_id: 't-sess' }, facts: { backgroundTasks: RUNNING } }), encoding: 'utf8', env });
  const a = { res: JSON.parse(r0.stdout), ms: Date.now() - tA };
  assert.equal(a.res.outcome, 'pass', JSON.stringify(a.res));
  assert.ok(a.ms >= 1400, `${a.ms} ms`);
  assert.equal(readState(p).counters.subagentWaits, 0);
  const w = journal(p).filter((j) => j.type === 'subagent-wait');
  assert.equal(w.length, 1);
  assert.equal(w[0].landed, 'review.json');
  assert.ok(w[0].ms >= 1400 && w[0].ms < 15000, `waited ${w[0].ms} ms: three polls, then read at once`);
  // nothing lands: the stop waits its window, then answers subagent-running (one wait spent)
  const q = project();
  arm(q, 'real waits, nothing');
  writePlan(q, PLAN);
  stop(q); stop(q);
  const qenv = { ...q.env, PERSEVERANZA_SUBAGENT_WAIT_MS: '1200' };
  const t0 = Date.now();
  const r = JSON.parse(spawnSync(NODE, [BRIDGE], { input: JSON.stringify({ op: 'stop', cwd: q.dir, event: { session_id: 't-sess' }, facts: { backgroundTasks: RUNNING } }), encoding: 'utf8', env: qenv }).stdout);
  assert.equal(r.outcome, 'subagent-running');
  assert.ok(Date.now() - t0 >= 1100, `${Date.now() - t0} ms`);
  assert.equal(readState(q).counters.subagentWaits, 1);
  const qw = journal(q).find((j) => j.type === 'subagent-wait');
  assert.ok(qw && qw.ms >= 1100 && !qw.landed, JSON.stringify(qw));
  // the subagent's return recorded by the mod (activity: subagent-stop) during the wait ends it
  // early (landed inside the wait, dated when it lands), and the stop runs again without it:
  // the reviewer came back without its verdict, so the outcome is asked for (missing), no wait
  // spent (3.0.1: before, the stop answered "still running" and spent a wait)
  const ret = { at: '__NOW__', session: 't-sess', event: 'subagent-stop', tool: '', agent: 'perseveranza:pf-reviewer', pending: [] };
  const r2 = JSON.parse(spawnSync(NODE, ['--import', LAND, BRIDGE], { input: JSON.stringify({ op: 'stop', cwd: q.dir, event: { session_id: 't-sess' }, facts: { backgroundTasks: RUNNING } }), encoding: 'utf8', env: { ...q.env, PERSEVERANZA_SUBAGENT_WAIT_MS: '20000', ...landDuring(gate(q, 'activity.json'), ret, 2), LAND_TRIGGER: gate(q, 'review.json') } }).stdout);
  assert.equal(r2.outcome, 'missing', JSON.stringify(r2));
  assert.equal(readState(q).counters.subagentWaits, 1, 'the earlier wait only');
  // the wait as the bridge measured it (the start of node on a loaded machine is not the wait)
  const last = journal(q).filter((j) => j.type === 'subagent-wait').pop();
  assert.equal(last.returned, true);
  assert.ok(last.ms < 10000, `waited ${last.ms} ms of 20000: ended by the return`);
});

test('bridge stop: the wait is never past the hook\'s deadline, and a stop run again after it queues the mod\'s tokens once', async () => {
  // a deadline too short for the wait and its margin: no wait at all
  const p = project();
  arm(p, 'short deadline');
  writePlan(p, PLAN);
  stop(p); stop(p);
  const r = JSON.parse(spawnSync(NODE, [BRIDGE], { input: JSON.stringify({ op: 'stop', cwd: p.dir, event: { session_id: 't-sess' }, facts: { backgroundTasks: RUNNING } }), encoding: 'utf8', env: { ...p.env, PERSEVERANZA_SUBAGENT_WAIT_MS: '20000', PERSEVERANZA_HOOK_TIMEOUT_MS: '30000' } }).stdout);
  assert.equal(r.outcome, 'subagent-running');
  // no wait at all: every wait is journaled (the wall clock would also count the start of node)
  assert.equal(journal(p).some((j) => j.type === 'subagent-wait'), false);
  // the verdict lands during the wait: the stop runs again, and the mod's delta is queued once
  const q = project();
  arm(q, 'tokens once');
  writePlan(q, PLAN);
  stop(q); stop(q);
  const requestId = readState(q).verdictRequestId;
  const a = JSON.parse(spawnSync(NODE, ['--import', LAND, BRIDGE], { input: JSON.stringify({ op: 'stop', cwd: q.dir, event: { session_id: 't-sess' }, facts: { backgroundTasks: RUNNING, usage: { byAgent: { main: { inputTokens: 7, outputTokens: 3 } } } } }), encoding: 'utf8', env: { ...q.env, PERSEVERANZA_SUBAGENT_WAIT_MS: '20000', ...landDuring(gate(q, 'review.json'), { requestId, blocking: 0, findings: [] }, 2) } }).stdout);
  assert.equal(a.outcome, 'pass', JSON.stringify(a));
  assert.equal(journal(q).filter((j) => j.type === 'subagent-wait' && j.landed === 'review.json').length, 1);
  assert.equal(readdirSync(gate(q, 'usage-inbox')).filter((n) => n.endsWith('.json')).length, 1, 'one delta file');
  assert.equal(readState(q).usage.inputTokens, 7, 'counted once');
});

test('bridge stop: tool mode renders the verbs as the tool; usage from the mod replaces the transcripts', () => {
  const p = project();
  armWithMod(p, 'tool');
  const r = stop(p, { loopMode: 'tool', usage: { byAgent: { main: { inputTokens: 100, outputTokens: 20 }, 'agent-7': { inputTokens: 300, outputTokens: 30, cacheReadTokens: 9 } } } }, { transcript_path: join(p.dir, 'nope.jsonl') });
  assert.equal(r.res.outcome, 'no-plan');
  assert.ok(r.res.decision.block.includes('"args": "<the words after it, if any>"}): complexity low|medium|high'), r.res.decision.block);
  assert.ok(!/node |perseveranza.mjs/.test(r.res.decision.block), r.res.decision.block);
  const u = readState(p).usage;
  assert.equal(u.source, 'mod');
  assert.equal(u.inputTokens, 400);
  assert.deepEqual(Object.keys(u.byAgent).sort(), ['agent-7', 'main']);
  assert.ok(journal(p).some((j) => j.type === 'usage' && j.source === 'mod' && j.spent === 450));
});

test('bridge subagent-stop: a judge without its verdict is sent back twice at most', () => {
  const p = project();
  arm(p, 'judge');
  writePlan(p, PLAN);
  stop(p);
  const toReview = stop(p);
  const id = requestIdFrom(toReview.res.decision.block);
  assert.ok(id);
  const judge = (askedTimes, agent = 'perseveranza:pf-reviewer') => bridge(p, { op: 'subagent-stop', event: { agent_type: agent }, facts: { askedTimes } });
  let r = judge(0);
  assert.equal(r.res.ok, true);
  assert.ok(r.res.decision.block.includes('.perseveranza/review.json is missing') && r.res.decision.block.includes(`"requestId": "${id}"`), r.raw);
  assert.equal(r.res.check.ok, false);
  r = judge(2);
  assert.deepEqual(r.res.decision, { allowStop: true });
  assert.equal(r.res.check.reason, 'asked-enough: missing');
  assert.deepEqual(judge(0, 'pf-executor').res.decision, { allowStop: true });
  writeArtifact(p, 'review.json', { requestId: 'old', blocking: 0 });
  assert.ok(judge(1).res.decision.block.includes('is from an earlier request'));
  writeArtifact(p, 'review.json', { requestId: id, blocking: 0 });
  r = judge(0);
  assert.deepEqual(r.res.decision, { allowStop: true });
  assert.equal(r.res.check.file, 'review.json');
  const checks = journal(p).filter((j) => j.type === 'subagent-check');
  assert.deepEqual(checks.map((c) => c.ok), [false, true, false, true]);
  // the verdict is still there for the Stop to read: the check consumes nothing
  assert.ok(existsSync(gate(p, 'review.json')));
});

test('bridge activity-flush: the heartbeat in the activity hook\'s format, journaled delegations, foreign sessions ignored', () => {
  const p = project();
  assert.equal(bridge(p, { op: 'activity-flush', facts: { activity: { at: 1 } } }).res.outcome, 'dormant');
  arm(p, 'act');
  stop(p); // the session claims the loop
  const at = Date.now();
  const rec = { at, session: 't-sess', event: 'delegate', tool: 'Agent', agent: 'pf-reviewer', pending: [{ at: at - 10, agent: 'pf-reviewer', agentId: 'a1' }], transcript: 'x.jsonl', junk: 'dropped' };
  const r = bridge(p, { op: 'activity-flush', facts: { activity: rec, journal: [{ event: 'delegate', agent: 'pf-reviewer', pending: 1 }] } });
  assert.equal(r.res.ok, true, r.raw);
  assert.equal(r.res.outcome, 'activity');
  const a = JSON.parse(readFileSync(gate(p, 'activity.json'), 'utf8'));
  assert.deepEqual(a, { at, session: 't-sess', event: 'delegate', tool: 'Agent', agent: 'pf-reviewer', pending: [{ at: at - 10, agent: 'pf-reviewer' }], transcript: 'x.jsonl' });
  assert.ok(journal(p).some((j) => j.type === 'activity' && j.event === 'delegate' && j.agent === 'pf-reviewer' && j.via === 'mod' && j.pending === 1));
  // another session's tools are not this loop's life
  const other = bridge(p, { op: 'activity-flush', event: { session_id: 'other' }, facts: { activity: { ...rec, session: 'other', at: at + 5 } } });
  assert.equal(other.res.outcome, 'foreign-session');
  assert.equal(JSON.parse(readFileSync(gate(p, 'activity.json'), 'utf8')).at, at);
  assert.ok(!readdirSync(gate(p, '')).some((n) => n.endsWith('.tmp')), 'no temp file left');
});

// the bridge as an overlapping caller: several processes at once
function bridgeAsync(p, req) {
  return new Promise((resolve) => {
    const c = spawn(NODE, [BRIDGE], { env: p.env });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => { let res = null; try { res = JSON.parse(out); } catch { /* asserted */ } resolve({ code, res, raw: out }); });
    c.stdin.end(JSON.stringify({ cwd: p.dir, ...req, event: { session_id: 't-sess', ...(req.event || {}) } }));
  });
}
const inbox = (p) => { try { return readdirSync(gate(p, 'usage-inbox')); } catch { return null; } };
const hundred = { byAgent: { main: { inputTokens: 100, outputTokens: 0 } } };

test('bridge usage-flush: a file of its own in the inbox, state.json untouched byte for byte; the next stop adds it', () => {
  const p = project();
  arm(p, 'usage');
  stop(p);
  const before = readFileSync(gate(p, 'state.json'), 'utf8');
  const flush = (byAgent, event = {}) => bridge(p, { op: 'usage-flush', event, facts: { usage: { byAgent } } });
  let r = flush({ main: { inputTokens: 10, outputTokens: 1 }, a1: { inputTokens: 100, outputTokens: 10 } });
  assert.equal(r.res.ok, true, r.raw);
  assert.equal(r.res.outcome, 'usage-queued');
  assert.ok(/^\d+-\d+-[0-9a-f]+\.json$/.test(r.res.file), r.res.file);
  r = flush({ a1: { inputTokens: 5, outputTokens: 5 }, a2: { inputTokens: 1, outputTokens: 0 } });
  assert.equal(inbox(p).length, 2);
  assert.equal(readFileSync(gate(p, 'state.json'), 'utf8'), before, 'a flush never writes state.json');
  // another session's tokens are not this loop's; no usage is no file
  assert.equal(flush({ a9: { inputTokens: 999 } }, { session_id: 'other' }).res.outcome, 'foreign-session');
  assert.equal(bridge(p, { op: 'usage-flush', facts: {} }).res.outcome, 'no-usage');
  assert.equal(inbox(p).length, 2);
  // status counts what waits in the inbox
  const st = cli(p, 'status');
  assert.ok(st.out.includes('(incl. 2 flush(es) still in the inbox)') && st.out.includes('by agent:'), st.out);
  assert.equal(inbox(p).length, 2, 'status moves nothing');
  // the next Stop adds the inbox and its own delta, then empties the inbox
  const s = stop(p, { usage: { byAgent: { main: { inputTokens: 4, outputTokens: 0 } } } });
  assert.equal(s.res.ok, true);
  const after = readState(p);
  assert.equal(after.usage.inputTokens, 120);
  assert.deepEqual(after.usage.byAgent.a1, { inputTokens: 105, outputTokens: 15, cacheReadTokens: 0, cacheCreationTokens: 0 });
  // the stop's own delta went through the inbox too: three files, counted and named, removed
  // by the next stop
  assert.equal(inbox(p).length, 3);
  assert.deepEqual([...after.usageInboxSeen].sort(), [...inbox(p)].sort());
  assert.ok(journal(p).some((j) => j.type === 'usage-inbox' && j.files === 3));
  // the budget sees what the inbox brought: a cap below it ends the run at the next stop
  patchState(p, (x) => { x.limits.maxTokens = 200; });
  flush({ a3: { inputTokens: 100, outputTokens: 0 } });
  assert.equal(stop(p).res.outcome, 'budget');
  assert.equal(readState(p), null, 'archived and disarmed');
});

test('bridge usage-flush: a v1 state is never rewritten (the next Stop migrates it), the delta still waits', () => {
  const p = project();
  arm(p, 'v1');
  const v1 = JSON.stringify({ phase: 'review', task: 't', iterations: 2, max: 25, sessionId: 't-sess' }, null, 2);
  writeFileSync(gate(p, 'state.json'), v1);
  const r = bridge(p, { op: 'usage-flush', facts: { usage: hundred } });
  assert.equal(r.res.outcome, 'usage-queued', r.raw);
  assert.equal(readFileSync(gate(p, 'state.json'), 'utf8'), v1, 'byte for byte');
  assert.equal(inbox(p).length, 1);
  const s = stop(p);
  assert.equal(s.res.ok, true);
  const st = readState(p);
  assert.equal(st.schemaVersion, 2);
  assert.equal(st.usage.inputTokens, 100);
});

test('bridge usage-flush: 8 flushes in parallel are 800 tokens exactly after one stop', async () => {
  const p = project();
  arm(p, 'parallel');
  stop(p);
  const rs = await Promise.all(Array.from({ length: 8 }, () => bridgeAsync(p, { op: 'usage-flush', facts: { usage: hundred } })));
  for (const r of rs) assert.equal(r.res && r.res.outcome, 'usage-queued', r.raw);
  assert.equal(inbox(p).length, 8);
  stop(p);
  assert.equal(readState(p).usage.inputTokens, 800);
  stop(p);
  assert.equal(readState(p).usage.inputTokens, 800);
  assert.deepEqual(inbox(p), []);
});

test('bridge: stops and flushes overlapping lose nothing and count nothing twice', async () => {
  const p = project();
  // every overlapping stop now counts its iteration (none is overwritten): a cap far away
  arm(p, 'overlap', ['--max', '100']);
  stop(p);
  let sent = 0;
  for (let round = 0; round < 3; round++) {
    const calls = [bridgeAsync(p, { op: 'stop' })];
    for (let i = 0; i < 4; i++) { calls.push(bridgeAsync(p, { op: 'usage-flush', facts: { usage: hundred } })); sent += 100; }
    calls.push(bridgeAsync(p, { op: 'stop' }));
    const rs = await Promise.all(calls);
    for (const r of rs) assert.equal(r.res && r.res.ok, true, r.raw);
  }
  stop(p);
  assert.equal(readState(p).usage.inputTokens, sent);
  stop(p);
  assert.equal(readState(p).usage.inputTokens, sent);
  assert.deepEqual(inbox(p), []);
});

test('bridge: concurrent stops never count the same inbox file twice', async () => {
  const p = project();
  arm(p, 'stops');
  stop(p);
  for (let i = 0; i < 3; i++) bridge(p, { op: 'usage-flush', facts: { usage: hundred } });
  const rs = await Promise.all([bridgeAsync(p, { op: 'stop' }), bridgeAsync(p, { op: 'stop' }), bridgeAsync(p, { op: 'stop' })]);
  for (const r of rs) assert.equal(r.res && r.res.ok, true, r.raw);
  stop(p);
  assert.equal(readState(p).usage.inputTokens, 300);
  // a file left behind by a crash after the save (named in the state) is skipped, then removed
  const f = bridge(p, { op: 'usage-flush', facts: { usage: hundred } }).res.file;
  const kept = readFileSync(gate(p, `usage-inbox/${f}`), 'utf8');
  stop(p);
  assert.equal(readState(p).usage.inputTokens, 400);
  assert.ok(readState(p).usageInboxSeen.includes(f), 'named until the next stop confirms it gone');
  writeFileSync(gate(p, `usage-inbox/${f}`), kept); // the removal "did not happen"
  stop(p);
  assert.equal(readState(p).usage.inputTokens, 400, 'counted once');
  assert.deepEqual(inbox(p), []);
});

test('bridge: a corrupt inbox file is set aside and noted, never a crash; a fresh one may still be being written', () => {
  const p = project();
  arm(p, 'corrupt');
  stop(p);
  bridge(p, { op: 'usage-flush', facts: { usage: hundred } });
  const old = gate(p, 'usage-inbox/1-1-old.json');
  writeFileSync(old, '{"byAgent": {');
  const past = new Date(Date.now() - 60_000);
  utimesSync(old, past, past);
  writeFileSync(gate(p, 'usage-inbox/2-2-nobyagent.json'), '{"at": 1}');
  utimesSync(gate(p, 'usage-inbox/2-2-nobyagent.json'), past, past);
  writeFileSync(gate(p, 'usage-inbox/3-3-fresh.json'), '{"byAg');
  const r = stop(p);
  assert.equal(r.res.ok, true, r.raw);
  assert.equal(readState(p).usage.inputTokens, 100);
  const named = readState(p).usageInboxSeen;
  assert.deepEqual(inbox(p).filter((n) => !named.includes(n)).sort(), ['1-1-old.json.invalid', '2-2-nobyagent.json.invalid', '3-3-fresh.json']);
  const notes = journal(p).filter((j) => j.type === 'note' && j.text.startsWith('usage inbox:'));
  assert.equal(notes.length, 2, JSON.stringify(notes));
});

test('bridge: an empty or absent inbox changes nothing; the stop\'s own delta goes through it', () => {
  const p = project();
  arm(p, 'empty');
  stop(p);
  assert.equal(inbox(p), null, 'no delta, no inbox');
  stop(p, { usage: hundred });
  assert.equal(readState(p).usage.inputTokens, 100, 'counted at once');
  assert.equal(inbox(p).length, 1, 'as a file of the inbox, named in the state that counts it');
  assert.deepEqual(readState(p).usageInboxSeen, inbox(p));
  stop(p);
  assert.deepEqual(inbox(p), [], 'removed by the next stop');
  assert.equal(readState(p).usage.inputTokens, 100);
  const n = journal(p).filter((j) => j.type === 'usage-inbox').length;
  const r = stop(p);
  assert.equal(r.res.ok, true);
  assert.equal(readState(p).usage.inputTokens, 100);
  assert.equal(journal(p).filter((j) => j.type === 'usage-inbox').length, n, 'an empty inbox: nothing counted');
});

test('bridge stop: the changes an executor made while the turn waited go to review, not to idle', () => {
  const p2 = project({ git: true });
  arm(p2, 'tree');
  stop(p2);
  writePlan(p2, PLAN);
  let r = stop(p2);
  assert.equal(r.res.outcome, 'ready');
  writeFileSync(join(p2.dir, 'feature.js'), 'export const x = 1;\n');
  r = stop(p2, { backgroundTasks: [{ id: 'e1', type: 'local_agent', status: 'running', agent_type: 'perseveranza:pf-executor', description: 'step one' }] });
  assert.equal(r.res.outcome, 'subagent-running', r.raw);
  r = stop(p2);
  assert.equal(r.res.outcome, 'always', r.raw);
  assert.equal(readState(p2).phase, 'review');
});

test('bridge subagent-stop: no request id -> let go and noted; the Italian pack says why in Italian', () => {
  const p = project();
  arm(p, 'noid');
  writePlan(p, PLAN);
  stop(p); stop(p); // -> review
  patchState(p, (s) => { s.verdictRequestId = null; });
  let r = bridge(p, { op: 'subagent-stop', event: { agent_type: 'pf-reviewer' }, facts: {} });
  assert.deepEqual(r.res.decision, { allowStop: true });
  assert.equal(r.res.check.reason, 'no-request');
  assert.ok(journal(p).some((j) => j.type === 'subagent-check' && j.reason === 'no-request'));
  patchState(p, (s) => { s.verdictRequestId = 'R9'; s.options.lang = 'it'; });
  r = bridge(p, { op: 'subagent-stop', event: { agent_type: 'pf-reviewer' }, facts: {} });
  assert.ok(r.res.decision.block.includes('.perseveranza/review.json risulta assente') && r.res.decision.block.includes('"requestId": "R9"'), r.res.decision.block);
  writeArtifact(p, 'review.json', '{"blocking": "x"}');
  r = bridge(p, { op: 'subagent-stop', event: { agent_type: 'pf-reviewer' }, facts: {} });
  assert.ok(r.res.decision.block.includes('risulta illeggibile (blocking must be'), r.res.decision.block);
  assert.ok(!/missing|malformed/.test(r.res.decision.block), r.res.decision.block);
  writeArtifact(p, 'review.json', { requestId: 'R1', blocking: 0 });
  r = bridge(p, { op: 'subagent-stop', event: { agent_type: 'pf-reviewer' }, facts: {} });
  assert.ok(r.res.decision.block.includes('di una richiesta precedente'), r.res.decision.block);
});

test('bridge errors: an answer with ok:false, exit 0, never a crash', () => {
  const p = project();
  for (const raw of ['{not json', '[]', '"x"', '']) {
    const r = bridge(p, null, raw);
    assert.equal(r.code, 0, raw);
    assert.equal(r.res.ok, false, `${raw}: ${r.raw}`);
    assert.equal(typeof r.res.error, 'string');
    assert.equal(r.stderr, '');
  }
  assert.ok(bridge(p, { op: 'explode' }).res.error.includes('unknown op'));
  const noCwd = bridge(p, null, JSON.stringify({ op: 'stop', event: {} }));
  assert.deepEqual(noCwd.res, { ok: false, error: 'cwd missing' });
  // a corrupt state: the Stop logic disarms it (archived), the bridge answers
  arm(p, 'corrupt');
  writeFileSync(gate(p, 'state.json'), '{garbage');
  const r = stop(p);
  assert.equal(r.code, 0);
  assert.deepEqual(r.res, { ok: true, decision: { allowStop: true }, outcome: 'corrupt-state' });
});

// ---------------------------------------------------------------- state.json busy, inbox not writable
// A preload that makes every read of state.json EBUSY (FAULT_BUSY=1) or every write into the
// usage inbox ENOSPC (FAULT_INBOX=1), in the bridge process only.
const FAULT = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const err = (code) => Object.assign(new Error(code), { code });
const read = fs.readFileSync, write = fs.writeFileSync, ren = fs.renameSync, rm = fs.rmSync, unl = fs.unlinkSync;
const E = process.env;
// a final inbox file (not a temporary)
const box = (p) => /usage-inbox[\\\\/][^\\\\/]+\\.json$/.test(String(p));
const seen = new Set();
fs.readFileSync = function (p, ...a) {
  if (E.FAULT_BUSY === '1' && /state\\.json$/.test(String(p))) throw err('EBUSY');
  // FAULT_AV: an antivirus scanning a new file, the first read of each one refused
  if (E.FAULT_AV === '1' && box(p) && !seen.has(String(p))) { seen.add(String(p)); throw err('EBUSY'); }
  if (E.FAULT_UNV === '1' && box(p)) throw err('EBUSY');
  // FAULT_VANISH: an overlapping stop removes the file between the listing and the read
  if (E.FAULT_VANISH === '1' && box(p)) unl.call(fs, p);
  return read.call(this, p, ...a);
};
fs.writeFileSync = function (p, ...a) { if (E.FAULT_INBOX === '1' && /usage-inbox/.test(String(p))) throw err('ENOSPC'); return write.call(this, p, ...a); };
// FAULT_UNV: the file lands but cannot be confirmed (rename refused, every read refused); FAULT_NORM: nor removed
fs.renameSync = function (a, b) { if (E.FAULT_UNV === '1' && box(b)) throw err('EPERM'); return ren.call(this, a, b); };
fs.rmSync = function (p, ...a) { if (E.FAULT_NORM === '1' && box(p)) throw err('EPERM'); return rm.call(this, p, ...a); };
fs.unlinkSync = function (p, ...a) { if (E.FAULT_NORM === '1' && box(p)) throw err('EPERM'); return unl.call(this, p, ...a); };
syncBuiltinESMExports();
`;
function faulty(p, req, fault) {
  const pre = join(p.env.PERSEVERANZA_HOME, 'fault-preload.mjs'); // the test's own home folder
  writeFileSync(pre, FAULT);
  const input = JSON.stringify({ cwd: p.dir, ...req, event: { session_id: 't-sess', ...(req.event || {}) } });
  const r = spawnSync(NODE, ['--import', pathToFileURL(pre).href, BRIDGE], { input, encoding: 'utf8', env: { ...p.env, ...fault } });
  return { code: r.status, res: JSON.parse(r.stdout), raw: r.stdout };
}
const BUSY = { FAULT_BUSY: '1' };

test('bridge usage-flush with state.json busy: not no-loop; the delta is queued (armUnknown) and counted by the next stop', () => {
  const p = project();
  arm(p, 'busy flush', ['--max', '100']);
  stop(p);
  const r = faulty(p, { op: 'usage-flush', facts: { usage: { byAgent: { main: { inputTokens: 500, outputTokens: 0 } } } } }, BUSY);
  assert.equal(r.code, 0);
  assert.equal(r.res.ok, true, r.raw);
  assert.equal(r.res.outcome, 'usage-queued');
  assert.equal(r.res.armUnknown, true);
  stop(p);
  assert.equal(readState(p).usage.inputTokens, 500);
  // and without a loop it is still no-loop
  assert.equal(cli(p, 'disarm').code, 0);
  assert.deepEqual(faulty(p, { op: 'usage-flush', facts: { usage: { byAgent: { main: { inputTokens: 1 } } } } }, BUSY).res, { ok: false, error: 'no-loop' });
});

test('bridge subagent-stop with state.json busy: a judge is sent back with the reason (fail closed), twice at most; another agent is let go', () => {
  const p = project();
  arm(p, 'busy judge');
  stop(p);
  const judge = (askedTimes, agent = 'perseveranza:pf-reviewer') => faulty(p, { op: 'subagent-stop', event: { agent_type: agent }, facts: { askedTimes } }, BUSY).res;
  let r = judge(0);
  assert.equal(r.outcome, 'busy');
  assert.ok(r.decision.block && /state\.json held by a sync client/.test(r.decision.block), JSON.stringify(r));
  assert.ok(judge(1).decision.block);
  r = judge(2);
  assert.deepEqual(r.decision, { allowStop: true });
  assert.equal(r.check.reason, 'asked-enough: busy');
  assert.ok(journal(p).some((j) => j.type === 'subagent-check' && j.reason === 'busy'));
  r = judge(0, 'general-purpose');
  assert.deepEqual(r.decision, { allowStop: true });
  assert.equal(r.outcome, 'busy');
});

test('bridge activity-flush with state.json busy: a retryable busy, nothing written; dormant only without a loop', () => {
  const p = project();
  arm(p, 'busy beat');
  stop(p);
  const act = { activity: { at: Date.now(), session: 't-sess', event: 'tool' } };
  const r = faulty(p, { op: 'activity-flush', facts: act }, BUSY);
  assert.deepEqual(r.res, { ok: false, error: 'busy', retry: true });
  assert.ok(!existsSync(gate(p, 'activity.json')));
  assert.equal(bridge(p, { op: 'activity-flush', facts: act }).res.outcome, 'activity');
});

test('bridge stop whose own delta cannot be queued (inbox not writable): the answer says usageDropped, and nothing is counted twice', () => {
  const p = project();
  arm(p, 'inbox full', ['--max', '100']);
  stop(p);
  const r = faulty(p, { op: 'stop', facts: { usage: { byAgent: { main: { inputTokens: 300, outputTokens: 0 } } } } }, { FAULT_INBOX: '1' });
  assert.equal(r.res.ok, true);
  assert.equal(r.res.usageDropped, 'not writable', r.raw);
  assert.ok(journal(p).some((j) => j.type === 'note' && /could not be queued/.test(j.text)));
  // dropped means never counted: no file of it is left in the inbox
  assert.deepEqual(inboxFiles(p), []);
  // a normal stop carries no such field
  assert.equal(stop(p, { usage: { byAgent: { main: { inputTokens: 300, outputTokens: 0 } } } }).res.usageDropped, undefined);
  stop(p);
  assert.equal(readState(p).usage.inputTokens, 300);
});

// ---------------------------------------------------------------- round 10: dropped vs counted, corrupt, language
function inboxFiles(p) { try { return readdirSync(gate(p, 'usage-inbox')); } catch { return []; } }
const tokens = (n) => ({ usage: { byAgent: { main: { inputTokens: n, outputTokens: 0 } } } });

test('bridge with an antivirus refusing the first read of each new inbox file: stop and flush deltas are queued, never reported dropped, counted once', () => {
  const p = project();
  arm(p, 'antivirus', ['--max', '100']);
  stop(p);
  const AV = { FAULT_AV: '1' };
  const s = faulty(p, { op: 'stop', facts: tokens(300) }, AV);
  assert.equal(s.res.ok, true);
  assert.equal(s.res.usageDropped, undefined, s.raw);
  assert.equal(s.res.usageUnverified, undefined, s.raw);
  const f = faulty(p, { op: 'usage-flush', facts: tokens(500) }, AV);
  assert.equal(f.res.outcome, 'usage-queued', f.raw);
  assert.equal(f.res.unverified, undefined);
  stop(p);
  stop(p);
  assert.equal(readState(p).usage.inputTokens, 800);
  // a refusal of a moment on a new file is not worth a note
  assert.ok(!journal(p).some((j) => j.type === 'note' && /cannot be read/.test(j.text)));
});

test('an inbox file older than the settle time whose read is refused is not set aside: counted at the next stop', () => {
  const p = project();
  arm(p, 'old busy', ['--max', '100']);
  stop(p);
  assert.equal(bridge(p, { op: 'usage-flush', facts: tokens(70) }).res.outcome, 'usage-queued');
  const [name] = inboxFiles(p);
  const old = (Date.now() - 60000) / 1000;
  utimesSync(gate(p, join('usage-inbox', name)), old, old);
  faulty(p, { op: 'stop' }, { FAULT_AV: '1' });
  assert.deepEqual(inboxFiles(p).filter((n) => n.endsWith('.invalid')), []);
  stop(p);
  assert.equal(readState(p).usage.inputTokens, 70);
});

test('bridge stop whose delta lands but can be neither confirmed nor removed: usageUnverified (never resend), not usageDropped, counted once', () => {
  const p = project();
  arm(p, 'unverified', ['--max', '100']);
  stop(p);
  const r = faulty(p, { op: 'stop', facts: tokens(300) }, { FAULT_UNV: '1', FAULT_NORM: '1' });
  assert.equal(r.res.usageDropped, undefined, r.raw);
  assert.ok(r.res.usageUnverified, r.raw);
  assert.ok(journal(p).some((j) => j.type === 'note' && /written in place and not confirmed/.test(j.text)));
  const f = faulty(p, { op: 'usage-flush', facts: tokens(500) }, { FAULT_UNV: '1', FAULT_NORM: '1' });
  assert.equal(f.res.ok, true, f.raw);
  assert.equal(f.res.unverified, true);
  stop(p);
  stop(p);
  assert.equal(readState(p).usage.inputTokens, 800);
});

test('bridge with state.json corrupt (no pending copy): not no-loop nor dormant; queued as armUnknown, a judge sent back, a heartbeat refused', () => {
  const p = project();
  arm(p, 'corrupt');
  stop(p);
  writeFileSync(gate(p, 'state.json'), '{"phase":');
  const f = bridge(p, { op: 'usage-flush', facts: tokens(5) });
  assert.equal(f.res.outcome, 'usage-queued', f.raw);
  assert.equal(f.res.armUnknown, true);
  const j = bridge(p, { op: 'subagent-stop', event: { agent_type: 'perseveranza:pf-verifier' }, facts: { askedTimes: 0 } });
  assert.equal(j.res.outcome, 'corrupt');
  assert.ok(j.res.decision.block, j.raw);
  assert.deepEqual(bridge(p, { op: 'activity-flush', facts: { activity: { at: Date.now(), session: 't-sess', event: 'tool' } } }).res, { ok: false, error: 'corrupt', retry: true });
});

test('bridge busy judge: the reason in the language arm would pick (PERSEVERANZA_LANG), or in facts.lang', () => {
  const p = project();
  arm(p, 'busy lang');
  stop(p);
  const req = (facts) => ({ op: 'subagent-stop', event: { agent_type: 'perseveranza:pf-reviewer' }, facts: { askedTimes: 0, ...facts } });
  assert.match(faulty(p, req({}), { ...BUSY, PERSEVERANZA_LANG: 'it' }).res.decision.block, /tenuto da un client di sincronizzazione/);
  assert.match(faulty(p, req({ lang: 'it' }), BUSY).res.decision.block, /tenuto da un client di sincronizzazione/);
  assert.match(faulty(p, req({ lang: 'IT' }), BUSY).res.decision.block, /tenuto da un client di sincronizzazione/, 'any case');
  assert.match(faulty(p, req({}), BUSY).res.decision.block, /held by a sync client/);
});

test('bridge usage-flush with state.json busy from another session: queued with that session, never counted for the owner', () => {
  const p = project();
  arm(p, 'busy foreign', ['--max', '100']);
  stop(p);
  const r = faulty(p, { op: 'usage-flush', event: { session_id: 'other-sess' }, facts: tokens(400) }, BUSY);
  assert.equal(r.res.outcome, 'usage-queued', r.raw);
  stop(p);
  stop(p);
  assert.equal(readState(p).usage.inputTokens, 0);
  assert.ok(journal(p).some((j) => j.type === 'note' && /another session/.test(j.text)));
});

test('bridge activity-flush: the session is the activity record\'s, not only the event\'s; another session\'s heartbeat is not written', () => {
  const p = project();
  arm(p, 'beat session');
  stop(p);
  const r = bridge(p, { op: 'activity-flush', facts: { activity: { at: Date.now(), session: 'other-sess', event: 'tool' } } });
  assert.equal(r.res.outcome, 'foreign-session', r.raw);
  assert.ok(!existsSync(gate(p, 'activity.json')));
});

test('bridge reads a pending copy beside a corrupt state.json but never promotes it (the next stop does)', () => {
  const p = project();
  arm(p, 'pending read', ['--max', '100']);
  stop(p);
  const good = readFileSync(gate(p, 'state.json'), 'utf8');
  writeFileSync(gate(p, 'state.json.pending'), good);
  writeFileSync(gate(p, 'state.json'), '{"phase":');
  const r = bridge(p, { op: 'usage-flush', facts: tokens(9) });
  assert.equal(r.res.outcome, 'usage-queued', r.raw);
  assert.equal(r.res.armUnknown, undefined, 'the pending copy gave the arm');
  assert.equal(readFileSync(gate(p, 'state.json'), 'utf8'), '{"phase":', 'not promoted by the bridge');
  assert.ok(existsSync(gate(p, 'state.json.pending')));
  stop(p);
  stop(p);
  assert.equal(readState(p).usage.inputTokens, 9);
});

test('bridge stop whose delta was written in place unconfirmed, even if it could be removed: unverified (a stop may have counted it), left there, counted once with no resend', () => {
  const p = project();
  arm(p, 'in place unconfirmed', ['--max', '100']);
  stop(p);
  const r = faulty(p, { op: 'stop', facts: tokens(300) }, { FAULT_UNV: '1' });
  assert.equal(r.res.usageDropped, undefined, r.raw);
  assert.ok(r.res.usageUnverified, r.raw);
  assert.equal(inboxFiles(p).filter((n) => n.endsWith('.json')).length, 1, 'not removed');
  stop(p);
  stop(p);
  assert.equal(readState(p).usage.inputTokens, 300);
});

test('bridge stop: a file listed and then removed by an overlapping stop before its read is skipped, never journaled as set aside', () => {
  const p = project();
  arm(p, 'vanish', ['--max', '100']);
  stop(p);
  assert.equal(bridge(p, { op: 'usage-flush', facts: tokens(5) }).res.outcome, 'usage-queued');
  faulty(p, { op: 'stop' }, { FAULT_VANISH: '1' });
  assert.ok(!journal(p).some((j) => j.type === 'note' && /set aside|invalid/.test(j.text)), JSON.stringify(journal(p).filter((j) => j.type === 'note')));
});


test('bridge stop with a hostile background task (status {"toString":1}): an answer with a decision, and the loop moves on', () => {
  const p = project();
  arm(p, 'hostile tasks');
  writePlan(p, PLAN);
  stop(p);
  const it = readState(p).counters.iterations;
  const raw = `{"op":"stop","cwd":${JSON.stringify(p.dir)},"event":{"session_id":"t-sess"},"facts":{"backgroundTasks":[{"status":{"toString":1},"agent_type":"pf-executor"},["x"],null]}}`;
  const r = bridge(p, null, raw);
  assert.equal(r.res.ok, true, r.raw);
  assert.ok(r.res.decision.block, r.raw);
  assert.equal(readState(p).counters.iterations, it + 1);
});
