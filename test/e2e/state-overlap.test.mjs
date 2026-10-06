// Round 7: stops that overlap, a disarm during a stop, a read refused for a moment, the mark
// that only arm may lift, and the rules each surviving mutation of the verifier exposed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, rmSync, mkdirSync, utimesSync, statSync, renameSync as realRename } from 'node:fs';
import { basename } from 'node:path';
import { project, cli, arm, readState, patchState, gate, journal, readFileSync, writeFileSync, existsSync, join } from '../helpers/cli.mjs';
import { gatePaths } from '../../src/shell/paths.mjs';
import { runStopFromFacts } from '../../src/shell/stop-core.mjs';
import { writeUsageDelta, foreignReason } from '../../src/shell/usage-inbox.mjs';
import { writeDurable, updateState, loadStateFile, readRetainedState, PENDING, UNSAVED_STATE, RENAME_WAIT_MS, realFs } from '../../src/shell/state-file.mjs';
import { handle } from '../../src/shell/mod-bridge.mjs';
import { saveStateVerified } from '../../src/shell/effects.mjs';
import { DISARMED_MARK, RETAINED_STATE, makeDormant, archiveRun } from '../../src/shell/archive.mjs';
import { run as disarmRun } from '../../src/cli/verbs/disarm.mjs';
import { markInterrupted } from '../../src/shell/watchdog.mjs';
import { writeNewState } from '../../src/cli/shared.mjs';
import { defaultState } from '../../src/core/state.mjs';

const eperm = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
const ebusy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
const stopIn = (p, io = {}, facts = {}) => runStopFromFacts({ evt: { cwd: p.dir, session_id: 't-sess' }, env: p.env, io, facts });
const inbox = (p) => { try { return readdirSync(gate(p, 'usage-inbox')).sort(); } catch { return []; } };
const delta = (p, n) => writeUsageDelta(gate(p, ''), { session: 't-sess', arm: readState(p).armedAt, byAgent: { main: { inputTokens: n, outputTokens: 0 } } });
const spent = (p) => readState(p).usage.inputTokens;
const gateFiles = (p) => readdirSync(gate(p, ''));
function pausedLoop(extra = []) {
  const p = project();
  arm(p, 'overlap', extra);
  stopIn(p);
  patchState(p, (s) => { s.signals.paused = true; });
  return p;
}
// the n-th read of state.json by this stop runs fn first (1: the load, 2: the check before
// anything is written, 3: the merge before the save)
const atRead = (p, n, fn) => {
  let k = 0;
  return { readFileSync: (path, enc) => { if (path === gate(p, 'state.json') && ++k === n) fn(); return readFileSync(path, enc); } };
};
// a sync client or an antivirus holding files: `names` cannot be removed, and a folder that
// holds one of them cannot either (what can go goes, as Windows does)
const holding = (...names) => (path, opts = {}) => {
  if (names.includes(basename(String(path)))) throw ebusy();
  if (opts.recursive && existsSync(path) && statSync(path).isDirectory()) {
    for (const n of readdirSync(path)) { if (!names.includes(n)) rmSync(join(path, n), { recursive: true, force: true }); }
    if (readdirSync(path).length) throw ebusy();
  }
  return rmSync(path, opts);
};
// the gate cannot be moved (archived by copy, then removed)
const refuse = () => { throw eperm(); };
// a verb's run() in process, its console output collected
const quiet = (fn, lines = []) => {
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { return fn(); } finally { console.log = log; }
};

// ---------------------------------------------------------------- CRITICAL 1: overlapping stops
test('overlap: another stop saves before this one writes anything -> it starts over from that state; nothing lost, nothing twice', () => {
  const p = pausedLoop();
  delta(p, 100);
  stopIn(p, { fs: atRead(p, 2, () => { delta(p, 200); stopIn(p); }) });
  assert.ok(journal(p).some((j) => j.type === 'stop-restarted'));
  assert.equal(spent(p), 300);
  stopIn(p);
  stopIn(p);
  assert.equal(spent(p), 300);
  assert.deepEqual(inbox(p), []);
});

test('overlap: another stop saves between this one\'s check and its save -> its state stands, this save is abandoned, its counts wait in the inbox', () => {
  const p = pausedLoop();
  delta(p, 100);
  // this stop also brings a delta of its own (facts.usage): it must survive the abandoned save
  // (read 1: the pre-load for the stop's own delta; 2: the load; 3: the check; 4: the merge)
  stopIn(p, { fs: atRead(p, 4, () => { delta(p, 200); stopIn(p); }) }, { usage: { byAgent: { main: { inputTokens: 40, outputTokens: 0 } } } });
  assert.ok(journal(p).some((j) => j.type === 'state-save-skipped' && /another stop saved/.test(j.why)), JSON.stringify(journal(p).slice(-5)));
  assert.equal(spent(p), 340, 'the other stop\'s state stands: it counted the 100, the 200 and this stop\'s own 40, already a file of the inbox');
  stopIn(p);
  assert.equal(spent(p), 340);
  stopIn(p);
  stopIn(p);
  assert.equal(spent(p), 340);
  assert.deepEqual(inbox(p), []);
});

