// How the state reaches the disk (state-file.mjs): a full disk never empties state.json, a save
// cut short leaves a complete pending copy that the next load promotes, a verb never saves a
// stale copy over a Stop's, and the Stop keeps what a verb wrote while it ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, rmSync, mkdirSync, utimesSync, renameSync as realRename } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { project, cli, arm, readState, patchState, gate, journal, readFileSync, writeFileSync, existsSync, join, NODE, CLI, spawnSync } from '../helpers/cli.mjs';
import { runStopFromFacts, savedCounts } from '../../src/shell/stop-core.mjs';
import { writeUsageDelta } from '../../src/shell/usage-inbox.mjs';
import { writeDurable, loadStateFile, updateState, readRetainedState, PENDING, UNSAVED_STATE } from '../../src/shell/state-file.mjs';
import { saveStateVerified } from '../../src/shell/effects.mjs';
import { gatePaths } from '../../src/shell/paths.mjs';
import { RETAINED_STATE } from '../../src/shell/archive.mjs';

const enospc = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
const eperm = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
const isTmp = (p) => /\.tmp$/.test(String(p));
const stopIn = (p, io = {}) => runStopFromFacts({ evt: { cwd: p.dir, session_id: 't-sess' }, env: p.env, io });
const inbox = (p) => { try { return readdirSync(gate(p, 'usage-inbox')).sort(); } catch { return []; } };
const delta = (p, n) => writeUsageDelta(gate(p, ''), { session: 't-sess', arm: readState(p).armedAt, byAgent: { main: { inputTokens: n, outputTokens: 0 } } });
const spent = (p) => readState(p).usage.inputTokens;
const gateFiles = (p) => readdirSync(gate(p, ''));
function pausedLoop() {
  const p = project();
  arm(p, 'state files');
  stopIn(p);
  patchState(p, (s) => { s.signals.paused = true; });
  return p;
}
function scratch() {
  const p = project();
  mkdirSync(gate(p, ''), { recursive: true });
  const target = gate(p, 'f.json');
  writeFileSync(target, 'OLD');
  return { p, target };
}

// ---------------------------------------------------------------- writeDurable, rule by rule
test('writeDurable (a): ENOSPC on the temporary -> the save fails and the target is never touched', () => {
  const { p, target } = scratch();
  // a full disk writes part of the temporary, then throws
  const fs = { writeFileSync: (path, text) => { if (isTmp(path)) { writeFileSync(path, String(text).slice(0, 3)); throw enospc(); } return writeFileSync(path, text); } };
  const r = writeDurable(target, 'NEW CONTENT', { fs, keepPending: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /temporary: ENOSPC/);
  assert.equal(readFileSync(target, 'utf8'), 'OLD', 'not emptied, not written in place');
  assert.deepEqual(gateFiles(p), ['f.json'], 'no temporary and no pending left');
  // a temporary that silently lands short is the same failure
  const short = { writeFileSync: (path, text) => writeFileSync(path, isTmp(path) ? String(text).slice(0, 4) : text) };
  const r2 = writeDurable(target, 'NEW CONTENT', { fs: short, keepPending: true });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /temporary incomplete/);
  assert.equal(readFileSync(target, 'utf8'), 'OLD');
  assert.deepEqual(gateFiles(p), ['f.json']);
});

test('writeDurable (b): the rename refused twice, then accepted -> an atomic save', () => {
  const { p, target } = scratch();
  let refused = 0;
  const fs = { renameSync: (a, b) => { if (refused < 2) { refused++; throw eperm(); } return realRename(a, b); } };
  const r = writeDurable(target, 'NEW', { fs, keepPending: true });
  assert.deepEqual([r.ok, r.atomic, refused], [true, true, 2]);
  assert.equal(readFileSync(target, 'utf8'), 'NEW');
  assert.deepEqual(gateFiles(p), ['f.json']);
});

