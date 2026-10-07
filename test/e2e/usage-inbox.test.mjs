// The mod's token inbox driven by the real Stop logic (in process, so a refused removal can be
// simulated) and by the real bridge: bounded counts, crash safety, files that will not go,
// files that are not this run's, late flushes after the archive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, utimesSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { project, cli, arm, readState, patchState, gate, journal, spawnSync, readFileSync, writeFileSync, existsSync, join, NODE } from '../helpers/cli.mjs';
import { ROOT } from '../../src/shell/paths.mjs';
import { runStopFromFacts } from '../../src/shell/stop-core.mjs';
import { writeUsageDelta, MAX_INBOX_SEEN, settleSeen, boundSeen, gone } from '../../src/shell/usage-inbox.mjs';
import { tokenCount, normalizeUsage, mergeModUsage, MAX_TOKENS, MAX_TOKEN_DELTA } from '../../src/core/state.mjs';
import { tokensSpent } from '../../src/core/budget.mjs';

const BRIDGE = join(ROOT, 'src', 'shell', 'mod-bridge.mjs');
const bridge = (p, req) => {
  const r = spawnSync(NODE, [BRIDGE], { input: JSON.stringify({ cwd: p.dir, ...req, event: { session_id: 't-sess', ...(req.event || {}) } }), encoding: 'utf8', env: p.env });
  let res = null;
  try { res = JSON.parse(r.stdout); } catch { /* asserted */ }
  return { code: r.status, res, raw: r.stdout };
};
const inbox = (p) => { try { return readdirSync(gate(p, 'usage-inbox')).sort(); } catch { return null; } };
const stopIn = (p, io = {}) => runStopFromFacts({ evt: { cwd: p.dir, session_id: 't-sess' }, env: p.env, io });
// an armed loop the session owns, paused: every stop saves the state and spends no iteration
function pausedLoop() {
  const p = project();
  arm(p, 'inbox');
  stopIn(p);
  patchState(p, (s) => { s.signals.paused = true; });
  return p;
}
const delta = (p, n, extra = {}) => writeUsageDelta(gate(p, ''), { session: 't-sess', arm: readState(p).armedAt, byAgent: { main: { inputTokens: n, outputTokens: 0 } }, ...extra });
const spent = (p) => readState(p).usage.inputTokens;

// ---------------------------------------------------------------- bounded counts
test('tokenCount: every value is a finite non-negative integer; too big saturates, never 0', () => {
  for (const [v, want] of [[12, 12], ['12', 12], [12.9, 12], ['12.9', 12], [0, 0], [-5, 0], ['-5', 0], [NaN, 0], ['abc', 0], ['', 0], [null, 0], [undefined, 0], [true, 0], [{}, 0], [[7], 0],
    [Infinity, MAX_TOKENS], [1e308, MAX_TOKENS], ['9'.repeat(400), MAX_TOKENS], [-Infinity, 0],
    // strings: plain decimal digits only (no exponent, sign, hex, binary, octal, spaces)
    ['1e3', 0], ['1e400', 0], ['0x10', 0], ['0b11', 0], ['0o7', 0], [' 12', 0], ['12 ', 0], ['+12', 0], ['1_000', 0], ['007', 7]]) {
    assert.equal(tokenCount(v), want, `${String(v).slice(0, 20)}`);
  }
  // a stored total that a writer pushed past the limit is the limit, not 0
  assert.equal(normalizeUsage({ inputTokens: 1e308 }).inputTokens, MAX_TOKENS);
  assert.equal(normalizeUsage({ source: 'mod', byAgent: { a: { inputTokens: 1e308 }, b: { inputTokens: 1e308 } } }).inputTokens, MAX_TOKENS);
});

