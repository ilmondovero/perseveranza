// The state against a process killed mid-write, writers that land during a retry of the
// rename, and a disarmed gate that a lock keeps on disk (state-file.mjs, archive.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, rmSync, mkdirSync, renameSync as realRename } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { project, cli, arm, readState, patchState, gate, journal, readFileSync, writeFileSync, existsSync, join, NODE, spawnSync } from '../helpers/cli.mjs';
import { ROOT, gatePaths } from '../../src/shell/paths.mjs';
import { runStopFromFacts } from '../../src/shell/stop-core.mjs';
import { writeUsageDelta } from '../../src/shell/usage-inbox.mjs';
import { writeDurable, updateState, PENDING } from '../../src/shell/state-file.mjs';
import { DISARMED_MARK, makeDormant } from '../../src/shell/archive.mjs';

const enospc = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
const eperm = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
const stopIn = (p, io = {}) => runStopFromFacts({ evt: { cwd: p.dir, session_id: 't-sess' }, env: p.env, io });
const inbox = (p) => { try { return readdirSync(gate(p, 'usage-inbox')).sort(); } catch { return []; } };
const delta = (p, n) => writeUsageDelta(gate(p, ''), { session: 't-sess', arm: readState(p).armedAt, byAgent: { main: { inputTokens: n, outputTokens: 0 } } });
const spent = (p) => readState(p).usage.inputTokens;
const gateFiles = (p) => readdirSync(gate(p, ''));
function pausedLoop() {
  const p = project();
  arm(p, 'crash');
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

// a Stop in a real process: every rename over state.json refused, the write in place cut after
// 40 bytes by SIGKILL. Before dying it records what the pending copy held at that instant.
const CRASH_CHILD = `
import { writeFileSync, existsSync, readFileSync, renameSync } from 'node:fs';
const [stopCore, dir, statePath, seenPath] = process.argv.slice(2);
const { runStopFromFacts } = await import(stopCore);
const eperm = () => Object.assign(new Error('EPERM'), { code: 'EPERM' });
const fs = {
  renameSync: (a, b) => { if (b === statePath) throw eperm(); return renameSync(a, b); },
  writeFileSync: (path, text) => {
    if (path === statePath) {
      const pp = statePath + '.pending';
      writeFileSync(seenPath, existsSync(pp) ? readFileSync(pp, 'utf8') : 'NONE');
      writeFileSync(path, String(text).slice(0, 40));
      process.kill(process.pid, 'SIGKILL');
    }
    return writeFileSync(path, text);
  },
};
runStopFromFacts({ evt: { cwd: dir, session_id: 't-sess' }, env: process.env, io: { fs } });
console.log('NOT KILLED');
`;

// ---------------------------------------------------------------- I1: a crash during the write in place
test('I1: kill -9 in the middle of the write in place -> the complete copy is already pending; the next Stop recovers it', () => {
  const p = pausedLoop();
  delta(p, 250);
  const statePath = gate(p, 'state.json');
  const child = join(p.dir, 'crash-child.mjs');
  const seen = join(p.dir, 'seen-pending.txt');
  writeFileSync(child, CRASH_CHILD);
  const c = spawnSync(NODE, [child, pathToFileURL(join(ROOT, 'src', 'shell', 'stop-core.mjs')).href, p.dir, statePath, seen], { env: p.env, encoding: 'utf8' });
  assert.ok(!c.stdout.includes('NOT KILLED'), c.stdout + c.stderr);
  assert.equal(readFileSync(statePath, 'utf8').length, 40, 'state.json torn by the crash');
  const pendingAtCrash = readFileSync(seen, 'utf8');
  assert.notEqual(pendingAtCrash, 'NONE', 'the pending copy existed BEFORE the write in place');
  assert.equal(JSON.parse(pendingAtCrash).usage.inputTokens, 250);
  assert.ok(!gateFiles(p).some((n) => /\.tmp$/.test(n)), `no copy left only as a temporary: ${gateFiles(p)}`);
  const r = stopIn(p);
  assert.equal(r.outcome, 'paused', 'recovered, not disarmed');
  assert.ok(journal(p).some((j) => j.type === 'state-recovered'));
  assert.equal(spent(p), 250);
  assert.deepEqual(inbox(p), []);
  stopIn(p);
  assert.equal(spent(p), 250);
});

test('I1: no recoverable copy, no write in place: when the pending copy cannot be written the target is left as it was', () => {
  const { p, target } = scratch();
  const fs = {
    renameSync: () => { throw eperm(); },
    writeFileSync: (path, text) => { if (path === `${target}${PENDING}`) throw enospc(); return writeFileSync(path, text); },
  };
  const r = writeDurable(target, 'NEW', { fs, keepPending: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /no recoverable copy/);
  assert.equal(readFileSync(target, 'utf8'), 'OLD');
  assert.deepEqual(gateFiles(p), ['f.json']);
  // the rename to the pending name refused too, the pending copy written directly: it is
  // there while the target is written, and gone once the target reads back
  let seenPending = null;
  const fs2 = {
    renameSync: () => { throw eperm(); },
    writeFileSync: (path, text) => { if (path === target) seenPending = readFileSync(`${target}${PENDING}`, 'utf8'); return writeFileSync(path, text); },
  };
  const r2 = writeDurable(target, 'NEW2', { fs: fs2, keepPending: true });
  assert.deepEqual([r2.ok, seenPending], [true, 'NEW2']);
  assert.deepEqual(gateFiles(p), ['f.json']);
});

// ---------------------------------------------------------------- I2: writers during a retry of the rename
test('I2: writeDurable with expect -> a target changed before an attempt (the first or a retry) is a conflict, never overwritten', () => {
  const { p, target } = scratch();
  writeFileSync(target, 'THEIRS');
  let r = writeDurable(target, 'MINE', { keepPending: true, expect: 'OLD' });
  assert.deepEqual([r.ok, r.conflict], [false, true]);
  assert.equal(readFileSync(target, 'utf8'), 'THEIRS');
  assert.deepEqual(gateFiles(p), ['f.json']);
  // changed during the pause after a refused rename
  writeFileSync(target, 'OLD');
  let n = 0;
  const fs = { renameSync: (a, b) => { if (b === target && n++ === 0) { writeFileSync(target, 'THEIRS-DURING-RETRY'); throw eperm(); } return realRename(a, b); } };
  r = writeDurable(target, 'MINE', { fs, keepPending: true, expect: 'OLD' });
  assert.deepEqual([r.ok, r.conflict], [false, true]);
  assert.equal(readFileSync(target, 'utf8'), 'THEIRS-DURING-RETRY');
  assert.deepEqual(gateFiles(p), ['f.json']);
  // changed while every rename is refused: no write in place over it either
  writeFileSync(target, 'OLD');
  n = 0;
  const fs3 = { renameSync: (a, b) => { if (b === target) { if (n++ === 2) writeFileSync(target, 'LAST-MOMENT'); throw eperm(); } return realRename(a, b); } };
  r = writeDurable(target, 'MINE', { fs: fs3, keepPending: true, expect: 'OLD' });
  assert.deepEqual([r.ok, r.conflict], [false, true]);
  assert.equal(readFileSync(target, 'utf8'), 'LAST-MOMENT');
  // unchanged during the retry: lands
  writeFileSync(target, 'OLD');
  n = 0;
  const fs2 = { renameSync: (a, b) => { if (b === target && n++ === 0) throw eperm(); return realRename(a, b); } };
  r = writeDurable(target, 'MINE', { fs: fs2, keepPending: true, expect: 'OLD' });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(target, 'utf8'), 'MINE');
  // expect null: the target must be absent
  rmSync(target);
  assert.equal(writeDurable(target, 'FIRST', { expect: null }).ok, true);
  assert.equal(writeDurable(target, 'SECOND', { expect: null }).conflict, true);
});

test('I2: a verb during the Stop\'s rename retry is merged, not overwritten (complexity high survives)', () => {
  const p = project();
  arm(p, 'window', ['--max', '1000']);
  stopIn(p);
  const statePath = gate(p, 'state.json');
  let n = 0;
  const fs = { renameSync: (a, b) => {
    if (b === statePath && n++ === 0) {
      assert.equal(cli(p, 'complexity', 'high').code, 0);
      throw eperm();
    }
    return realRename(a, b);
  } };
  stopIn(p, { fs });
  const s = readState(p);
  assert.equal(s.complexity, 'high');
  assert.equal(s.rev, 3, 'arm 0, first stop 1, the verb 2, this stop past it');
  assert.ok(journal(p).some((j) => j.type === 'state-merged' && j.fields.includes('complexity')));
});

test('I2: a Stop during a verb\'s rename retry: the verb starts over on its state, the 1000 tokens stay', () => {
  const p = project();
  arm(p, 'window2', ['--max', '1000']);
  stopIn(p);
  delta(p, 1000);
  const paths = gatePaths(p.dir);
  let n = 0;
  const fs = { renameSync: (a, b) => {
    if (b === paths.statePath && n++ === 0) {
      const h = spawnSync(NODE, [join(ROOT, 'src', 'shell', 'stop.mjs')], { cwd: p.dir, env: p.env, input: JSON.stringify({ cwd: p.dir, session_id: 't-sess' }), encoding: 'utf8' });
      assert.equal(h.status, 0, h.stderr);
      assert.equal(spent(p), 1000, 'the Stop counted the flush');
      assert.deepEqual(inbox(p), [], 'and removed it');
      throw eperm();
    }
    return realRename(a, b);
  } };
  const r = updateState(paths, (s) => { s.signals.lastReport = 'pass'; }, { fs });
  assert.equal(r.ok, true, r.error);
  const s = readState(p);
  assert.deepEqual([s.usage.inputTokens, s.signals.lastReport], [1000, 'pass']);
  stopIn(p);
  assert.equal(spent(p), 1000);
});

test('I2: a state that changes before every attempt of the Stop\'s save -> state-save-failed, the inbox kept, nothing overwritten', () => {
  const p = pausedLoop();
  delta(p, 70);
  const statePath = gate(p, 'state.json');
  let bumps = 0;
  const fs = { renameSync: (a, b) => {
    if (b === statePath) { bumps++; patchState(p, (s) => { s.complexity = ['low', 'medium', 'high'][bumps % 3]; s.rev += 1; }); throw eperm(); }
    return realRename(a, b);
  } };
  stopIn(p, { fs });
  const failed = journal(p).filter((j) => j.type === 'state-save-failed').pop();
  assert.ok(failed && /changed under every attempt/.test(failed.error), JSON.stringify(failed));
  assert.equal(readState(p).complexity, ['low', 'medium', 'high'][bumps % 3], 'the last writer\'s state stands');
  assert.equal(inbox(p).length, 1);
  stopIn(p);
  assert.equal(spent(p), 70);
});

// ---------------------------------------------------------------- I3: a disarmed gate a lock keeps
test('I3: makeDormant removes every copy of the state; one a lock keeps gets the mark, and nothing promotes it', () => {
  const p = project();
  arm(p, 'dormant');
  stopIn(p);
  const g = gate(p, '');
  const statePath = gate(p, 'state.json');
  writeFileSync(`${statePath}${PENDING}`, readFileSync(statePath, 'utf8'));
  writeFileSync(gate(p, 'state.json.4321.abcdef.tmp'), '{}');
  // nothing locked: every copy goes, no mark needed
  let r = makeDormant(g);
  assert.deepEqual([r.dormant, r.marked, r.left], [true, false, []]);
  assert.ok(!gateFiles(p).some((n) => /^state\.json/.test(n)), gateFiles(p).join(','));
  // the pending copy locked (its removal refused): marked; the Stop, the verbs, status stay out
  arm(p, 'dormant 2');
  stopIn(p);
  writeFileSync(`${statePath}${PENDING}`, readFileSync(statePath, 'utf8'));
  const lockedRm = (path, opts) => { if (String(path).endsWith(PENDING)) throw eperm(); return rmSync(path, opts); };
  r = makeDormant(g, { rm: lockedRm });
  assert.deepEqual([r.dormant, r.marked, r.left], [true, true, [`state.json${PENDING}`]]);
  assert.ok(existsSync(gate(p, DISARMED_MARK)));
  assert.equal(stopIn(p).outcome, 'dormant');
  assert.ok(!existsSync(statePath), 'not re-armed');
  assert.match(cli(p, 'status').out, /NOT armed/);
  assert.equal(cli(p, 'report', 'pass').code, 1);
  // the next arm starts clean: mark and copies gone
  arm(p, 'after');
  assert.ok(!existsSync(gate(p, DISARMED_MARK)) && !existsSync(`${statePath}${PENDING}`));
  assert.equal(readState(p).task, 'after');
});

test('I3: disarm with the pending copy held open by another process -> after the release the loop stays NOT armed', { skip: process.platform !== 'win32' ? 'a share lock that refuses deletion is Windows behaviour' : false }, async () => {
  const p = project();
  arm(p, 'locked pending');
  stopIn(p);
  const pp = gate(p, `state.json${PENDING}`);
  writeFileSync(pp, readFileSync(gate(p, 'state.json'), 'utf8'));
  const ps = spawn('powershell', ['-NoProfile', '-Command', `$f=[System.IO.File]::Open('${pp}','Open','Read','Read'); Write-Output LOCKED; Start-Sleep -Seconds 6; $f.Close()`]);
  const exited = new Promise((res) => ps.on('exit', res));
  await new Promise((res) => ps.stdout.on('data', (d) => { if (String(d).includes('LOCKED')) res(); }));
  const d = cli(p, 'disarm');
  assert.equal(d.code, 0, d.out);
  // whether Windows lets the gate move with the file open varies (the archive may take it
  // whole); what must hold either way: no state.json, and a pending copy left only with the mark
  assert.ok(!existsSync(gate(p, 'state.json')));
  if (existsSync(pp)) assert.ok(existsSync(gate(p, DISARMED_MARK)), 'a pending copy left behind is marked');
  await exited;
  assert.equal(stopIn(p).outcome, 'dormant');
  assert.ok(!existsSync(gate(p, 'state.json')));
  assert.match(cli(p, 'status').out, /NOT armed/);
});

// ---------------------------------------------------------------- J
test('J: the watchdog\'s write never promotes a pending copy (promote: false)', () => {
  const p = project();
  arm(p, 'watchdog');
  const paths = gatePaths(p.dir);
  writeFileSync(`${paths.statePath}${PENDING}`, readFileSync(paths.statePath, 'utf8'));
  writeFileSync(paths.statePath, '');
  const r = updateState(paths, (s) => { s.flags.reconcileAsked = false; }, { promote: false });
  assert.equal(r.ok, false);
  assert.equal(readFileSync(paths.statePath, 'utf8'), '', 'untouched');
  assert.ok(existsSync(`${paths.statePath}${PENDING}`));
  assert.ok(!journal(p).some((j) => j.type === 'state-recovered'));
});

test('I3: the Stop\'s archive (budget) with the pending copy held open -> the leftover gate is marked, nothing re-arms it', { skip: process.platform !== 'win32' ? 'a share lock that refuses deletion is Windows behaviour' : false }, async () => {
  const p = project();
  arm(p, 'locked at budget');
  stopIn(p);
  const pp = gate(p, `state.json${PENDING}`);
  writeFileSync(pp, readFileSync(gate(p, 'state.json'), 'utf8'));
  patchState(p, (s) => { s.counters.iterations = 99; });
  const ps = spawn('powershell', ['-NoProfile', '-Command', `$f=[System.IO.File]::Open('${pp}','Open','Read','Read'); Write-Output LOCKED; Start-Sleep -Seconds 6; $f.Close()`]);
  const exited = new Promise((res) => ps.on('exit', res));
  await new Promise((res) => ps.stdout.on('data', (d) => { if (String(d).includes('LOCKED')) res(); }));
  assert.equal(stopIn(p).outcome, 'budget');
  assert.ok(!existsSync(gate(p, 'state.json')));
  if (existsSync(pp)) assert.ok(existsSync(gate(p, DISARMED_MARK)), 'a pending copy left behind is marked');
  await exited;
  assert.equal(stopIn(p).outcome, 'dormant');
  assert.ok(!existsSync(gate(p, 'state.json')));
});