test('writeDurable (c): in place only with a complete temporary; cut short, the copy stays as .pending', () => {
  const { p, target } = scratch();
  const noRename = { renameSync: (a, b) => { if (b === target) throw eperm(); return realRename(a, b); } };
  // rename always refused, the write in place succeeds: ok, temporary removed
  let r = writeDurable(target, 'IN PLACE', { fs: noRename, keepPending: true });
  assert.deepEqual([r.ok, r.atomic], [true, false]);
  assert.equal(readFileSync(target, 'utf8'), 'IN PLACE');
  assert.deepEqual(gateFiles(p), ['f.json']);
  // ENOSPC in place after truncating the target: the complete copy is kept as .pending
  const fullInPlace = { ...noRename, writeFileSync: (path, text) => { if (path === target) { writeFileSync(path, ''); throw enospc(); } return writeFileSync(path, text); } };
  r = writeDurable(target, 'WHOLE TEXT', { fs: fullInPlace, keepPending: true });
  assert.deepEqual([r.ok, r.pending], [false, true]);
  assert.match(r.error, /in place: ENOSPC/);
  assert.equal(readFileSync(`${target}${PENDING}`, 'utf8'), 'WHOLE TEXT');
  assert.deepEqual(gateFiles(p).sort(), ['f.json', `f.json${PENDING}`]);
  // a write in place that lands truncated without an error: the read back catches it
  const truncating = { ...noRename, writeFileSync: (path, text) => writeFileSync(path, path === target ? String(text).slice(0, 5) : text) };
  r = writeDurable(target, 'ANOTHER WHOLE TEXT', { fs: truncating, keepPending: true });
  assert.deepEqual([r.ok, r.pending], [false, true]);
  assert.equal(readFileSync(`${target}${PENDING}`, 'utf8'), 'ANOTHER WHOLE TEXT');
  // the next good save supersedes the pending copy
  r = writeDurable(target, 'GOOD', { keepPending: true });
  assert.equal(r.ok, true);
  assert.deepEqual(gateFiles(p), ['f.json']);
});

// ---------------------------------------------------------------- the pending copy on load
test('loadStateFile: an empty, corrupt or absent state.json with a valid pending copy is promoted (state-recovered)', () => {
  for (const damage of ['empty', 'corrupt', 'absent']) {
    const p = project();
    arm(p, `recover ${damage}`);
    const paths = gatePaths(p.dir);
    const good = readFileSync(paths.statePath, 'utf8');
    writeFileSync(`${paths.statePath}${PENDING}`, good);
    if (damage === 'empty') writeFileSync(paths.statePath, '');
    if (damage === 'corrupt') writeFileSync(paths.statePath, good.slice(0, 40));
    if (damage === 'absent') rmSync(paths.statePath);
    const r = loadStateFile(paths);
    assert.equal(r.recovered, true, damage);
    assert.equal(r.state.task, `recover ${damage}`);
    assert.equal(readFileSync(paths.statePath, 'utf8'), good, 'promoted over state.json');
    assert.ok(!existsSync(`${paths.statePath}${PENDING}`), 'the pending copy is consumed');
    assert.ok(journal(p).some((j) => j.type === 'state-recovered' && j.promoted === true), damage);
    // the verbs see the loop
    assert.equal(cli(p, 'status').code, 0, damage);
  }
});

test('loadStateFile: no promotion for a retained run, a stale pending copy or an invalid one; corrupt stays corrupt', () => {
  // a run retained after an archive failure is disarmed: its pending copy must not re-arm it
  const p = project();
  arm(p, 'retained');
  const paths = gatePaths(p.dir);
  const good = readFileSync(paths.statePath, 'utf8');
  writeFileSync(`${paths.statePath}${PENDING}`, good);
  writeFileSync(join(paths.gateDir, RETAINED_STATE), good);
  rmSync(paths.statePath);
  assert.equal(loadStateFile(paths).state, null);
  assert.equal(stopIn(p).outcome, 'dormant');
  assert.ok(!existsSync(paths.statePath), 'not re-armed');
  // a pending copy much older than the corrupt state.json is not the copy of its last write
  const q = project();
  arm(q, 'stale pending');
  const qp = gatePaths(q.dir);
  writeFileSync(`${qp.statePath}${PENDING}`, readFileSync(qp.statePath, 'utf8'));
  const old = (Date.now() - 10 * 60 * 1000) / 1000;
  utimesSync(`${qp.statePath}${PENDING}`, old, old);
  writeFileSync(qp.statePath, '{ torn');
  assert.equal(loadStateFile(qp, { journal: false }).state, null);
  assert.equal(stopIn(q).outcome, 'corrupt-state', 'as today: archived for forensics');
  // an invalid pending copy is ignored; corrupt without a usable copy stays corrupt
  const r = project();
  arm(r, 'bad pending');
  const rp = gatePaths(r.dir);
  writeFileSync(`${rp.statePath}${PENDING}`, '{ also torn');
  writeFileSync(rp.statePath, '');
  assert.equal(loadStateFile(rp).state, null);
  assert.match(cli(r, 'status').out, /unreadable|not a loop state/);
});