test('overlap: a save overwritten in the instant between a check and a rename loses no token (the counted files are not removed by the stop that counts them)', () => {
  const p = pausedLoop();
  delta(p, 100);
  // this stop has counted the 100; at its rename another stop (that saw a later file) has
  // already saved and the rename lands over it, as in the instant no check can close
  let n = 0;
  const fs = { renameSync: (a, b) => {
    if (b === gate(p, 'state.json') && n++ === 0) { delta(p, 200); stopIn(p); assert.equal(spent(p), 300); }
    return realRename(a, b);
  } };
  stopIn(p, { fs });
  assert.equal(spent(p), 100, 'the other stop\'s save was overwritten: its 200 are not in the state');
  assert.equal(inbox(p).length, 2, 'but its file was not removed');
  stopIn(p);
  assert.equal(spent(p), 300, 'counted once, late');
  stopIn(p);
  stopIn(p);
  assert.equal(spent(p), 300);
  assert.deepEqual(inbox(p), []);
});

// The window no check closes (state-file.mjs, stop-core.mjs savedCounts), pinned so its
// direction stays documented: with THREE writers it loses tokens, it never counts one twice.
// A stop passes its last check; before its rename, stop B counts a file and saves, and stop C
// loads B's state (which names the file) and removes it; then A's rename lands over C's save.
test('overlap, the documented residual window: three stops, the oldest one\'s rename last -> the files the others counted and removed are lost (an undercount, never a double count)', () => {
  const p = pausedLoop();
  delta(p, 100);
  let n = 0;
  const fs = { renameSync: (a, b) => {
    if (b === gate(p, 'state.json') && n++ === 0) {
      delta(p, 200);
      stopIn(p); // B: counts the 100 and the 200, names both files
      stopIn(p); // C: loads B's state, removes both files
      assert.equal(spent(p), 300);
      assert.deepEqual(inbox(p), []);
    }
    return realRename(a, b);
  } };
  stopIn(p, { fs }); // A: counted the 100 only, its rename lands over C's save
  assert.equal(spent(p), 100);
  stopIn(p);
  stopIn(p);
  assert.equal(spent(p), 100, 'the 200 is lost: its file was removed on the strength of a state that was then overwritten');
  assert.deepEqual(inbox(p), []);
});

test('overlap: git-finish saves twice in one stop; the second save builds on the first, it is no conflict', () => {
  // budget end: saveState then archive; and a stop that only saves twice through finishProject
  // is covered by the git tests; here: two saves of the same stop never abandon each other
  const p = pausedLoop(['--max', '100']);
  stopIn(p);
  assert.ok(!journal(p).some((j) => j.type === 'state-save-skipped'));
});

// ---------------------------------------------------------------- CRITICAL 2: disarm during a stop
test('disarm during a stop: state.json gone and the gate marked at the merge -> the save is abandoned, no state.json is ever written again', () => {
  const p = pausedLoop();
  delta(p, 100);
  const r = stopIn(p, { fs: atRead(p, 3, () => {
    rmSync(gate(p, 'state.json'));
    writeFileSync(gate(p, DISARMED_MARK), '{}');
  }) });
  assert.ok(!existsSync(gate(p, 'state.json')), 'not recreated');
  assert.ok(journal(p).some((j) => j.type === 'state-save-skipped' && /disarmed/.test(j.why)));
  assert.ok(r);
  assert.equal(stopIn(p).outcome, 'dormant');
  assert.match(cli(p, 'status').out, /NOT armed/);
});

test('at the merge the disarm mark alone is enough: the save is abandoned with that reason, state.json left as it was', () => {
  const p = pausedLoop();
  delta(p, 100);
  let before = null;
  stopIn(p, { fs: atRead(p, 3, () => { before = readFileSync(gate(p, 'state.json'), 'utf8'); writeFileSync(gate(p, DISARMED_MARK), '{}'); }) });
  assert.equal(readFileSync(gate(p, 'state.json'), 'utf8'), before, 'nothing written over it');
  assert.ok(journal(p).some((j) => j.type === 'state-save-skipped' && /gate marked/.test(j.why)));
});

test('at the merge state.json is gone (no mark): the save is abandoned as a disarm, not as a busy file, and nothing is recreated', () => {
  const p = pausedLoop();
  delta(p, 100);
  stopIn(p, { fs: atRead(p, 3, () => rmSync(gate(p, 'state.json'))) });
  assert.ok(!existsSync(gate(p, 'state.json')));
  const skipped = journal(p).filter((j) => j.type === 'state-save-skipped').pop();
  assert.ok(skipped && /state\.json gone while this stop ran/.test(skipped.why), JSON.stringify(skipped));
});

test('disarm during a stop: gone before anything is written -> the stop lets go (dormant), writes nothing', () => {
  const p = pausedLoop();
  const r = stopIn(p, { fs: atRead(p, 2, () => { rmSync(gate(p, 'state.json')); writeFileSync(gate(p, DISARMED_MARK), '{}'); }) });
  assert.equal(r.outcome, 'dormant');
  assert.equal(r.output, null);
  assert.ok(!existsSync(gate(p, 'state.json')));
  assert.ok(journal(p).some((j) => j.type === 'note' && /disarmed while this stop ran \(gate marked\)/.test(j.text)), 'the reason is journaled');
});