test('mergeModUsage: each delta field clamped to MAX_TOKEN_DELTA and reported; sums saturate; hostile values never subtract', () => {
  const clamped = [];
  let u = mergeModUsage(null, { main: { inputTokens: 1e308 } }, clamped);
  u = mergeModUsage(u, { main: { inputTokens: '9'.repeat(400), outputTokens: Infinity } }, clamped);
  assert.equal(u.inputTokens, 2 * MAX_TOKEN_DELTA);
  assert.equal(u.outputTokens, MAX_TOKEN_DELTA);
  assert.deepEqual(clamped.map((c) => c.field), ['inputTokens', 'inputTokens', 'outputTokens']);
  const before = tokensSpent(u);
  for (const bad of [{ inputTokens: -1e12 }, { inputTokens: NaN }, { inputTokens: 'x' }, { inputTokens: '-3' }, { inputTokens: null }]) {
    u = mergeModUsage(u, { main: bad });
    assert.equal(tokensSpent(u), before, JSON.stringify(bad));
  }
  // decimals are floored, numbers as strings counted
  assert.equal(mergeModUsage(null, { a: { inputTokens: '41.9' }, b: { inputTokens: 0.5 } }).inputTokens, 41);
  // already at the limit: stays there
  const full = mergeModUsage({ source: 'mod', inputTokens: MAX_TOKENS, byAgent: { main: { inputTokens: MAX_TOKENS } } }, { main: { inputTokens: 5 } });
  assert.equal(full.inputTokens, MAX_TOKENS);
  assert.equal(full.byAgent.main.inputTokens, MAX_TOKENS);
});

test('bridge: two flushes of 1e308 with maxTokens 5000 -> clamped, counted, the budget stops the run', () => {
  const p = project();
  arm(p, 'huge');
  bridge(p, { op: 'stop' });
  for (let i = 0; i < 2; i++) assert.equal(bridge(p, { op: 'usage-flush', facts: { usage: { byAgent: { main: { inputTokens: 1e308, outputTokens: 1e308 } } } } }).res.outcome, 'usage-queued');
  bridge(p, { op: 'stop' });
  const u = readState(p).usage;
  assert.ok(u.inputTokens >= 3000 && u.inputTokens === 2 * MAX_TOKEN_DELTA, String(u.inputTokens));
  const j = journal(p).find((e) => e.type === 'usage-clamped');
  assert.ok(j && j.count === 4, JSON.stringify(j));
  patchState(p, (s) => { s.limits.maxTokens = 5000; });
  assert.equal(bridge(p, { op: 'stop' }).res.outcome, 'budget');
  assert.equal(readState(p), null);
});

// ---------------------------------------------------------------- crash safety and removal
test('inbox: a crash between the save and the removal (1000 files) counts each once', () => {
  const p = pausedLoop();
  for (let i = 0; i < 1000; i++) assert.ok(delta(p, 2).name);
  const refuse = () => { throw new Error('crash before the removal'); };
  stopIn(p, { unlink: refuse });
  assert.equal(spent(p), 2000);
  assert.equal(inbox(p).length, 1000, 'nothing removed');
  assert.equal(readState(p).usageInboxSeen.length, 1000);
  stopIn(p);
  assert.equal(spent(p), 2000, 'the files named in the state are removed, not counted again');
  assert.deepEqual(inbox(p), []);
  stopIn(p);
  assert.equal(spent(p), 2000);
  assert.deepEqual(readState(p).usageInboxSeen, [], 'a name leaves the list once its file is gone');
});

test('inbox: a file is removed only once the state that counts it is on disk (any crash point is safe)', () => {
  const p = pausedLoop();
  for (let i = 0; i < 5; i++) delta(p, 10);
  stopIn(p, { unlink: () => { throw new Error('first stop: removal refused'); } }); // now 5 names in seen
  for (let i = 0; i < 3; i++) delta(p, 10);
  const violations = [];
  let removed = 0;
  const checking = (path) => {
    const st = JSON.parse(readFileSync(gate(p, 'state.json'), 'utf8'));
    if (!st.usageInboxSeen.includes(basename(path))) violations.push(basename(path));
    rmSync(path, { force: true });
    removed += 1;
  };
  stopIn(p, { unlink: checking });
  assert.equal(removed, 5, 'the 5 named in the state this stop loaded; the 3 it counted stay until the next stop');
  assert.equal(spent(p), 80);
  assert.equal(inbox(p).length, 3);
  stopIn(p, { unlink: checking });
  assert.equal(removed, 8);
  assert.deepEqual(violations, [], 'every file removed was already counted in the state on disk');
  assert.equal(spent(p), 80);
  assert.deepEqual(inbox(p), []);
});