// ---------------------------------------------------------------- the Stop on a full disk
test('full disk: paused loop with 500 tokens + a 300-token flush, a Stop with ENOSPC on both writes, then free disk -> alive, 800', () => {
  const p = pausedLoop();
  delta(p, 500);
  stopIn(p);
  assert.equal(spent(p), 500);
  delta(p, 300);
  const statePath = gate(p, 'state.json');
  const before = readFileSync(statePath, 'utf8');
  const full = { writeFileSync: (path, text) => { if (isTmp(path) || path === statePath) { if (path === statePath) writeFileSync(path, ''); throw enospc(); } return writeFileSync(path, text); } };
  const r = stopIn(p, { fs: full });
  assert.equal(r.outcome, 'paused', 'the Stop still answers');
  assert.equal(readFileSync(statePath, 'utf8'), before, 'state.json not emptied');
  assert.equal(inbox(p).length, 1, 'the 300 wait in the inbox');
  assert.ok(journal(p).some((j) => j.type === 'state-save-failed' && /ENOSPC/.test(j.error)));
  // disk free again
  stopIn(p);
  assert.equal(spent(p), 800);
  assert.equal(readState(p).signals.paused, true, 'the loop is alive');
  stopIn(p);
  assert.equal(spent(p), 800);
  assert.deepEqual(inbox(p), [], 'removed by the stop after the one that counted it');
});

test('full disk in place: the temporary whole, the rename refused, state.json emptied -> the next Stop recovers the pending copy, counted once', () => {
  const p = pausedLoop();
  delta(p, 500);
  stopIn(p);
  delta(p, 300);
  const statePath = gate(p, 'state.json');
  const fs = {
    renameSync: (a, b) => { if (b === statePath) throw eperm(); return realRename(a, b); },
    writeFileSync: (path, text) => { if (path === statePath) { writeFileSync(path, ''); throw enospc(); } return writeFileSync(path, text); },
  };
  stopIn(p, { fs });
  assert.equal(readFileSync(statePath, 'utf8'), '', 'the write in place emptied it');
  assert.ok(existsSync(`${statePath}${PENDING}`), 'the complete copy is pending');
  assert.equal(inbox(p).length, 1, 'kept: state.json does not name it');
  const r = stopIn(p);
  assert.equal(r.outcome, 'paused', 'recovered, not corrupt-state');
  assert.ok(journal(p).some((j) => j.type === 'state-recovered'));
  assert.equal(spent(p), 800, 'the pending copy counted the 300: not counted twice');
  assert.deepEqual(inbox(p), []);
  assert.ok(!existsSync(`${statePath}${PENDING}`));
  stopIn(p);
  assert.equal(spent(p), 800);
});