test('disarm during a stop, the gate kept by a file held open: no state.json is written again, the loop stays NOT armed', () => {
  const p = project();
  arm(p, 'race disarm');
  stopIn(p);
  const pp = gate(p, `state.json${PENDING}`);
  writeFileSync(pp, readFileSync(gate(p, 'state.json'), 'utf8'));
  let code = null;
  // at the merge before its save, `disarm` runs: the gate cannot move (a sync client holds it)
  // and the pending copy cannot go
  stopIn(p, { fs: atRead(p, 3, () => { code = quiet(() => disarmRun({ argv: [], cwd: p.dir, env: p.env, io: { rename: refuse, rm: holding(`state.json${PENDING}`) } })); }) });
  assert.equal(code, 0);
  assert.ok(existsSync(pp) && existsSync(gate(p, DISARMED_MARK)), 'the gate is left, marked');
  assert.ok(!existsSync(gate(p, 'state.json')), 'not recreated by the stop that was running');
  assert.ok(journal(p).some((j) => j.type === 'state-save-skipped' && /disarmed/.test(j.why)));
  assert.equal(stopIn(p).outcome, 'dormant');
  assert.match(cli(p, 'status').out, /NOT armed/);
});

// ---------------------------------------------------------------- warnings
test('a read of state.json refused for a moment is retried, never a reason to promote an older pending copy', () => {
  const p = project();
  arm(p, 'busy');
  stopIn(p);
  const old = readFileSync(gate(p, 'state.json'), 'utf8');
  assert.equal(cli(p, 'complexity', 'high').code, 0);
  writeFileSync(gate(p, `state.json${PENDING}`), old); // an older copy whose drop was refused
  let n = 0;
  const once = { readFileSync: (path, enc) => { if (path === gate(p, 'state.json') && ++n === 1) throw ebusy(); return readFileSync(path, enc); } };
  const r1 = stopIn(p, { fs: once });
  assert.notEqual(r1.outcome, 'state-busy', 'one refusal is retried: the stop goes on');
  assert.equal(readState(p).complexity, 'high', 'the verb\'s write stands');
  assert.ok(!journal(p).some((j) => j.type === 'state-recovered'));
  // refused at every try: the stop lets go, nothing promoted, nothing archived
  const always = { readFileSync: (path, enc) => { if (path === gate(p, 'state.json')) throw ebusy(); return readFileSync(path, enc); } };
  const r = stopIn(p, { fs: always });
  assert.equal(r.outcome, 'state-busy');
  assert.equal(readState(p).complexity, 'high');
  assert.ok(existsSync(gate(p, 'state.json')));
  assert.equal(loadStateFile(gatePaths(p.dir), { fs: always }).transient, true);
});

test('a state.json that parses but is not a loop state is not replaced by a pending copy with a lower rev', () => {
  const p = project();
  arm(p, 'rev guard');
  const paths = gatePaths(p.dir);
  writeFileSync(`${paths.statePath}${PENDING}`, readFileSync(paths.statePath, 'utf8')); // rev 0
  writeFileSync(paths.statePath, JSON.stringify({ schemaVersion: 2, rev: 5 }));
  assert.equal(loadStateFile(paths).state, null);
  assert.equal(JSON.parse(readFileSync(paths.statePath, 'utf8')).rev, 5, 'not promoted over');
  // with a rev at least as high it is
  writeFileSync(paths.statePath, JSON.stringify({ schemaVersion: 2, rev: 0 }));
  assert.equal(loadStateFile(paths).recovered, true);
});

test('arm refuses while the disarm mark cannot be removed (a new run beside it would have no crash recovery)', () => {
  const p = project();
  mkdirSync(gate(p, ''), { recursive: true });
  mkdirSync(gate(p, DISARMED_MARK)); // a mark that cannot be unlinked
  writeFileSync(join(gate(p, DISARMED_MARK), 'x'), 'held');
  const r = cli(p, 'arm', 'blocked', '--external', 'off', '--no-git-finish');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /cannot be removed/);
  assert.ok(!existsSync(gate(p, 'state.json')));
  rmSync(gate(p, DISARMED_MARK), { recursive: true });
  arm(p, 'now');
  assert.equal(readState(p).task, 'now');
});

test('arm\'s state: rename refused and the write in place cut short -> a whole pending copy, recovered by the next stop', () => {
  const p = project();
  mkdirSync(gate(p, ''), { recursive: true });
  const paths = gatePaths(p.dir);
  writeFileSync(paths.statePath, '');
  const state = defaultState({ task: 'arm crash', armedAt: new Date().toISOString() });
  const fs = {
    renameSync: (a, b) => { if (b === paths.statePath) throw eperm(); return realRename(a, b); },
    writeFileSync: (path, text) => writeFileSync(path, path === paths.statePath ? String(text).slice(0, 40) : text),
  };
  assert.throws(() => writeNewState(paths, state, { fs }), /not written/);
  assert.ok(existsSync(`${paths.statePath}${PENDING}`), 'the whole copy is pending');
  assert.ok(!gateFiles(p).some((n) => /\.tmp$/.test(n)));
  assert.equal(loadStateFile(paths).state.task, 'arm crash');
});