test('inbox: a counted file that cannot be removed for 300 stops is counted once', () => {
  const p = pausedLoop();
  const stuck = delta(p, 100).name;
  const refuseStuck = (path) => { if (basename(path) === stuck) throw new Error('EPERM (sync client)'); rmSync(path, { force: true }); };
  for (let i = 0; i < 300; i++) stopIn(p, { unlink: refuseStuck });
  assert.equal(spent(p), 100);
  assert.deepEqual(inbox(p), [stuck]);
  assert.deepEqual(readState(p).usageInboxSeen, [stuck], 'kept while the file is on disk');
  stopIn(p);
  assert.deepEqual(inbox(p), []);
  stopIn(p);
  assert.deepEqual(readState(p).usageInboxSeen, []);
  assert.equal(spent(p), 100);
});

test('inbox: names in the list whose files vanished leave it; the guard of the list is far above the files of a run', () => {
  const p = pausedLoop();
  patchState(p, (s) => { s.usageInboxSeen = ['1-1-gone.json', '2-2-gone.json']; });
  stopIn(p);
  assert.deepEqual(readState(p).usageInboxSeen, []);
  assert.equal(MAX_INBOX_SEEN, 5000);
});

test('inbox: a file of another session or of another arm is never counted (and removed)', () => {
  const p = pausedLoop();
  delta(p, 100);
  delta(p, 7000, { session: 'other-session' });
  delta(p, 9000, { arm: '2020-01-01T00:00:00.000Z' });
  delta(p, 3000, { arm: null });
  stopIn(p);
  assert.equal(spent(p), 100);
  assert.equal(inbox(p).length, 1, 'the strays removed now; the counted file stays until the next stop');
  assert.ok(readState(p).usageInboxSeen.includes(inbox(p)[0]));
  const note = journal(p).find((j) => j.type === 'note' && j.text.includes('not of this run'));
  assert.ok(note && note.text.includes('3 file(s)') && note.text.includes('another session') && note.text.includes('another arm'), JSON.stringify(note));
  assert.equal(readState(p).usageInboxSeen.length, 1, 'only the counted file is named (until its removal is confirmed)');
});

test('status reads the inbox and moves nothing, a corrupt file included', () => {
  const p = pausedLoop();
  delta(p, 100);
  delta(p, 5, { session: 'other-session' });
  const bad = gate(p, 'usage-inbox/1-1-bad.json');
  writeFileSync(bad, '{"byAgent":');
  const past = new Date(Date.now() - 60_000);
  utimesSync(bad, past, past);
  const before = inbox(p);
  const st = cli(p, 'status');
  assert.ok(st.out.includes('(incl. 1 flush(es) still in the inbox)'), st.out);
  assert.deepEqual(inbox(p), before, 'nothing renamed or removed');
  stopIn(p);
  const named = readState(p).usageInboxSeen;
  assert.deepEqual(inbox(p).filter((n) => !named.includes(n)), ['1-1-bad.json.invalid'], 'the Stop sets it aside');
});