// ---------------------------------------------------------------- updateState and rev
test('updateState: rev + 1 at every save; another writer between the read and the write -> retried on its state', () => {
  const p = project();
  arm(p, 'rev');
  const paths = gatePaths(p.dir);
  assert.equal(readState(p).rev, 0);
  assert.equal(cli(p, 'report', 'pass').code, 0);
  assert.equal(readState(p).rev, 1);
  // the check right before the write finds another writer's state (once)
  let reads = 0;
  const fs = { readFileSync: (path, enc) => {
    if (path === paths.statePath && ++reads === 2) patchState(p, (s) => { s.complexity = 'high'; s.rev = 7; });
    return readFileSync(path, enc);
  } };
  const r = updateState(paths, (s) => { s.signals.claimedDone = true; }, { fs });
  assert.equal(r.ok, true);
  const s = readState(p);
  assert.deepEqual([s.complexity, s.signals.claimedDone, s.signals.lastReport, s.rev], ['high', true, 'pass', 8]);
  // a writer that replaces our save right after it, without our change: retried, lands
  let replaced = 0;
  const fs2 = { renameSync: (a, b) => {
    const prev = readFileSync(paths.statePath, 'utf8');
    realRename(a, b);
    if (b === paths.statePath && !replaced++) writeFileSync(paths.statePath, prev);
  } };
  assert.equal(updateState(paths, (st) => { st.complexity = 'low'; }, { fs: fs2 }).ok, true);
  assert.equal(readState(p).complexity, 'low');
  assert.equal(replaced, 2);
  // a state that changes under every attempt: an error, never a blind write
  const always = { readFileSync: (path, enc) => { const t = readFileSync(path, enc); if (path === paths.statePath) patchState(p, (x) => { x.counters.iterations += 1; }); return t; } };
  const bad = updateState(paths, (st) => { st.complexity = 'medium'; }, { fs: always });
  assert.equal(bad.ok, false);
  assert.notEqual(readState(p).complexity, 'medium');
  // a full disk: the verb fails loudly and state.json is intact
  const before = readFileSync(paths.statePath, 'utf8');
  const full = updateState(paths, (st) => { st.complexity = 'medium'; }, { fs: { writeFileSync: () => { throw enospc(); } } });
  assert.equal(full.ok, false);
  assert.equal(readFileSync(paths.statePath, 'utf8'), before);
});

test('the test verb: a 4 s suite with a Stop counting 1000 tokens meanwhile -> the 1000 survive the verb', async () => {
  const p = project();
  arm(p, 'slow test');
  stopIn(p);
  writeFileSync(join(p.dir, 'slow.js'), 'setTimeout(() => {}, 4000);\n');
  const child = spawn(NODE, [CLI, 'test', '--', 'node', 'slow.js'], { cwd: p.dir, env: p.env });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const exited = new Promise((res) => child.on('close', res));
  // the verb has read the state once it runs the suite
  const until = Date.now() + 15000;
  while (!out.includes('Running:') && Date.now() < until) await new Promise((res) => setTimeout(res, 50));
  assert.ok(out.includes('Running:'), out);
  delta(p, 1000);
  stopIn(p);
  assert.equal(spent(p), 1000);
  assert.equal(await exited, 0, out);
  const s = readState(p);
  assert.equal(s.usage.inputTokens, 1000, 'the verb wrote on the fresh state');
  assert.equal(s.lastTest.exitCode, 0);
  assert.equal(s.options.testCmd, 'node slow.js');
  stopIn(p);
  assert.equal(spent(p), 1000);
});

// ---------------------------------------------------------------- the Stop merges the verbs
test('verbs during a slow Stop: report and claim-done written while it runs are kept, the tokens too', () => {
  // a running loop (no plan yet): the Stop does not pause, the verbs record
  const p = project();
  arm(p, 'state files');
  stopIn(p);
  delta(p, 400);
  const statePath = gate(p, 'state.json');
  let reads = 0;
  // the Stop's second read of state.json is the one right before its save: the verbs land first
  const fs = { readFileSync: (path, enc) => {
    if (path === statePath && ++reads === 2) {
      assert.equal(cli(p, 'report', 'fail').code, 0);
      assert.equal(cli(p, 'claim-done').code, 0);
    }
    return readFileSync(path, enc);
  } };
  stopIn(p, { fs });
  assert.ok(reads >= 2, String(reads)); // the second is the merge's; then the check before the rename
  const s = readState(p);
  assert.equal(s.signals.paused, false);
  assert.equal(s.signals.lastReport, 'fail');
  assert.equal(s.signals.claimedDone, true);
  assert.equal(s.usage.inputTokens, 400, 'and the Stop\'s count');
  assert.equal(s.rev, 4, 'past the verbs\' revs (arm 0, first stop 1, report 2, claim-done 3)');
  const m = journal(p).find((j) => j.type === 'state-merged');
  assert.ok(m && m.fields.includes('signals.lastReport') && m.fields.includes('signals.claimedDone'), JSON.stringify(m));
  assert.ok(!journal(p).some((j) => j.type === 'outcome-dropped-paused'));
  assert.equal(inbox(p).length, 1, 'counted and named; the next stop removes it');
});