test('disarm --no-archive with state.json held open says it failed (exit 1) and leaves no mark beside the live state', () => {
  const p = project();
  arm(p, 'locked state');
  stopIn(p);
  const lines = [];
  const code = quiet(() => disarmRun({ argv: ['--no-archive'], cwd: p.dir, env: p.env, io: { rm: holding('state.json') } }), lines);
  assert.equal(code, 1);
  assert.ok(lines.some((l) => /Could not disarm/.test(l)), lines.join('\n'));
  assert.ok(existsSync(gate(p, 'state.json')));
  assert.ok(!existsSync(gate(p, DISARMED_MARK)), 'no mark beside a live state.json');
  assert.match(cli(p, 'status').out, /ARMED/);
});

test('makeDormant: state.json itself kept by a lock -> not dormant, not marked', () => {
  const p = project();
  arm(p, 'live');
  const lockedState = (path, opts) => { if (String(path).endsWith('state.json')) throw eperm(); return rmSync(path, opts); };
  const r = makeDormant(gate(p, ''), { rm: lockedState });
  assert.deepEqual([r.dormant, r.marked], [false, false]);
  assert.ok(!existsSync(gate(p, DISARMED_MARK)));
});

// ---------------------------------------------------------------- the verifier's surviving mutations
test('X20: the watchdog\'s markInterrupted never promotes a pending copy; on a live state it writes the interruption', () => {
  const p = project();
  arm(p, 'watchdog');
  const paths = gatePaths(p.dir);
  writeFileSync(`${paths.statePath}${PENDING}`, readFileSync(paths.statePath, 'utf8'));
  writeFileSync(paths.statePath, '');
  assert.equal(markInterrupted(paths.gateDir, { at: 'x', silentMs: 1 }).ok, false);
  assert.equal(readFileSync(paths.statePath, 'utf8'), '');
  assert.ok(!journal(p).some((j) => j.type === 'state-recovered'));
  // a live state: written
  rmSync(`${paths.statePath}${PENDING}`);
  arm(p, 'watchdog 2', ['--force']);
  assert.equal(markInterrupted(paths.gateDir, { at: '2026-01-01T00:00:00.000Z', silentMs: 5, pending: ['pf-executor'] }).ok, true);
  assert.deepEqual(readState(p).signals.interrupted.pending, ['pf-executor']);
});