// ---------------------------------------------------------------- no loop, no inbox
test('a flush after the run was archived creates nothing and says no-loop', () => {
  const p = project();
  arm(p, 'late');
  bridge(p, { op: 'stop' });
  assert.equal(cli(p, 'disarm').code, 0);
  assert.ok(!existsSync(gate(p, '')));
  const r = bridge(p, { op: 'usage-flush', facts: { usage: { byAgent: { main: { inputTokens: 100 } } } } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.res, { ok: false, error: 'no-loop' });
  assert.ok(!existsSync(gate(p, '')), '.perseveranza not recreated');
  // the folder alone, without its parent, is never made
  assert.deepEqual(writeUsageDelta(gate(p, ''), { byAgent: { main: { inputTokens: 1 } } }), { error: 'no-loop' });
  assert.ok(!existsSync(gate(p, '')));
  // a new run of the same session does not count the tokens of the old one
  arm(p, 'next');
  bridge(p, { op: 'stop' });
  assert.equal(readState(p).usage.inputTokens, 0);
});

// ---------------------------------------------------------------- a save that does not land
// A save of state.json the file system refuses, the same refusal on every platform:
//   Windows: the read-only attribute on state.json refuses the rename over it and the write in
//     place alike;
//   Linux, macOS: a file's own mode does not protect it from a rename over it (the folder's
//     does: the save's temporary-and-rename went through and the save simply landed), so the
//     loop folder is made read-only, which refuses the temporary the save writes first;
//   root (a container): permissions refuse nothing (CAP_DAC_OVERRIDE), so the refusal is made
//     where the system call would make it, in the fs the Stop writes state.json through.
// -> { io (for the Stop), undo }
function refuseStateSaves(p) {
  const statePath = gate(p, 'state.json');
  if (process.platform === 'win32') {
    chmodSync(statePath, 0o444);
    return { io: {}, undo: () => chmodSync(statePath, 0o644) };
  }
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    chmodSync(gate(p, ''), 0o555);
    return { io: {}, undo: () => chmodSync(gate(p, ''), 0o755) };
  }
  const eacces = (path) => Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES' });
  const fs = { writeFileSync: (path, ...rest) => { if (basename(String(path)).startsWith('state.json')) throw eacces(path); return writeFileSync(path, ...rest); } };
  return { io: { fs }, undo: () => {} };
}

test('inbox: state.json read-only -> the save fails, nothing removed, nothing marked counted; after the fix the 777 count once', () => {
  const p = pausedLoop();
  delta(p, 777);
  const statePath = gate(p, 'state.json');
  const before = readFileSync(statePath, 'utf8');
  let r;
  const refusal = refuseStateSaves(p);
  try { r = stopIn(p, refusal.io); } finally { refusal.undo(); }
  assert.equal(r.outcome, 'paused', 'the Stop still answers');
  assert.equal(readFileSync(statePath, 'utf8'), before, 'the refused save left the file as it was');
  assert.equal(inbox(p).length, 1, 'the delta is still in the inbox');
  assert.equal(spent(p), 0);
  assert.deepEqual(readState(p).usageInboxSeen, []);
  const failed = journal(p).find((j) => j.type === 'state-save-failed');
  assert.ok(failed && /EPERM|EACCES/.test(failed.error), JSON.stringify(failed));
  assert.ok(journal(p).some((j) => j.type === 'note' && j.text.includes('1 file(s) kept')));
  // permissions back: the next stop counts the 777 once, the one after removes the file
  stopIn(p);
  assert.equal(spent(p), 777);
  stopIn(p);
  assert.deepEqual(inbox(p), []);
  stopIn(p);
  assert.equal(spent(p), 777);
});

test('inbox: a write that lands only half (or not where it should) is a failed save; one written in place is a good one', () => {
  const p = pausedLoop();
  delta(p, 50);
  const half = (path, text) => { writeFileSync(path, text.slice(0, Math.floor(text.length / 2))); return { ok: true, atomic: true, error: null }; };
  stopIn(p, { writeState: half });
  const failed = journal(p).filter((j) => j.type === 'state-save-failed').pop();
  assert.ok(failed && failed.error.includes('read back'), JSON.stringify(failed));
  assert.equal(inbox(p).length, 1, 'kept');
  // a write that says ok and writes nothing
  const p2 = pausedLoop();
  delta(p2, 60);
  const nothing = () => ({ ok: true, atomic: true, error: null });
  stopIn(p2, { writeState: nothing });
  assert.equal(inbox(p2).length, 1, 'a state that does not hold the counts is not a save');
  assert.equal(spent(p2), 0);
  // a write that throws
  stopIn(p2, { writeState: () => { throw new Error('EBUSY'); } });
  assert.equal(inbox(p2).length, 1);
  // the rename refused, the text written in place: the save landed and is verified
  const inPlace = (path, text) => { writeFileSync(path, text); return { ok: true, atomic: false, error: null }; };
  stopIn(p2, { writeState: inPlace });
  assert.equal(spent(p2), 60);
  stopIn(p2);
  assert.equal(spent(p2), 60);
  assert.deepEqual(inbox(p2), []);
});