test('a Stop whose result is paused does not carry the outcomes written while it ran; the other verb fields and the tokens it does', () => {
  const p = pausedLoop();
  delta(p, 400);
  const statePath = gate(p, 'state.json');
  const paths = { gateDir: gate(p, ''), statePath };
  let reads = 0;
  // written as the verbs write them (updateState): on a paused loop report and claim-done refuse
  // through the CLI, and the Stop must not take them from disk either (an escalating Stop: the
  // verb found the loop not yet paused)
  const fs = { readFileSync: (path, enc) => {
    if (path === statePath && ++reads === 2) {
      assert.equal(updateState(paths, (st) => { st.signals.lastReport = 'pass'; }).ok, true);
      assert.equal(updateState(paths, (st) => { st.signals.claimedDone = true; }).ok, true);
      assert.equal(updateState(paths, (st) => { st.complexity = 'high'; }).ok, true);
    }
    return readFileSync(path, enc);
  } };
  stopIn(p, { fs });
  const s = readState(p);
  assert.equal(s.signals.paused, true);
  assert.equal(s.signals.lastReport, 'none', 'the outcome is not in the paused state');
  assert.equal(s.signals.claimedDone, false);
  assert.equal(s.complexity, 'high', 'a verb field that is no outcome is merged as before');
  assert.equal(s.usage.inputTokens, 400);
  const d = journal(p).filter((j) => j.type === 'outcome-dropped-paused');
  assert.equal(d.length, 1, JSON.stringify(d));
  assert.deepEqual(d[0].fields, ['signals.lastReport', 'signals.claimedDone']);
  assert.deepEqual(d[0].values, { lastReport: 'pass', claimedDone: true });
  assert.equal(d[0].by, 'stop');
  const m = journal(p).find((j) => j.type === 'state-merged');
  assert.ok(m && m.fields.includes('complexity') && !m.fields.includes('signals.lastReport') && !m.fields.includes('signals.claimedDone'), JSON.stringify(m));
  // a verb right after the save rereads it: nothing of the Stop is lost
  delta(p, 100);
  stopIn(p, { afterSave: () => assert.equal(cli(p, 'complexity', 'low').code, 0) });
  const t = readState(p);
  assert.deepEqual([t.usage.inputTokens, t.complexity, t.signals.lastReport], [500, 'low', 'none']);
  stopIn(p);
  assert.equal(spent(p), 500);
});

test('a Stop with nothing changed on disk merges nothing; a field the Stop changed is not overwritten by an unchanged disk', () => {
  const p = pausedLoop();
  stopIn(p);
  assert.ok(!journal(p).some((j) => j.type === 'state-merged'));
  const rev = readState(p).rev;
  stopIn(p);
  assert.equal(readState(p).rev, rev + 1);
});

// ---------------------------------------------------------------- the proof that the files are counted
test('savedCounts: the state on disk names every file; an unreadable state or a missing name is no proof', () => {
  const { p } = scratch();
  const f = gate(p, 's.json');
  writeFileSync(f, JSON.stringify({ usageInboxSeen: ['a', 'b'] }));
  assert.equal(savedCounts(f, ['a']), true);
  assert.equal(savedCounts(f, ['a', 'b']), true);
  assert.equal(savedCounts(f, ['a', 'c']), false);
  assert.equal(savedCounts(f, []), true);
  writeFileSync(f, '{ torn');
  assert.equal(savedCounts(f, ['a']), false);
  assert.equal(savedCounts(gate(p, 'absent.json'), ['a']), false);
  writeFileSync(f, JSON.stringify({ usageInboxSeen: 'a' }));
  assert.equal(savedCounts(f, ['a']), false);
});