test('X18: the archive of a gate that cannot move or go (the kill switch, a budget end) leaves no copy that re-arms it', () => {
  const p = project();
  arm(p, 'kill locked');
  stopIn(p);
  const pp = gate(p, `state.json${PENDING}`);
  writeFileSync(pp, readFileSync(gate(p, 'state.json'), 'utf8'));
  writeFileSync(gate(p, 'state.json.4321.abcdef.tmp'), '{}');
  const paths = gatePaths(p.dir);
  // the copies that CAN go go; the one held open gets the mark
  const r = archiveRun(paths.gateDir, { projectName: paths.projectName, state: readState(p), outcome: 'killed', env: p.env, io: { rename: refuse, rm: holding(`state.json${PENDING}`) } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.leftover, paths.gateDir);
  assert.ok(!existsSync(gate(p, 'state.json')));
  assert.ok(!existsSync(gate(p, 'state.json.4321.abcdef.tmp')), 'a temporary goes');
  assert.ok(existsSync(pp) && existsSync(gate(p, DISARMED_MARK)));
  assert.equal(stopIn(p).outcome, 'dormant');
  assert.ok(!existsSync(gate(p, 'state.json')), 'never re-armed');
  assert.match(cli(p, 'status').out, /NOT armed/);
  // nothing held: the leftover gate keeps no copy at all, and needs no mark
  const q = project();
  arm(q, 'kill free');
  stopIn(q);
  writeFileSync(gate(q, `state.json${PENDING}`), readFileSync(gate(q, 'state.json'), 'utf8'));
  const qp = gatePaths(q.dir);
  const r2 = archiveRun(qp.gateDir, { projectName: qp.projectName, state: readState(q), outcome: 'killed', env: q.env, io: { rename: refuse, rm: holding('journal.jsonl') } });
  assert.equal(r2.ok, true, r2.error);
  assert.ok(!existsSync(gate(q, `state.json${PENDING}`)) && !existsSync(gate(q, DISARMED_MARK)), readdirSync(gate(q, '')).join(','));
  assert.equal(stopIn(q).outcome, 'dormant');
});

test('X10: a verb on a recovered state writes only over what it read: a writer during its retry is not overwritten', () => {
  const p = project();
  arm(p, 'recovered verb');
  const paths = gatePaths(p.dir);
  writeFileSync(`${paths.statePath}${PENDING}`, readFileSync(paths.statePath, 'utf8'));
  writeFileSync(paths.statePath, '');
  // rename #1 to state.json is the promotion; at #2 (the verb's) another writer lands, refused once
  let n = 0;
  const fs = { renameSync: (a, b) => {
    if (b === paths.statePath && ++n === 2) { patchState(p, (s) => { s.complexity = 'high'; s.rev = 7; }); throw eperm(); }
    return realRename(a, b);
  } };
  const r = updateState(paths, (s) => { s.signals.lastReport = 'pass'; }, { fs });
  assert.equal(r.ok, true, r.error);
  const s = readState(p);
  assert.deepEqual([s.complexity, s.signals.lastReport, s.rev], ['high', 'pass', 8]);
});

test('X13: a read back with the same rev but other content is not a landed save', () => {
  const p = project();
  mkdirSync(gate(p, ''), { recursive: true });
  const f = gate(p, 'st.json');
  const same = (path) => { writeFileSync(path, JSON.stringify({ rev: 3, x: 'theirs' })); return { ok: true }; };
  assert.equal(saveStateVerified(f, { rev: 3, x: 'ours' }, same).ok, false);
});

test('X23: the retained state is the one with the higher rev, even when it is the older file', () => {
  const p = project();
  arm(p, 'retained');
  const g = gate(p, '');
  const s = readState(p);
  writeFileSync(join(g, UNSAVED_STATE), JSON.stringify({ ...s, rev: 9, task: 'unsaved' }));
  writeFileSync(join(g, RETAINED_STATE), JSON.stringify({ ...s, rev: 4, task: 'disarmed' }));
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(join(g, UNSAVED_STATE), old, old);
  assert.equal(readRetainedState(g).state.task, 'unsaved');
});

test('X26: a pending copy written directly is read back: a short one is no recoverable copy, nothing written in place', () => {
  const p = project();
  mkdirSync(gate(p, ''), { recursive: true });
  const target = gate(p, 'f.json');
  writeFileSync(target, 'OLD');
  const fs = {
    renameSync: () => { throw eperm(); },
    writeFileSync: (path, text) => writeFileSync(path, path === `${target}${PENDING}` ? String(text).slice(0, 2) : text),
  };
  const r = writeDurable(target, 'NEW TEXT', { fs, keepPending: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /no recoverable copy/);
  assert.equal(readFileSync(target, 'utf8'), 'OLD');
});

test('X28: a verb whose change is already there writes nothing (no rev, no write)', () => {
  const p = project();
  arm(p, 'unchanged');
  const paths = gatePaths(p.dir);
  const before = readFileSync(paths.statePath, 'utf8');
  const r = updateState(paths, () => false);
  assert.deepEqual([r.ok, r.unchanged], [true, true]);
  assert.equal(readFileSync(paths.statePath, 'utf8'), before);
});

test('X5: the rename is retried after a pause: a hold of a few ms ends in an atomic save, not a write in place', () => {
  const p = project();
  mkdirSync(gate(p, ''), { recursive: true });
  const target = gate(p, 'f.json');
  writeFileSync(target, 'OLD');
  const until = Date.now() + Math.floor(RENAME_WAIT_MS / 2);
  const fs = { renameSync: (a, b) => { if (b === target && Date.now() < until) throw eperm(); return realRename(a, b); } };
  const r = writeDurable(target, 'NEW', { fs, keepPending: true });
  assert.deepEqual([r.ok, r.atomic], [true, true]);
});

test('an abandoned save at the end of the run (budget): neither archived nor disarmed, the other stop\'s state stands', () => {
  const p = project();
  arm(p, 'abandoned end');
  stopIn(p);
  patchState(p, (s) => { s.counters.iterations = 99; });
  // at the merge another stop's save is on disk (more than a verb's fields changed)
  const r = stopIn(p, { fs: atRead(p, 3, () => patchState(p, (s) => { s.counters.iterations = 1; s.owner.lastFireAt += 1; s.rev += 1; })) });
  assert.equal(r.outcome, 'budget');
  assert.ok(journal(p).some((j) => j.type === 'state-save-skipped'));
  assert.ok(journal(p).some((j) => j.type === 'archive-skipped'));
  assert.ok(existsSync(gate(p, 'state.json')), 'still armed: the next stop decides on the state that stands');
  assert.equal(readState(p).counters.iterations, 1);
  assert.ok(!existsSync(gate(p, UNSAVED_STATE)));
});

// ---------------------------------------------------------------- round 8
test('the stop\'s own delta survives a state.json that stays busy: 3 stops of 100, the second refused at every read -> 300', () => {
  const p = project();
  arm(p, 'busy delta', ['--max', '100']);
  stopIn(p);
  const hundred = { usage: { byAgent: { main: { inputTokens: 100, outputTokens: 0 } } } };
  stopIn(p, {}, hundred);
  const always = { readFileSync: (path, enc) => { if (path === gate(p, 'state.json')) throw ebusy(); return readFileSync(path, enc); } };
  const r = stopIn(p, { fs: always }, hundred);
  assert.equal(r.outcome, 'state-busy');
  assert.ok(journal(p).some((j) => j.type === 'note' && /could not be read/.test(j.text)));
  stopIn(p, {}, hundred);
  stopIn(p);
  assert.equal(spent(p), 300);
  stopIn(p);
  assert.equal(spent(p), 300);
});

test('a delta queued while the state could not be read (armUnknown) counts for the run armed before it, never for an older one', () => {
  const s = { armedAt: '2026-01-01T00:00:10.000Z', owner: { sessionId: 't-sess' } };
  const at = (iso) => Date.parse(iso);
  assert.equal(foreignReason({ armUnknown: true, arm: null, at: at('2026-01-01T00:00:11.000Z'), session: 't-sess' }, s), null);
  assert.equal(foreignReason({ armUnknown: true, arm: null, at: at('2026-01-01T00:00:09.000Z'), session: 't-sess' }, s), 'another arm');
  assert.equal(foreignReason({ arm: null, at: at('2026-01-01T00:00:11.000Z'), session: 't-sess' }, s), 'another arm', 'no arm and no armUnknown: not this run\'s');
  assert.equal(foreignReason({ armUnknown: true, arm: null, at: at('2026-01-01T00:00:11.000Z'), session: 'other' }, s), 'another session');
});

test('two overlapping stops: a file another stop removed while this one was between its listing and its state read is not counted again', () => {
  const p = project();
  arm(p, 'dbl', ['--max', '100']);
  stopIn(p);
  delta(p, 100);
  stopIn(p); // counts F, names it, leaves it on disk
  assert.equal(spent(p), 100);
  // stop A lists the inbox (F there); stop B runs whole before A reads the state: it loads the
  // state that names F, removes F, saves without the name
  let fired = false;
  const fs = { readFileSync: (path, enc) => {
    if (!fired && path === gate(p, 'state.json')) { fired = true; stopIn(p); assert.deepEqual(inbox(p), []); }
    return readFileSync(path, enc);
  } };
  stopIn(p, { fs });
  assert.ok(fired);
  assert.equal(spent(p), 100, 'F was gone when A read the state: not counted twice');
  stopIn(p);
  assert.equal(spent(p), 100);
});

test('a stop that restarts writes its own delta once (counted once, not once per restart)', () => {
  const p = project();
  arm(p, 'restart delta', ['--max', '100']);
  stopIn(p);
  let n = 0;
  // read 3 is the check before writing: another stop saves there, this one restarts
  const fs = { readFileSync: (path, enc) => { if (path === gate(p, 'state.json') && ++n === 3) stopIn(p); return readFileSync(path, enc); } };
  const before = readState(p).counters.iterations;
  stopIn(p, { fs }, { usage: { byAgent: { main: { inputTokens: 100, outputTokens: 0 } } } });
  assert.ok(journal(p).some((j) => j.type === 'stop-restarted'));
  // the restart itself: this stop started over from the other stop's state and saved on it
  // (not abandoned at the save), so both iterations are on disk
  assert.ok(!journal(p).some((j) => j.type === 'state-save-skipped'), 'the restarted stop saves');
  assert.equal(readState(p).counters.iterations, before + 2);
  stopIn(p);
  stopIn(p);
  assert.equal(spent(p), 100);
});

test('a torn state.json at the merge before the save is overwritten by this stop\'s state, not left torn', () => {
  const p = pausedLoop();
  delta(p, 40);
  stopIn(p, { fs: atRead(p, 3, () => writeFileSync(gate(p, 'state.json'), '{"torn":')) });
  assert.ok(!journal(p).some((j) => j.type === 'state-save-skipped'));
  assert.equal(spent(p), 40, 'saved, parseable, with the tokens');
});

test('a state.json busy at the merge before the save: the save is abandoned with that reason, and nothing it counted is lost', () => {
  const p = pausedLoop();
  delta(p, 70);
  let n = 0;
  // read 1: the load; 2: the check (passes); from 3 on (the merge and its retries): refused
  const fs = { readFileSync: (path, enc) => { if (path === gate(p, 'state.json') && ++n >= 3) throw ebusy(); return readFileSync(path, enc); } };
  stopIn(p, { fs });
  const skipped = journal(p).filter((j) => j.type === 'state-save-skipped').pop();
  assert.ok(skipped && /could not be read before the save: busy \(EBUSY\)/.test(skipped.why), JSON.stringify(skipped));
  assert.ok(!/disarmed/.test(skipped.why));
  assert.equal(spent(p), 0);
  stopIn(p);
  assert.equal(spent(p), 70);
});

test('a state.json busy for a moment at the merge is read again: the stop saves', () => {
  const p = pausedLoop();
  delta(p, 30);
  let n = 0;
  // read 1: the load; 2: the check; 3: the merge, refused once; 4: its retry
  const fs = { readFileSync: (path, enc) => { if (path === gate(p, 'state.json') && ++n === 3) throw ebusy(); return readFileSync(path, enc); } };
  stopIn(p, { fs });
  assert.ok(!journal(p).some((j) => j.type === 'state-save-skipped'));
  assert.equal(spent(p), 30);
});

test('a state.json busy at every read of the check is not a disarm: the stop goes on, and saves once the merge can read it', () => {
  const p = pausedLoop();
  delta(p, 30);
  let n = 0;
  // read 1: the load; 2-4: the check and its retries, all refused; 5: the merge
  const fs = { readFileSync: (path, enc) => { if (path === gate(p, 'state.json') && ++n >= 2 && n <= 4) throw ebusy(); return readFileSync(path, enc); } };
  const r = stopIn(p, { fs });
  assert.notEqual(r.outcome, 'dormant');
  assert.ok(journal(p).some((j) => j.type === 'note' && /could not be read before writing: busy \(EBUSY\)/.test(j.text)), 'the busy check is journaled');
  assert.ok(!journal(p).some((j) => j.type === 'state-save-skipped'));
  assert.equal(spent(p), 30);
});

test('a stop that can read the state writes its own delta with the arm, not as armUnknown', () => {
  const p = project();
  arm(p, 'own arm', ['--max', '100']);
  stopIn(p);
  stopIn(p, {}, { usage: { byAgent: { main: { inputTokens: 10, outputTokens: 0 } } } });
  const files = inbox(p);
  assert.equal(files.length, 1);
  const v = JSON.parse(readFileSync(gate(p, join('usage-inbox', files[0])), 'utf8'));
  assert.equal(v.arm, readState(p).armedAt);
  assert.equal(v.armUnknown, undefined);
});

// ---------------------------------------------------------------- round 11: written in place, unreadable files
// The verifier's sequence: the rename into the inbox refused (written in place), an overlapping
// stop counts the file, then the read back in place is refused. Never "dropped": the mod would
// resend and the delta would count twice.
for (const mode of ['usage-flush', 'stop']) {
  test(`${mode}: a delta written in place that an overlapping stop counted before its read back failed is unverified, never dropped: counted once`, () => {
    const p = project();
    arm(p, `in place ${mode}`, ['--max', '100000']);
    const call = (req) => handle({ cwd: p.dir, ...req, event: { session_id: 't-sess' } }, { env: p.env });
    call({ op: 'stop' });
    const isInbox = (x) => /usage-inbox[\\/][^\\/]+\.json$/.test(String(x));
    const ren = realFs.renameSync;
    const rd = realFs.readFileSync;
    let armed = true;
    let inner = null;
    realFs.renameSync = function (a, b) { if (armed && isInbox(b)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return ren.call(this, a, b); };
    realFs.readFileSync = function (x, ...rest) {
      // two stops in the window: one counts the file, the next removes it (its loaded state
      // names it), so the file is gone when the read back fails
      if (armed && isInbox(x)) { armed = false; inner = call({ op: 'stop' }); call({ op: 'stop' }); armed = true; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); }
      return rd.call(this, x, ...rest);
    };
    let r;
    try { r = call({ op: mode, facts: { usage: { byAgent: { main: { inputTokens: 500, outputTokens: 0 } } } } }); } finally { realFs.renameSync = ren; realFs.readFileSync = rd; }
    assert.ok(inner, 'the overlapping stop ran');
    assert.equal(spent(p), 500, 'the overlapping stop counted the file written in place');
    assert.deepEqual(inbox(p), [], 'and the next one removed it');
    if (mode === 'stop') { assert.equal(r.usageDropped, undefined, JSON.stringify(r)); assert.ok(r.usageUnverified); }
    else { assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.unverified, true); }
    call({ op: 'stop' });
    call({ op: 'stop' });
    assert.equal(spent(p), 500);
  });
}

test('the stop\'s first read (for its own delta) never promotes a pending copy: the load that follows does, and journals it', () => {
  const p = project();
  arm(p, 'pre-read', ['--max', '100']);
  stopIn(p);
  writeFileSync(gate(p, `state.json${PENDING}`), readFileSync(gate(p, 'state.json'), 'utf8'));
  writeFileSync(gate(p, 'state.json'), '{"phase":');
  stopIn(p, {}, { usage: { byAgent: { main: { inputTokens: 20, outputTokens: 0 } } } });
  assert.ok(journal(p).some((j) => j.type === 'state-recovered'), 'recovered by the load, journaled');
  stopIn(p);
  assert.equal(spent(p), 20);
});

test('an armUnknown inbox file without its time counts for no arm', () => {
  const p = project();
  arm(p, 'no time', ['--max', '100']);
  stopIn(p);
  mkdirSync(gate(p, 'usage-inbox'), { recursive: true });
  writeFileSync(gate(p, join('usage-inbox', '1-1-aaaaaaaa.json')), JSON.stringify({ session: 't-sess', arm: null, armUnknown: true, byAgent: { main: { inputTokens: 60, outputTokens: 0 } } }));
  stopIn(p);
  stopIn(p);
  assert.equal(spent(p), 0);
  assert.ok(journal(p).some((j) => j.type === 'note' && /another arm/.test(j.text)));
});

test('an inbox file that can never be read (a folder by that name) is journaled once, listed by status, and its marker goes with it', () => {
  const p = project();
  arm(p, 'unreadable', ['--max', '100']);
  stopIn(p);
  const bad = gate(p, join('usage-inbox', '2-2-bbbbbbbb.json'));
  mkdirSync(bad, { recursive: true });
  const old = (Date.now() - 60000) / 1000;
  utimesSync(bad, old, old);
  stopIn(p);
  stopIn(p);
  const notes = journal(p).filter((j) => j.type === 'note' && /2-2-bbbbbbbb\.json cannot be read/.test(j.text));
  assert.equal(notes.length, 1, 'once, not at every stop');
  assert.match(cli(p, 'status').out, /1 file\(s\) that cannot be read, not counted: 2-2-bbbbbbbb\.json/);
  rmSync(bad, { recursive: true });
  stopIn(p);
  assert.deepEqual(inbox(p), [], 'the marker is gone with its file');
  assert.doesNotMatch(cli(p, 'status').out, /cannot be read/);
});


// ---------------------------------------------------------------- round 12: notes said whoever meets the file first
const oldInboxEntry = (p, name, { folder = false, text = '{"torn":' } = {}) => {
  const f = gate(p, join('usage-inbox', name));
  mkdirSync(gate(p, 'usage-inbox'), { recursive: true });
  if (folder) mkdirSync(f); else writeFileSync(f, text);
  const old = (Date.now() - 60000) / 1000;
  utimesSync(f, old, old);
  return f;
};
const notesAbout = (p, name) => journal(p).filter((j) => j.type === 'note' && j.text.includes(name));
const busyState = (p) => ({ readFileSync: (path, enc) => { if (path === gate(p, 'state.json')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return readFileSync(path, enc); } });

for (const first of ['foreign', 'busy', 'none']) {
  test(`an unreadable or invalid inbox file met first by a ${first} stop is journaled exactly once`, () => {
    const p = project();
    arm(p, `notes ${first}`, ['--max', '100']);
    stopIn(p);
    oldInboxEntry(p, '3-3-cccccccc.json', { folder: true });
    oldInboxEntry(p, '4-4-dddddddd.json');
    if (first === 'foreign') runStopFromFacts({ evt: { cwd: p.dir, session_id: 'other-sess' }, env: p.env, io: {}, facts: {} });
    if (first === 'busy') assert.equal(stopIn(p, { fs: busyState(p) }).outcome, 'state-busy');
    stopIn(p);
    stopIn(p);
    assert.equal(notesAbout(p, '3-3-cccccccc.json').length, 1);
    assert.equal(notesAbout(p, '4-4-dddddddd.json').length, 1);
    assert.ok(existsSync(gate(p, join('usage-inbox', '4-4-dddddddd.json.invalid'))));
  });
}

test('a stop that cannot journal leaves no marker and sets nothing aside: the next stop that can says it, once', () => {
  const p = project();
  arm(p, 'no journal', ['--max', '100']);
  stopIn(p);
  oldInboxEntry(p, '5-5-eeeeeeee.json', { folder: true });
  oldInboxEntry(p, '6-6-ffffffff.json');
  const j = gate(p, 'journal.jsonl');
  const kept = readFileSync(j, 'utf8');
  rmSync(j);
  mkdirSync(j); // the journal cannot be appended to
  stopIn(p);
  assert.ok(!existsSync(gate(p, join('usage-inbox', '5-5-eeeeeeee.json.unreadable'))), 'no marker without its note');
  assert.ok(existsSync(gate(p, join('usage-inbox', '6-6-ffffffff.json'))), 'not set aside without its note');
  rmSync(j, { recursive: true });
  writeFileSync(j, kept);
  stopIn(p);
  stopIn(p);
  assert.equal(notesAbout(p, '5-5-eeeeeeee.json').length, 1);
  assert.equal(notesAbout(p, '6-6-ffffffff.json').length, 1);
});

test('status is read-only on the inbox: it writes no marker and sets nothing aside; the stop then writes its one note', () => {
  const p = project();
  arm(p, 'status read-only', ['--max', '100']);
  stopIn(p);
  oldInboxEntry(p, '7-7-abababab.json', { folder: true });
  oldInboxEntry(p, '8-8-cdcdcdcd.json');
  const before = inbox(p);
  assert.match(cli(p, 'status').out, /cannot be read/);
  assert.deepEqual(inbox(p), before, 'nothing written or moved by status');
  assert.equal(notesAbout(p, '7-7-abababab.json').length, 0);
  stopIn(p);
  stopIn(p);
  assert.equal(notesAbout(p, '7-7-abababab.json').length, 1);
  assert.equal(notesAbout(p, '8-8-cdcdcdcd.json').length, 1);
});

for (const mode of ['usage-flush', 'stop']) {
  test(`${mode}: a delta whose write in place fails before the file exists is unverified and journaled (lost, never resent)`, () => {
    const p = project();
    arm(p, `lost ${mode}`, ['--max', '100000']);
    const call = (req) => handle({ cwd: p.dir, ...req, event: { session_id: 't-sess' } }, { env: p.env });
    call({ op: 'stop' });
    const fin = (x) => /usage-inbox[\\/][^\\/]+\.json$/.test(String(x));
    const ren = realFs.renameSync;
    const wr = realFs.writeFileSync;
    realFs.renameSync = function (a, b) { if (fin(b)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return ren.call(this, a, b); };
    realFs.writeFileSync = function (x, ...r) { if (fin(x)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return wr.call(this, x, ...r); };
    let r;
    try { r = call({ op: mode, facts: { usage: { byAgent: { main: { inputTokens: 500, outputTokens: 0 } } } } }); } finally { realFs.renameSync = ren; realFs.writeFileSync = wr; }
    if (mode === 'stop') assert.ok(r.usageUnverified && !r.usageDropped, JSON.stringify(r));
    else assert.equal(r.unverified, true, JSON.stringify(r));
    assert.ok(journal(p).some((j) => j.type === 'note' && /written in place and not confirmed \(rename: EPERM; in place: EPERM\)/.test(j.text)));
    assert.ok(!journal(p).some((j) => j.type === 'note' && /could not be removed/.test(j.text)));
  });
}