test('a final state that cannot be saved is neither archived nor disarmed unless it lands beside state.json', () => {
  // budget: saveState, archiveRun, disarm. state.json refuses, state.unsaved.json is written
  const p = project();
  arm(p, 'final');
  stopIn(p);
  patchState(p, (s) => { s.counters.iterations = 99; });
  const onlyAside = (path, text) => (basename(path) === 'state.json' ? { ok: false, error: 'EPERM' } : (writeFileSync(path, text), { ok: true, atomic: true, error: null }));
  let r = stopIn(p, { writeState: onlyAside });
  assert.equal(r.outcome, 'budget');
  assert.ok(!existsSync(gate(p, '')), 'archived with the final state beside it, then disarmed');
  const files = readdirSync(join(p.home, 'runs'), { recursive: true }).map(String);
  assert.ok(files.some((f) => basename(f) === 'state.unsaved.json'), files.join(','));
  // nothing lands at all: no archive, no disarm, said in the journal
  const q = project();
  arm(q, 'final');
  stopIn(q);
  patchState(q, (s) => { s.counters.iterations = 99; });
  r = stopIn(q, { writeState: () => ({ ok: false, error: 'EPERM' }) });
  assert.equal(r.outcome, 'budget');
  assert.ok(existsSync(gate(q, 'state.json')), 'still armed: the next stop retries');
  assert.ok(journal(q).some((j) => j.type === 'archive-skipped'));
});

// ---------------------------------------------------------------- the list of counted names
test('settleSeen: a name leaves the list only on ENOENT; EPERM, EBUSY, EACCES keep it', () => {
  const p = pausedLoop();
  const names = ['1-1-a.json', '2-2-b.json'];
  const failing = (code) => () => { const e = new Error(code); e.code = code; throw e; };
  const noUnlink = () => {};
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) assert.deepEqual(settleSeen(gate(p, ''), names, noUnlink, failing(code)), names, code);
  assert.deepEqual(settleSeen(gate(p, ''), names, noUnlink, failing('ENOENT')), []);
  assert.equal(gone('x', failing('EPERM')), false);
  assert.equal(gone('x', failing('ENOENT')), true);
  // through the Stop: a stat that refuses keeps the name, and the file is never counted again
  delta(p, 10);
  const refuse = () => { throw new Error('refused'); };
  stopIn(p, { unlink: refuse });
  const name = readState(p).usageInboxSeen[0];
  for (let i = 0; i < 3; i++) stopIn(p, { unlink: refuse, stat: failing('EBUSY') });
  assert.deepEqual(readState(p).usageInboxSeen, [name]);
  assert.equal(spent(p), 10);
});

test('boundSeen: past the guard the names whose files are gone go first, then the oldest; the newest always stay', () => {
  const p = pausedLoop();
  const dir = gate(p, 'usage-inbox');
  mkdirSync(dir, { recursive: true });
  const names = Array.from({ length: MAX_INBOX_SEEN + 3 }, (_, i) => `${String(i).padStart(5, '0')}-1-x.json`);
  // every file present: the 3 oldest are dropped, and said
  const present = () => ({});
  let b = boundSeen(names, gate(p, ''), present);
  assert.equal(b.seen.length, MAX_INBOX_SEEN);
  assert.deepEqual(b.seen.slice(-3), names.slice(-3), 'the newest kept');
  assert.deepEqual(names.slice(0, 3).filter((n) => b.seen.includes(n)), [], 'the oldest dropped');
  assert.equal(b.droppedPresent, 3);
  // some files already gone (in the middle): those go instead, nothing present is dropped
  const absent = new Set([names[100], names[200], names[300], names[400]]);
  const stat = (path) => { if (absent.has(basename(path))) { const e = new Error('x'); e.code = 'ENOENT'; throw e; } return {}; };
  b = boundSeen(names, gate(p, ''), stat);
  assert.equal(b.droppedPresent, 0);
  assert.ok(b.seen.includes(names[0]) && !b.seen.includes(names[100]) && !b.seen.includes(names[300]) && b.seen.includes(names[400]), 'only as many as needed');
  assert.deepEqual(b.seen.slice(-3), names.slice(-3));
  // under the guard nothing moves
  assert.deepEqual(boundSeen(['a.json', 'b.json', 'a.json']).seen, ['a.json', 'b.json']);
});