test('another writer between the save and the check: an overlapping Stop\'s state (same totals, other names) keeps our file', () => {
  const p = pausedLoop();
  const start = readState(p);
  delta(p, 300);
  // the overlapping stop started from the same state and counted a file of its own, also 300
  const theirs = { ...start, usage: { ...start.usage, source: 'mod', inputTokens: 300, byAgent: { main: { inputTokens: 300, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } } }, usageInboxSeen: ['0-their-file.json'], rev: 5 };
  stopIn(p, { afterSave: () => writeFileSync(gate(p, 'state.json'), JSON.stringify(theirs, null, 2)) });
  assert.equal(inbox(p).length, 1, 'equal totals are no proof: our file stays');
  assert.equal(spent(p), 300);
  stopIn(p);
  assert.equal(spent(p), 600, 'theirs + ours');
  stopIn(p);
  assert.equal(spent(p), 600);
  assert.deepEqual(inbox(p), []);
});

test('the check is on the disk, not on our save: a failed save whose files another Stop counted -> the next stop removes them, counted once', () => {
  const p = pausedLoop();
  delta(p, 300);
  const name = inbox(p)[0];
  const counted = { ...readState(p) };
  counted.usage = { ...counted.usage, source: 'mod', inputTokens: 300, byAgent: { main: { inputTokens: 300, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } } };
  counted.usageInboxSeen = [name];
  counted.rev = 9;
  stopIn(p, { writeState: () => ({ ok: false, error: 'EBUSY' }), afterSave: () => writeFileSync(gate(p, 'state.json'), JSON.stringify(counted, null, 2)) });
  assert.equal(inbox(p).length, 1, 'never removed by the stop that counted it');
  stopIn(p);
  assert.deepEqual(inbox(p), [], 'named in the state the next stop loaded: removed, not counted');
  stopIn(p);
  assert.equal(spent(p), 300);
});

test('the check ignores the totals: a later writer that added more keeps our names -> removed by the next stop, never counted twice', () => {
  const p = pausedLoop();
  delta(p, 300);
  stopIn(p, { afterSave: () => patchState(p, (s) => { s.usage.inputTokens += 50; s.usage.byAgent.main.inputTokens += 50; s.rev += 1; }) });
  assert.ok(!journal(p).some((j) => j.type === 'note' && /kept/.test(j.text)), 'named on disk: no "kept" note');
  stopIn(p);
  stopIn(p);
  assert.equal(spent(p), 350);
});

test('saveStateVerified: a read back that is a later state (higher rev) is a landed save; an older one is not', () => {
  const { p } = scratch();
  const f = gate(p, 'st.json');
  const state = { rev: 3, x: 1 };
  const later = (path) => { writeFileSync(path, JSON.stringify({ rev: 4, x: 2 })); return { ok: true }; };
  const r = saveStateVerified(f, state, later);
  assert.deepEqual([r.ok, r.superseded], [true, true]);
  const older = (path) => { writeFileSync(path, JSON.stringify({ rev: 2, x: 2 })); return { ok: true }; };
  assert.equal(saveStateVerified(f, state, older).ok, false);
  const torn = (path) => { writeFileSync(path, '{ torn'); return { ok: true }; };
  assert.equal(saveStateVerified(f, state, torn).ok, false);
});

// ---------------------------------------------------------------- after an archive failure
test('archive failure: the run\'s state is the newest of state.unsaved.json and state.disarmed.json; status shows it, disarm archives it', () => {
  const p = project();
  arm(p, 'retained run');
  stopIn(p);
  patchState(p, (s) => { s.counters.iterations = 99; });
  writeFileSync(join(p.home, 'runs'), 'not a directory'); // the archive cannot be created
  const onlyAside = (path, text) => (basename(path) === 'state.json' ? { ok: false, error: 'EPERM' } : (writeFileSync(path, text), { ok: true, atomic: true, error: null }));
  assert.equal(stopIn(p, { writeState: onlyAside }).outcome, 'budget');
  assert.ok(!existsSync(gate(p, 'state.json')), 'state.json renamed aside by the failed archive');
  assert.ok(existsSync(gate(p, RETAINED_STATE)) && existsSync(gate(p, UNSAVED_STATE)));
  const unsaved = JSON.parse(readFileSync(gate(p, UNSAVED_STATE), 'utf8'));
  const disarmed = JSON.parse(readFileSync(gate(p, RETAINED_STATE), 'utf8'));
  assert.ok(unsaved.rev > disarmed.rev, `${unsaved.rev} > ${disarmed.rev}`);
  assert.equal(readRetainedState(gate(p, '')).file, UNSAVED_STATE);
  const st = cli(p, 'status');
  assert.equal(st.code, 1);
  assert.match(st.out, /NOT armed/);
  assert.match(st.out, new RegExp(`Retained state \\(${UNSAVED_STATE.replace('.', '\\.')}\\)`));
  assert.match(st.out, /retained run/);
  assert.match(cli(p, 'arm', 'new', '--external', 'off').out, /retained/, 'arm still refuses');
  // the destination fixed: disarm archives the final state, not the older state.json
  rmSync(join(p.home, 'runs'));
  const d = cli(p, 'disarm');
  assert.equal(d.code, 0, d.out);
  const runs = readdirSync(join(p.home, 'runs'), { recursive: true }).map(String);
  const summaryFile = runs.find((f) => basename(f) === 'summary.json' && f.split(/[\\/]/).length === 3);
  const summary = JSON.parse(readFileSync(join(p.home, 'runs', summaryFile), 'utf8'));
  assert.equal(summary.iterations, unsaved.counters.iterations);
  assert.equal(summary.phaseAtEnd, unsaved.phase);
});

