// The watchdog's reading of state.json (src/shell/watchdog.mjs decide/run), with an injected
// file system: a state that cannot be read for a moment (EBUSY from a sync client or an
// antivirus, a file torn by a write in place, a crash that left only the pending copy) is not a
// disarmed loop, and the watchdog keeps watching; only a state really gone ends the watch.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, utimesSync, statSync as statSyncReal } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decide, run, restore, restoreLaunchedAt, sentinelVerdict, dropRestoreSentinel, clearInterrupted, markInterrupted, readSentinel, restoreTimes, UNREADABLE_RETRY_MS, MAX_UNREADABLE, MAX_RESTORES, SENTINEL_FUTURE_MS, SENTINEL_ABANDON_MIN_MS } from '../../src/shell/watchdog.mjs';
import { cleanStateResidues, RESTORE_SENTINEL } from '../../src/shell/state-file.mjs';
import { normalizeState } from '../../src/core/state.mjs';
import { DISARMED_MARK, RETAINED_STATE } from '../../src/shell/archive.mjs';

const tmps = [];
after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
const T = Date.now();
const STALE = 60_000;

// a gate with a loop whose owner fired a moment ago (alive: the watchdog sleeps) or long ago
function gateWith({ firedAgo = 1000, write = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prs-wd-'));
  tmps.push(dir);
  const gateDir = join(dir, '.perseveranza');
  mkdirSync(gateDir);
  const state = normalizeState({ phase: 'implement', task: 'watched', armedAt: new Date(T - 3600_000).toISOString(), owner: { sessionId: 'A', lastFireAt: T - firedAgo } });
  const text = JSON.stringify(state, null, 2);
  if (write) writeFileSync(join(gateDir, 'state.json'), text);
  return { gateDir, statePath: join(gateDir, 'state.json'), text };
}
const busy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
// an fs whose reads of state.json fail `times` times with EBUSY (Infinity: always), then read the disk
function busyFs(statePath, times) {
  let left = times;
  const calls = { state: 0 };
  return {
    calls,
    readFileSync: (p, enc) => {
      if (p === statePath) { calls.state += 1; if (left > 0) { left -= 1; throw busy(); } }
      return readFileSync(p, enc);
    },
  };
}
const opts = (extra = {}) => ({ now: T, staleMs: STALE, pid: process.pid, startedAt: T - 10, ...extra });

test('decide: EBUSY once is retried inside the read and the loop is watched as usual', () => {
  const g = gateWith();
  const fs = busyFs(g.statePath, 1);
  const d = decide(g.gateDir, opts({ fs }));
  assert.equal(d.action, 'sleep', JSON.stringify(d));
  assert.ok(fs.calls.state >= 2, 'read again after the refusal');
});

test('decide: EBUSY at every attempt is not a disarm: retry later, never exit', () => {
  const g = gateWith();
  const d = decide(g.gateDir, opts({ fs: busyFs(g.statePath, Infinity) }));
  assert.equal(d.action, 'retry', JSON.stringify(d));
  assert.equal(d.ms, UNREADABLE_RETRY_MS);
  assert.match(d.why, /EBUSY/);
});

test('decide: a torn state.json (a write in place cut short, no pending copy) is retried, not an exit', () => {
  const g = gateWith();
  writeFileSync(g.statePath, g.text.slice(0, 40));
  const d = decide(g.gateDir, opts());
  assert.equal(d.action, 'retry', JSON.stringify(d));
  assert.match(d.why, /invalid JSON/);
  // an empty one too
  writeFileSync(g.statePath, '');
  assert.equal(decide(g.gateDir, opts()).action, 'retry');
});

test('decide: only the pending copy (a crash in a write in place): read as the state, never promoted', () => {
  // alive: the watchdog sleeps on it
  const g = gateWith({ write: false });
  writeFileSync(`${g.statePath}.pending`, g.text);
  const d = decide(g.gateDir, opts());
  assert.equal(d.action, 'sleep', JSON.stringify(d));
  assert.equal(existsSync(g.statePath), false, 'not promoted by the watchdog');
  // silent: it alerts on it (a hung session is watched even then)
  const s = gateWith({ write: false, firedAgo: 20 * 3600_000 });
  writeFileSync(`${s.statePath}.pending`, s.text);
  const a = decide(s.gateDir, opts());
  assert.equal(a.action, 'alert', JSON.stringify(a));
  assert.equal(a.state.task, 'watched');
  assert.equal(existsSync(s.statePath), false);
  // torn state.json beside a whole pending copy: the pending copy stands
  const t = gateWith();
  writeFileSync(`${t.statePath}.pending`, t.text);
  writeFileSync(t.statePath, t.text.slice(0, 30));
  assert.equal(decide(t.gateDir, opts()).action, 'sleep');
  assert.equal(readFileSync(t.statePath, 'utf8'), t.text.slice(0, 30), 'nothing written');
});

test('decide: disarmed (absent; marked; retained) exits, even with a pending copy left beside the mark', () => {
  const absent = gateWith({ write: false });
  assert.deepEqual(decide(absent.gateDir, opts()), { action: 'exit', why: 'disarmed' });
  const marked = gateWith({ write: false });
  writeFileSync(`${marked.statePath}.pending`, marked.text);
  writeFileSync(join(marked.gateDir, DISARMED_MARK), '{}');
  assert.deepEqual(decide(marked.gateDir, opts()), { action: 'exit', why: 'disarmed' });
  const retained = gateWith({ write: false });
  writeFileSync(join(retained.gateDir, RETAINED_STATE), retained.text);
  assert.deepEqual(decide(retained.gateDir, opts()), { action: 'exit', why: 'disarmed' });
  // the mark decides before the state is read (a gate the disarm could not remove whole)
  const both = gateWith();
  writeFileSync(join(both.gateDir, DISARMED_MARK), '{}');
  assert.equal(decide(both.gateDir, opts()).action, 'exit');
});

test('run: a state unreadable for a few cycles is waited for, then the watch goes on (the count starts over)', async () => {
  const g = gateWith();
  const seq = ['retry', 'retry', 'sleep', 'retry', 'retry', 'exit'];
  const naps = [];
  let i = 0;
  const r = await run(g.gateDir, { PERSEVERANZA_NO_NOTIFY: '1' }, {
    decide: () => { const a = seq[i++]; return a === 'retry' ? { action: 'retry', ms: UNREADABLE_RETRY_MS, why: 'state.json unreadable (EBUSY)' } : a === 'sleep' ? { action: 'sleep', ms: 7, why: 'alive' } : { action: 'exit', why: 'disarmed' }; },
    sleep: async (ms) => { naps.push(ms); },
    maxUnreadable: 3,
  });
  assert.deepEqual(r, { code: 0, why: 'disarmed' });
  assert.deepEqual(naps, [UNREADABLE_RETRY_MS, UNREADABLE_RETRY_MS, 7, UNREADABLE_RETRY_MS, UNREADABLE_RETRY_MS]);
  assert.equal(existsSync(join(g.gateDir, 'journal.jsonl')), false, 'nothing journaled for a wait that ended');
});

test('run: unreadable at every cycle: after the cap of consecutive tries it exits and journals why', async () => {
  const g = gateWith();
  const naps = [];
  const fs = busyFs(g.statePath, Infinity);
  const r = await run(g.gateDir, { PERSEVERANZA_NO_NOTIFY: '1' }, { fs, sleep: async (ms) => { naps.push(ms); }, maxUnreadable: 4 });
  assert.equal(r.code, 0);
  assert.match(r.why, /EBUSY.*4 times in a row/);
  assert.deepEqual(naps, [UNREADABLE_RETRY_MS, UNREADABLE_RETRY_MS, UNREADABLE_RETRY_MS]);
  const lines = readFileSync(join(g.gateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, 'watchdog');
  assert.equal(lines[0].action, 'exit');
  assert.match(lines[0].why, /state\.json unreadable.*4 times in a row/);
  // the default cap: tens of tries, minutes of a held file (not one cycle)
  assert.ok(MAX_UNREADABLE * UNREADABLE_RETRY_MS >= 5 * 60_000, `${MAX_UNREADABLE} x ${UNREADABLE_RETRY_MS} ms`);
});

test('run: EBUSY for a while, then the loop is disarmed: the real decide waits and then exits for the disarm', async () => {
  const g = gateWith();
  const naps = [];
  // busy for 2 cycles of 3 read attempts each, then the state is gone
  let reads = 0;
  const fs = {
    readFileSync: (p, enc) => {
      if (p === g.statePath) {
        reads += 1;
        if (reads <= 6) throw busy();
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return readFileSync(p, enc);
    },
  };
  const r = await run(g.gateDir, { PERSEVERANZA_NO_NOTIFY: '1' }, { fs, sleep: async (ms) => { naps.push(ms); } });
  assert.deepEqual(r, { code: 0, why: 'disarmed' });
  assert.deepEqual(naps, [UNREADABLE_RETRY_MS, UNREADABLE_RETRY_MS]);
});

// ---- the restore (PERSEVERANZA_RESTORE=1): never on a state that stands only in its pending
// copy, never before the interruption is marked, never twice before the restored session's
// first Stop (the sentinel restore-launched.json, independent of signals.interrupted)

const STARTED = new Date(T - 7200_000).toISOString();
// a hung loop whose Claude Code process (pid 4242) is on record; pending: only state.json.pending
function hungGate({ pending = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prs-wdr-'));
  tmps.push(dir);
  const gateDir = join(dir, '.perseveranza');
  mkdirSync(gateDir);
  const state = normalizeState({ phase: 'implement', task: 'hung', armedAt: new Date(T - 30 * 3600_000).toISOString(), owner: { sessionId: 'sess-H', lastFireAt: T - 20 * 3600_000, claudePid: 4242, claudeStartedAt: STARTED } });
  const text = JSON.stringify(state, null, 2);
  const statePath = join(gateDir, 'state.json');
  writeFileSync(pending ? `${statePath}.pending` : statePath, text);
  return { gateDir, statePath, text, sentinel: join(gateDir, RESTORE_SENTINEL) };
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
// fake process io: records what happens, and what was on disk at each step
function fakeIo(g, { alive = true, killed = true, launched = true } = {}) {
  const calls = [];
  const disk = () => ({ interrupted: existsSync(g.statePath) ? readJson(g.statePath).signals.interrupted : null, sentinel: existsSync(g.sentinel) ? readJson(g.sentinel) : null });
  return {
    calls,
    processInfo: (pid) => { calls.push({ op: 'info', pid }); return { alive, name: 'node.exe', cmd: 'node C:/x/@anthropic-ai/claude-code/cli.js', startedAt: STARTED }; },
    killTree: (pid) => { calls.push({ op: 'kill', pid, ...disk() }); return killed; },
    launchRestore: (o) => { calls.push({ op: 'launch', session: o.sessionId, ...disk() }); return launched ? { ok: true, how: 'fake' } : { ok: false, error: 'spawn failed' }; },
  };
}
const NOENV = { PERSEVERANZA_NO_NOTIFY: '1' };
// The alert a restore acts on, decided at the time of the call. Not at T (the time this file
// was loaded): a sentinel or an interruption stamped "a second ago" is younger than T for the
// first second of the run, the 1 s threshold not yet passed, so decide() slept and returned no
// state (a TypeError on a fast machine, a pass on a slow one).
const alertOn = (g) => {
  const d = decide(g.gateDir, opts({ now: Date.now(), staleMs: 1000 }));
  assert.equal(d.action, 'alert', `the fixture is a silent loop: ${JSON.stringify(d)}`);
  return d;
};
// The abandon interval restore() applies with NOENV: twice the restore threshold, itself twice the
// 30 min stale default, so exactly 2 h.
// A fixture meant to be past it is stamped a minute beyond: one stamped at exactly 2 h ago is
// abandoned only if a millisecond passes before restore() reads the clock (strictly more than
// the interval), which a fast machine does not guarantee.
const ABANDON_MS = restoreTimes(NOENV).abandonMs;
const PAST_ABANDON_MS = ABANDON_MS + 60_000;
const failWrites = (prefix, code) => ({ writeFileSync: (p, t, ...rest) => { if (String(p).startsWith(prefix)) throw Object.assign(new Error(code), { code }); return writeFileSync(p, t, ...rest); } });

test('decide: restorable only on a whole state.json, not on its pending copy alone', () => {
  const whole = alertOn(hungGate());
  assert.equal(whole.action, 'alert'); assert.equal(whole.restorable, true);
  const pend = alertOn(hungGate({ pending: true }));
  assert.equal(pend.action, 'alert'); assert.equal(pend.restorable, false);
});

test('restore: a state standing only in its pending copy is never restored and nothing is written', () => {
  const g = hungGate({ pending: true });
  const io = fakeIo(g);
  const r = restore(g.gateDir, alertOn(g), NOENV, io);
  assert.equal(r.attempted, false); assert.match(r.why, /pending copy/);
  assert.deepEqual(io.calls, [], 'no process looked at, killed or launched');
  assert.equal(existsSync(g.statePath), false, 'not promoted, not written');
  assert.equal(readFileSync(`${g.statePath}.pending`, 'utf8'), g.text);
  assert.equal(existsSync(g.sentinel), false);
});

test('restore: the interruption and the sentinel are on disk BEFORE the kill and the launch', () => {
  const g = hungGate();
  const io = fakeIo(g);
  const r = restore(g.gateDir, alertOn(g), NOENV, io);
  assert.equal(r.launched, true, JSON.stringify(r)); assert.equal(r.killed, true);
  assert.deepEqual(io.calls.map((c) => c.op), ['info', 'kill', 'launch']);
  for (const c of io.calls.slice(1)) {
    assert.ok(c.interrupted && c.interrupted.at, `${c.op}: interruption marked first`);
    assert.ok(c.sentinel && c.sentinel.at === c.interrupted.at && c.sentinel.session === 'sess-H', `${c.op}: sentinel written first`);
    assert.equal(c.sentinel.by, process.pid);
  }
});

test('restore: the interruption cannot be marked (state.json writes fail): no kill, no launch, no sentinel', () => {
  const g = hungGate();
  const io = fakeIo(g);
  io.fs = failWrites(g.statePath, 'EPERM');
  const r = restore(g.gateDir, alertOn(g), NOENV, io);
  assert.equal(r.attempted, false); assert.match(r.why, /could not be marked/);
  assert.deepEqual(io.calls.map((c) => c.op), ['info']);
  assert.equal(readFileSync(g.statePath, 'utf8'), g.text, 'state unchanged');
  assert.equal(existsSync(g.sentinel), false);
});

test('restore: the sentinel cannot be written: the mark is undone, no kill, no launch', () => {
  const g = hungGate();
  const io = fakeIo(g);
  io.fs = failWrites(g.sentinel, 'EBUSY');
  const r = restore(g.gateDir, alertOn(g), NOENV, io);
  assert.equal(r.attempted, false); assert.match(r.why, /sentinel could not be written/);
  assert.deepEqual(io.calls.map((c) => c.op), ['info']);
  assert.equal(readJson(g.statePath).signals.interrupted, null, 'the mark is undone');
  assert.equal(existsSync(g.sentinel), false);
});

test('restore: a kill or a launch that fails undoes both marks', () => {
  for (const fail of [{ killed: false }, { launched: false }]) {
    const g = hungGate();
    const io = fakeIo(g, fail);
    const r = restore(g.gateDir, alertOn(g), NOENV, io);
    assert.notEqual(r.launched, true, JSON.stringify(r));
    assert.equal(readJson(g.statePath).signals.interrupted, null, `${JSON.stringify(fail)}: mark undone`);
    assert.equal(existsSync(g.sentinel), false, `${JSON.stringify(fail)}: sentinel removed`);
  }
});

test('restore: the sentinel alone refuses a second restore before the restored session Stops, and counts as life', () => {
  const g = hungGate();
  assert.equal(restore(g.gateDir, alertOn(g), NOENV, fakeIo(g)).launched, true);
  const at = Date.parse(readJson(g.sentinel).at);
  // the field the guard used to rest on alone is gone (a write lost, a hand edit): the sentinel holds
  const s = readJson(g.statePath); s.signals.interrupted = null; writeFileSync(g.statePath, JSON.stringify(s, null, 2));
  assert.equal(decide(g.gateDir, opts({ now: at + 10, staleMs: 1000 })).action, 'sleep', 'the launch is a sign of life');
  const d = decide(g.gateDir, opts({ now: at + 5000, staleMs: 1000 }));
  assert.equal(d.action, 'alert'); assert.equal(d.via, 'restore');
  const io = fakeIo(g);
  const again = restore(g.gateDir, d, NOENV, io);
  assert.equal(again.attempted, false); assert.match(again.why, /has not reached a Stop yet/);
  assert.deepEqual(io.calls, []);
  // an unreadable sentinel fails closed
  writeFileSync(g.sentinel, '{torn');
  assert.equal(restoreLaunchedAt(g.gateDir, readJson(g.statePath)), Infinity);
  assert.match(restore(g.gateDir, d, NOENV, fakeIo(g)).why, /has not reached a Stop yet/);
});

test('dropRestoreSentinel: kept until a Stop of the owner after the launch; another session sentinel goes', () => {
  const g = hungGate();
  const put = (o) => writeFileSync(g.sentinel, JSON.stringify(o));
  const fireAt = (ms) => { const s = readJson(g.statePath); s.owner.lastFireAt = ms; writeFileSync(g.statePath, JSON.stringify(s, null, 2)); };
  const at = T - 1000;
  put({ at: new Date(at).toISOString(), session: 'sess-H', by: 1 });
  assert.equal(dropRestoreSentinel(g.gateDir), false, 'no Stop since the launch');
  assert.equal(existsSync(g.sentinel), true);
  fireAt(at + 1);
  assert.equal(dropRestoreSentinel(g.gateDir), true);
  assert.equal(existsSync(g.sentinel), false);
  assert.equal(dropRestoreSentinel(g.gateDir), false, 'nothing to drop');
  put({ at: new Date(T + 5000).toISOString(), session: 'other', by: 1 });
  assert.equal(restoreLaunchedAt(g.gateDir, readJson(g.statePath)), 0, 'another session launch is not this loop launch');
  assert.equal(dropRestoreSentinel(g.gateDir), true);
  // unreadable: kept until a Stop, then dropped
  writeFileSync(g.sentinel, 'x');
  fireAt(0);
  assert.equal(dropRestoreSentinel(g.gateDir), false);
  fireAt(Date.now() + 1000);
  assert.equal(dropRestoreSentinel(g.gateDir), true);
});

test('cleanStateResidues (arm) removes a restore sentinel left by an old run', () => {
  const g = hungGate();
  writeFileSync(g.sentinel, JSON.stringify({ at: new Date(T).toISOString(), session: 'sess-H' }));
  assert.ok(cleanStateResidues(g.gateDir).includes(RESTORE_SENTINEL));
  assert.equal(existsSync(g.sentinel), false);
});

test('run: a pending-only state alerts once, says no restore, keeps watching and never restores', async () => {
  const g = hungGate({ pending: true });
  const io = fakeIo(g);
  const naps = [];
  let looks = 0;
  const r = await run(g.gateDir, { ...NOENV, PERSEVERANZA_RESTORE: '1', PERSEVERANZA_STALE_MS: '1000', PERSEVERANZA_RESTORE_AFTER_MS: '1000' }, {
    // the real decide for 5 looks, then the loop is disarmed
    decide: (gd, o) => (++looks > 5 ? { action: 'exit', why: 'disarmed' } : decide(gd, o)),
    sleep: async (ms) => { naps.push(ms); },
    restoreIo: io,
  });
  assert.deepEqual(r, { code: 0, why: 'disarmed' });
  assert.deepEqual(io.calls, [], 'nothing killed or launched');
  assert.deepEqual(naps, Array(5).fill(UNREADABLE_RETRY_MS), 'kept watching');
  const lines = readFileSync(join(g.gateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => `${l.type}:${l.action}`), ['watchdog:alerted'], 'alerted once');
  assert.match(lines[0].text, /No restore: state\.json stands only in its pending copy/);
  assert.doesNotMatch(lines[0].text, /will be terminated/);
  assert.equal(existsSync(g.statePath), false); assert.equal(existsSync(g.sentinel), false);
});

// ---- manual-302: the sentinel fails closed, is claimed exclusively, never blocks for ever

const journalOf = (g) => (existsSync(join(g.gateDir, 'journal.jsonl')) ? readFileSync(join(g.gateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const patch = (g, fn) => { const s = readJson(g.statePath); fn(s); writeFileSync(g.statePath, JSON.stringify(s, null, 2)); };
const putSentinel = (g, o) => writeFileSync(g.sentinel, typeof o === 'string' ? o : JSON.stringify(o));
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const WAITING = /has not reached a Stop yet/;

test('the sentinel fails closed: JSON null, an invalid at, no session field all block a restore', () => {
  for (const [label, content] of [['null', 'null'], ['an array', '[]'], ['invalid at', { at: 'yesterday', session: 'sess-H' }], ['no at', { session: 'sess-H' }]]) {
    const g = hungGate();
    putSentinel(g, content);
    assert.equal(readSentinel(g.gateDir, readJson(g.statePath)).kind, 'unreadable', label);
    assert.equal(restoreLaunchedAt(g.gateDir, readJson(g.statePath)), Infinity, label);
    const io = fakeIo(g);
    assert.match(restore(g.gateDir, alertOn(g), NOENV, io).why, WAITING, label);
    assert.deepEqual(io.calls, [], `${label}: nothing looked at, killed or launched`);
  }
  // no session field: the owner's (a guard, not a pass)
  const g = hungGate();
  const at = Date.now() - 1000;
  putSentinel(g, { at: new Date(at).toISOString() });
  assert.equal(restoreLaunchedAt(g.gateDir, readJson(g.statePath)), at);
  assert.match(restore(g.gateDir, alertOn(g), NOENV, fakeIo(g)).why, WAITING);
});

test('restore: interrupted.at after the last Stop refuses even with no sentinel (the round-1 guard kept)', () => {
  const g = hungGate();
  patch(g, (s) => { s.signals.interrupted = { at: ago(1000), silentMs: 1, phase: 'implement', pending: [] }; });
  const io = fakeIo(g);
  assert.match(restore(g.gateDir, alertOn(g), NOENV, io).why, WAITING);
  assert.deepEqual(io.calls, []);
});

test('restore: the launch is stamped at the call, in the sentinel and the interruption alike', () => {
  const g = hungGate();
  const t0 = Date.now();
  assert.equal(restore(g.gateDir, alertOn(g), NOENV, fakeIo(g)).launched, true);
  const t1 = Date.now();
  const at = Date.parse(readJson(g.sentinel).at);
  assert.ok(at >= t0 && at <= t1, `${t0} <= ${at} <= ${t1}`);
  assert.equal(readJson(g.statePath).signals.interrupted.at, readJson(g.sentinel).at);
  assert.equal(readJson(g.sentinel).phase, 'launched', 'rewritten once launched');
  assert.ok(/^[0-9a-f]{12}$/.test(readJson(g.sentinel).nonce));
});

test('restore: the sentinel is claimed exclusively; a watchdog that read it absent and lost the claim launches nothing', () => {
  const g = hungGate();
  // this watchdog decided on the silence, then the other one claimed between its read and its claim
  const d = alertOn(g);
  putSentinel(g, { at: new Date().toISOString(), session: 'sess-H', by: 1, nonce: 'other', phase: 'claimed' });
  const io = fakeIo(g);
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  io.fs = { statSync: (p, ...r) => { if (String(p) === g.sentinel) throw enoent(); return statSyncReal(p, ...r); } };
  const r = restore(g.gateDir, d, NOENV, io);
  assert.equal(r.attempted, false); assert.match(r.why, /another watchdog has just claimed this restore/);
  assert.deepEqual(io.calls.map((c) => c.op), ['info'], 'nothing killed or launched');
  assert.equal(readJson(g.statePath).signals.interrupted, null, 'no interruption marked');
  assert.equal(readJson(g.sentinel).nonce, 'other', 'the winner\'s sentinel untouched');
});

test('clearInterrupted takes back only its own mark; markInterrupted asks for the reconcile again', () => {
  const g = hungGate();
  patch(g, (s) => { s.signals.interrupted = { at: 'A', silentMs: 1, phase: 'implement', pending: [] }; s.flags.reconcileAsked = true; });
  assert.equal(clearInterrupted(g.gateDir, 'B').unchanged, true);
  assert.equal(readJson(g.statePath).signals.interrupted.at, 'A', 'another mark stays');
  assert.equal(clearInterrupted(g.gateDir, 'A').ok, true);
  assert.equal(readJson(g.statePath).signals.interrupted, null);
  patch(g, (s) => { s.flags.reconcileAsked = true; });
  assert.equal(markInterrupted(g.gateDir, { at: 'C', silentMs: 5 }).ok, true);
  assert.equal(readJson(g.statePath).flags.reconcileAsked, false, 'the restored session is asked to reconcile');
});

test('a sentinel dated in the future: never a block; retired by the watchdog, dropped by a Stop', () => {
  const g = hungGate();
  const future = new Date(Date.now() + SENTINEL_FUTURE_MS + 3600_000).toISOString();
  putSentinel(g, { at: future, session: 'sess-H', by: 1, nonce: 'n', phase: 'launched' });
  assert.equal(restoreLaunchedAt(g.gateDir, readJson(g.statePath)), 0, 'no life, no guard');
  const r = restore(g.gateDir, alertOn(g), NOENV, fakeIo(g));
  assert.equal(r.launched, true, JSON.stringify(r));
  const j = journalOf(g).find((e) => e.action === 'sentinel-retired');
  assert.ok(j && /dated in the future/.test(j.why), JSON.stringify(journalOf(g)));
  // within the tolerance it still counts (a clock a little off is no reason to relaunch)
  const n = hungGate();
  putSentinel(n, { at: new Date(Date.now() + 60_000).toISOString(), session: 'sess-H', by: 1, nonce: 'n', phase: 'launched' });
  assert.match(restore(n.gateDir, alertOn(n), NOENV, fakeIo(n)).why, WAITING);
  // a Stop of the owner removes a future one, though its clock is behind it
  const s = hungGate();
  putSentinel(s, { at: future, session: 'sess-H', by: 1, nonce: 'n', phase: 'launched' });
  patch(s, (st) => { st.owner.lastFireAt = Date.now(); });
  assert.equal(dropRestoreSentinel(s.gateDir), true);
  assert.equal(existsSync(s.sentinel), false);
});

test('a claim abandoned by a dead watchdog (killed between the marks and the launch) expires: retired, counted, the restore goes on', () => {
  const H = 3600_000;
  const at = ago(PAST_ABANDON_MS);
  const g = hungGate();
  patch(g, (s) => { s.signals.interrupted = { at, silentMs: 1, phase: 'implement', pending: [] }; });
  putSentinel(g, { at, session: 'sess-H', by: 999999, nonce: 'dead', phase: 'claimed' });
  // its watchdog still alive: not abandoned, a refusal
  const live = fakeIo(g); live.alive = () => true;
  assert.match(restore(g.gateDir, alertOn(g), NOENV, live).why, WAITING);
  assert.deepEqual(live.calls, []);
  // gone: retired, the stale interruption cleared, a new attempt launched
  const io = fakeIo(g); io.alive = () => false;
  const r = restore(g.gateDir, alertOn(g), NOENV, io);
  assert.equal(r.launched, true, JSON.stringify(r));
  const j = journalOf(g).filter((e) => e.type === 'watchdog');
  assert.deepEqual(j.map((e) => e.action), ['restore-abandoned']);
  assert.match(j[0].why, /never launched: abandoned/);
  assert.notEqual(readJson(g.statePath).signals.interrupted.at, at, 'the new attempt marked its own');
  assert.notEqual(readJson(g.sentinel).nonce, 'dead');
  // within the abandon interval it still blocks, dead watchdog or not
  const y = hungGate();
  putSentinel(y, { at: ago(SENTINEL_ABANDON_MIN_MS - 60_000), session: 'sess-H', by: 999999, nonce: 'young', phase: 'claimed' });
  const yi = fakeIo(y); yi.alive = () => false;
  assert.match(restore(y.gateDir, alertOn(y), NOENV, yi).why, WAITING);
  // a LAUNCHED one never expires by time: the restored session may be alive on a prompt
  const l = hungGate();
  putSentinel(l, { at: ago(10 * H), session: 'sess-H', by: 999999, nonce: 'l', phase: 'launched' });
  const li = fakeIo(l); li.alive = () => false;
  assert.match(restore(l.gateDir, alertOn(l), NOENV, li).why, WAITING);
  // the interval: twice the restore threshold, at least ten minutes
  assert.equal(restoreTimes({}).abandonMs, Math.max(2 * restoreTimes({}).restoreAfterMs, SENTINEL_ABANDON_MIN_MS));
  assert.equal(restoreTimes({ PERSEVERANZA_STALE_MS: '1000', PERSEVERANZA_RESTORE_AFTER_MS: '1000' }).abandonMs, SENTINEL_ABANDON_MIN_MS);
});

test('an abandoned attempt counts toward the restore limit', () => {
  const g = hungGate();
  const lines = Array.from({ length: MAX_RESTORES - 1 }, () => JSON.stringify({ ts: new Date().toISOString(), type: 'watchdog', action: 'restored' })).join('\n');
  writeFileSync(join(g.gateDir, 'journal.jsonl'), `${lines}\n`);
  putSentinel(g, { at: ago(PAST_ABANDON_MS), session: 'sess-H', by: 999999, nonce: 'dead', phase: 'claimed' });
  const io = fakeIo(g); io.alive = () => false;
  const r = restore(g.gateDir, alertOn(g), NOENV, io);
  assert.match(r.why, new RegExp(`restore limit \\(${MAX_RESTORES}\\)`), JSON.stringify(r));
  assert.deepEqual(io.calls, []);
});

// the boundary itself, on a clock given rather than read: abandoned only strictly past it
test('the abandon interval is a strict bound: at it a claim or an unreadable sentinel still blocks, a millisecond past it expires', () => {
  const now = Date.now();
  const state = { owner: { sessionId: 'sess-H', lastFireAt: now - 20 * 3600_000 } };
  const claim = (at) => ({ kind: 'record', at, phase: 'claimed', by: 999999, nonce: 'n', text: 'x' });
  const torn = (mtimeMs) => ({ kind: 'unreadable', text: '{torn', mtimeMs });
  const v = (sen) => sentinelVerdict(sen, state, { now, abandonMs: ABANDON_MS, isAlive: () => false });
  assert.ok(v(claim(now - ABANDON_MS)).block, 'a claim exactly at the interval');
  assert.equal(v(claim(now - ABANDON_MS - 1)).abandoned, true);
  assert.ok(v(torn(now - ABANDON_MS)).block, 'an unreadable one exactly at the interval');
  assert.equal(v(torn(now - ABANDON_MS - 1)).abandoned, true);
});

test('an unreadable sentinel expires too; a directory at its path is moved aside and blocks nothing', () => {
  const g = hungGate();
  putSentinel(g, '{torn');
  const old = (Date.now() - PAST_ABANDON_MS) / 1000;
  utimesSync(g.sentinel, old, old);
  const r = restore(g.gateDir, alertOn(g), NOENV, fakeIo(g));
  assert.equal(r.launched, true, JSON.stringify(r));
  assert.match(journalOf(g).find((e) => e.action === 'restore-abandoned').why, /unreadable/);
  // an empty directory: removed
  const d = hungGate();
  mkdirSync(d.sentinel);
  assert.equal(restoreLaunchedAt(d.gateDir, readJson(d.statePath)), Infinity, 'no life from it');
  assert.equal(restore(d.gateDir, alertOn(d), NOENV, fakeIo(d)).launched, true);
  assert.match(journalOf(d).find((e) => e.action === 'sentinel-retired').why, /not a file/);
  assert.equal(readJson(d.sentinel).phase, 'launched', 'a real sentinel in its place');
  assert.deepEqual(readdirSync(d.gateDir).filter((n) => n.endsWith('.old')), [], 'the empty directory removed');
  // a directory with something in it: moved aside (left for a human), not deleted, no block
  const f = hungGate();
  mkdirSync(f.sentinel);
  writeFileSync(join(f.sentinel, 'keep.txt'), 'x');
  assert.equal(restore(f.gateDir, alertOn(f), NOENV, fakeIo(f)).launched, true);
  assert.equal(readdirSync(f.gateDir).filter((n) => n.endsWith('.old')).length, 1, 'moved aside');
  // and a Stop moves one aside as well
  const s = hungGate();
  mkdirSync(s.sentinel);
  assert.equal(dropRestoreSentinel(s.gateDir), true);
  assert.equal(existsSync(s.sentinel), false);
});

test('dropRestoreSentinel: the same millisecond as the launch counts as a Stop after it', () => {
  const g = hungGate();
  const at = Date.now() - 1000;
  putSentinel(g, { at: new Date(at).toISOString(), session: 'sess-H', by: 1, nonce: 'n', phase: 'launched' });
  patch(g, (s) => { s.owner.lastFireAt = at; });
  assert.equal(dropRestoreSentinel(g.gateDir), true);
});

test('run: without PERSEVERANZA_RESTORE a pending-only state gets the plain alert, no word about a restore', async () => {
  const g = hungGate({ pending: true });
  const r = await run(g.gateDir, { ...NOENV, PERSEVERANZA_STALE_MS: '1000' }, { sleep: async () => {} });
  assert.deepEqual(r, { code: 0, why: 'alerted' });
  const [a] = journalOf(g);
  assert.match(a.text, /Check the session: status, resume --takeover, or disarm\.$/);
  assert.doesNotMatch(a.text, /No restore/);
});

test('run: a sign of life between two silences means a new alert before any restore', async () => {
  const g = hungGate();
  const T0 = Date.now();
  const seq = [
    { action: 'alert', seenAt: T0, silentMs: 5000 }, // first silence: alerted, restore far off
    { action: 'sleep', ms: 1, why: 'alive' }, // life
    { action: 'alert', seenAt: T0, silentMs: 5000 }, // second silence: alerted again
    { action: 'exit', why: 'disarmed' },
  ];
  let i = 0;
  const state = readJson(g.statePath);
  const r = await run(g.gateDir, { ...NOENV, PERSEVERANZA_RESTORE: '1', PERSEVERANZA_STALE_MS: '1000', PERSEVERANZA_RESTORE_AFTER_MS: '3600000' }, {
    decide: () => { const d = seq[i++]; return d.action === 'alert' ? { ...d, state, activity: null, via: 'fire', restorable: true } : d; },
    sleep: async () => {},
    restoreIo: fakeIo(g),
  });
  assert.deepEqual(r, { code: 0, why: 'disarmed' });
  assert.deepEqual(journalOf(g).map((e) => e.action), ['alerted', 'alerted']);
});

test('run: after a launch a replacement watchdog takes over the watch (replace: true)', async () => {
  const g = hungGate();
  const spawned = [];
  const r = await run(g.gateDir, { ...NOENV, PERSEVERANZA_RESTORE: '1', PERSEVERANZA_STALE_MS: '1000', PERSEVERANZA_RESTORE_AFTER_MS: '1000' }, {
    decide: (gd, o) => decide(gd, { ...o, pid: process.pid }),
    sleep: async () => {},
    restoreIo: fakeIo(g),
    spawnWatchdog: (gd, env, opts) => { spawned.push([gd, opts]); return 4321; },
  });
  assert.deepEqual(r, { code: 0, why: 'restored' });
  assert.deepEqual(spawned, [[g.gateDir, { replace: true }]]);
  assert.equal(journalOf(g).find((e) => e.action === 'restored').restore.watchdog, 4321);
});

test('history: the watchdog events without a silence and a dropped outcome read as such', async () => {
  const { formatEntry } = await import('../../src/shell/journal.mjs');
  const ts = '2026-10-07T00:00:00.000Z';
  assert.equal(formatEntry({ ts, type: 'watchdog', action: 'restore-abandoned', why: 'x gone' }), '2026-10-07 00:00:00 | WATCHDOG restore abandoned (counted): x gone');
  assert.equal(formatEntry({ ts, type: 'watchdog', action: 'sentinel-retired', why: 'dated in the future' }), '2026-10-07 00:00:00 | WATCHDOG restore sentinel retired: dated in the future');
  assert.equal(formatEntry({ ts, type: 'watchdog', action: 'exit', why: 'unreadable' }), '2026-10-07 00:00:00 | WATCHDOG exit: unreadable');
  assert.match(formatEntry({ ts, type: 'watchdog', action: 'alerted', silentMs: 60000, via: 'fire', seenAt: ts, phase: 'review' }), /WATCHDOG: silent for/);
  assert.equal(formatEntry({ ts, type: 'outcome-dropped-paused', by: 'stop', fields: ['signals.lastReport'], values: { lastReport: 'pass' } }), '2026-10-07 00:00:00 | outcome dropped, the loop is paused (stop): signals.lastReport {"lastReport":"pass"}');
});

test('an interruption dated in the future beyond the tolerance does not block; within it, it does', () => {
  const g = hungGate();
  patch(g, (s) => { s.signals.interrupted = { at: new Date(Date.now() + SENTINEL_FUTURE_MS + 3600_000).toISOString(), silentMs: 1, phase: 'implement', pending: [] }; });
  assert.equal(restore(g.gateDir, alertOn(g), NOENV, fakeIo(g)).launched, true);
  const n = hungGate();
  patch(n, (s) => { s.signals.interrupted = { at: new Date(Date.now() + 60_000).toISOString(), silentMs: 1, phase: 'implement', pending: [] }; });
  assert.match(restore(n.gateDir, alertOn(n), NOENV, fakeIo(n)).why, WAITING);
});

test('retireSentinel removes only the sentinel it read: a newer one goes back to its place', async () => {
  const { retireSentinel } = await import('../../src/shell/watchdog.mjs');
  const g = hungGate();
  putSentinel(g, { at: new Date().toISOString(), session: 'sess-H', nonce: 'newer', phase: 'claimed' });
  assert.equal(retireSentinel(g.gateDir, { kind: 'record', text: JSON.stringify({ nonce: 'older' }) }), false);
  assert.equal(readJson(g.sentinel).nonce, 'newer', 'back in its place');
  assert.deepEqual(readdirSync(g.gateDir).filter((n) => n.endsWith('.old')), []);
  assert.equal(retireSentinel(g.gateDir, { kind: 'record', text: readFileSync(g.sentinel, 'utf8') }), true);
  assert.equal(existsSync(g.sentinel), false);
  assert.equal(retireSentinel(g.gateDir, { kind: 'absent' }), true, 'nothing there: nothing to retire');
});