test('arm --force leaves nothing of the old run behind; a side file of an earlier failed save never reaches an archive it does not belong to', () => {
  const p = project();
  arm(p, 'old run');
  for (const n of [UNSAVED_STATE, `state.json${PENDING}`, 'state.json.1234.abcdef.tmp']) writeFileSync(gate(p, n), '{}');
  delta(p, 10);
  arm(p, 'new run', ['--force']);
  const left = gateFiles(p);
  for (const n of [UNSAVED_STATE, `state.json${PENDING}`, 'state.json.1234.abcdef.tmp', 'usage-inbox']) assert.ok(!left.includes(n), `${n} in ${left}`);
  assert.equal(readState(p).task, 'new run');
  // a stale side file of this run, then a final save that lands: removed before the archive
  stopIn(p);
  writeFileSync(gate(p, UNSAVED_STATE), readFileSync(gate(p, 'state.json'), 'utf8'));
  patchState(p, (s) => { s.counters.iterations = 99; });
  assert.equal(stopIn(p).outcome, 'budget');
  assert.ok(!existsSync(gate(p, '')));
  const runs = readdirSync(join(p.home, 'runs'), { recursive: true }).map(String);
  assert.ok(runs.some((f) => basename(f) === 'state.json'), runs.join(','));
  assert.ok(!runs.some((f) => basename(f) === UNSAVED_STATE), runs.join(','));
});

test('disarm --no-archive and disarm leave no residue for the next arm', () => {
  const p = project();
  arm(p, 'one');
  writeFileSync(gate(p, `state.json${PENDING}`), readFileSync(gate(p, 'state.json'), 'utf8'));
  assert.equal(cli(p, 'disarm', '--no-archive').code, 0);
  assert.ok(!existsSync(gate(p, '')));
  assert.equal(stopIn(p).outcome, 'dormant');
  const r = spawnSync(NODE, [CLI, 'status'], { cwd: p.dir, env: p.env, encoding: 'utf8' });
  assert.equal(r.status, 1);
});

test('a verb on an emptied state.json with a pending copy recovers it and writes on it', () => {
  const p = project();
  arm(p, 'verb recovers');
  const statePath = gate(p, 'state.json');
  writeFileSync(`${statePath}${PENDING}`, readFileSync(statePath, 'utf8'));
  writeFileSync(statePath, '');
  // status reads the copy without promoting it
  assert.equal(cli(p, 'status').code, 0);
  assert.equal(readFileSync(statePath, 'utf8'), '');
  // the test verb reads the state before the suite (requireState), then writes on it
  writeFileSync(join(p.dir, 'ok.js'), 'process.exit(0);\n');
  const r = cli(p, 'test', '--', 'node', 'ok.js');
  assert.equal(r.code, 0, r.out);
  const s = readState(p);
  assert.deepEqual([s.task, s.lastTest.exitCode], ['verb recovers', 0]);
  assert.ok(!existsSync(`${statePath}${PENDING}`));
  assert.ok(journal(p).some((j) => j.type === 'state-recovered'));
});
