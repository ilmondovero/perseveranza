// How the loop's state files reach the disk, and come back from it. One place, so every
// writer follows the same rules (the Stop, the verbs, the watchdog, the inbox):
//
//   writeDurable(path, text, { expect })
//     (a) the text goes to a temporary file first, flushed (fsync) and read back: when that
//         fails or is incomplete the save FAILS and the target is never touched (a full disk
//         must not empty state.json);
//     (b) the rename over the target is retried a few times (Drive and antivirus hold files
//         for a moment on Windows). With `expect` (the text the writer read and built on),
//         the target is checked before EVERY attempt, the first included: when it no longer
//         holds that text another writer saved meanwhile, and the write gives up with
//         `conflict` instead of overwriting it; the caller rereads and recomputes;
//     (c) only then the text is written in place, and only once a complete copy can be found
//         by the next load: the temporary is first renamed to <target>.pending (or the pending
//         copy written and read back), then the target is written and read back, and the
//         pending copy goes only once the target holds the text. A crash at any point of the
//         write in place (a kill -9, a full disk) leaves a torn target AND a whole pending copy.
//   loadStateFile(paths)      state.json; when its CONTENT is absent, empty or corrupt and a
//                             valid state.json.pending is there (the run neither retained
//                             after an archive failure nor disarmed, the copy not older by
//                             time nor by rev), the pending copy is PROMOTED (state-recovered).
//                             A read refused for a moment (EBUSY) is retried, and then said
//                             (`transient`), never taken for a corrupt file.
//   updateState(paths, fn)    a verb's write: the state reread fresh, fn applied to the
//                             fields the verb owns, rev + 1, written by writeDurable with the
//                             text it read as `expect`, read back; on a conflict it starts
//                             over from the new state (UPDATE_TRIES times).
//
// What writeDurable does not close: the check of `expect` and the rename are two calls, not
// one, and a writer that lands between them is overwritten. The retries do not widen that
// window (every attempt checks again), but nothing bounds how long a process is held off the
// CPU between two calls: usually an instant, on a starved machine seconds (1.6 s measured under
// the stress of the final verification). Its cost is bounded by how the writers build:
//   - a verb's change overwritten there is lost (the verb said ok: a report, a complexity);
//   - a stop's save overwritten there loses its counts only until the next stop: the inbox
//     files it counted are not removed by it (stop-core.mjs, savedCounts), so they are counted
//     again, once. Unless a third stop loaded that save and removed those files before the
//     overwrite landed: then their tokens are lost. The error is always an undercount (a file
//     is never counted twice); test/e2e/state-overlap.test.mjs pins the sequence;
//   - a stop never builds on another stop's save it did not read: it starts over, or abandons
//     its save (stop-core.mjs, reconcile).
// Closing the instant needs a lock, and the repo has none: a lock is one more thing a crash
// leaves behind.
// The durability is against the death of the process (the temporary is flushed before it
// replaces anything); after a power loss the file system's own journal decides.
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadState } from '../core/state.mjs';
import { appendJournal } from './journal.mjs';
import { RETAINED_STATE, DISARMED_MARK } from './archive.mjs';

export const PENDING = '.pending';
export const UNSAVED_STATE = 'state.unsaved.json';
// the watchdog's record of a restore it launched (watchdog.mjs restoreLaunchedAt); a new run does
// not inherit it
export const RESTORE_SENTINEL = 'restore-launched.json';
export const RENAME_TRIES = 3;
export const RENAME_WAIT_MS = 40;
// a pending copy is promoted over a corrupt state.json only if it is not older than it by
// more than this (the pending copy is the complete text of the write that left state.json
// torn: written a moment before it)
export const PENDING_MAX_AGE_MS = 60 * 1000;
export const UPDATE_TRIES = 3;

export const realFs = {
  writeFileSync: nodeFs.writeFileSync, readFileSync: nodeFs.readFileSync, renameSync: nodeFs.renameSync,
  unlinkSync: nodeFs.unlinkSync, statSync: nodeFs.statSync, existsSync: nodeFs.existsSync,
  openSync: nodeFs.openSync, fsyncSync: nodeFs.fsyncSync, closeSync: nodeFs.closeSync,
};
const fsOf = (fs) => (fs ? { ...realFs, ...fs } : realFs);
export const sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait */ } };
const why = (e) => String((e && (e.code || e.message)) || e || 'error');
const flush = (f, p) => { let fd = null; try { fd = f.openSync(p, 'r+'); f.fsyncSync(fd); } catch { /* best effort: durability against a crash of the process holds without it */ } finally { if (fd != null) { try { f.closeSync(fd); } catch { /* closed */ } } } };

// -> { ok, atomic, pending, conflict, error }
// expect: undefined = no check; null = the target must be absent; a string = its text
export function writeDurable(path, text, { fs, keepPending = false, expect } = {}) {
  const f = fsOf(fs);
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  const pending = `${path}${PENDING}`;
  const drop = (p) => { try { f.unlinkSync(p); } catch { /* gone */ } };
  const fail = (error, extra = {}) => ({ ok: false, atomic: false, pending: false, conflict: false, error, ...extra });
  // is the target still what the writer built on?
  const moved = () => {
    if (expect === undefined) return false;
    let now = null;
    try { now = f.readFileSync(path, 'utf8'); } catch { now = null; }
    return now !== expect;
  };
  const conflict = () => { drop(tmp); return fail('the target changed since it was read', { conflict: true }); };
  // (a) the temporary, whole
  try { f.writeFileSync(tmp, text); } catch (e) { drop(tmp); return fail(`temporary: ${why(e)}`); }
  if (keepPending) flush(f, tmp);
  let back = null;
  try { back = f.readFileSync(tmp, 'utf8'); } catch (e) { drop(tmp); return fail(`temporary read back: ${why(e)}`); }
  if (back !== text) { drop(tmp); return fail('temporary incomplete'); }
  // (b) the rename, retried, the target checked before every attempt
  let renameErr = null;
  for (let i = 0; i < RENAME_TRIES; i++) {
    if (i > 0) sleepMs(RENAME_WAIT_MS * i);
    if (moved()) return conflict();
    try {
      f.renameSync(tmp, path);
      if (keepPending) drop(pending); // an older pending copy is superseded
      return { ok: true, atomic: true, pending: false, conflict: false, error: null };
    } catch (e) { renameErr = e; }
  }
  if (moved()) return conflict();
  // (c) in place. A state file: the complete copy becomes the pending copy FIRST, so a crash
  // in the middle of the write in place leaves it for the next load
  let copy = tmp;
  if (keepPending) {
    let parked = false;
    try { f.renameSync(tmp, pending); parked = true; } catch { /* written directly below */ }
    if (!parked) {
      try { f.writeFileSync(pending, text); flush(f, pending); parked = f.readFileSync(pending, 'utf8') === text; } catch { parked = false; }
      drop(tmp);
      if (!parked) { drop(pending); return fail(`rename: ${why(renameErr)}; no recoverable copy could be written (${pending}): not written in place`); }
    }
    copy = pending;
  }
  let placeErr = null;
  try { f.writeFileSync(path, text); } catch (e) { placeErr = e; }
  let landed = false;
  if (!placeErr) { try { landed = f.readFileSync(path, 'utf8') === text; } catch (e) { placeErr = e; } }
  if (landed) {
    drop(copy);
    return { ok: true, atomic: false, pending: false, conflict: false, error: null };
  }
  // placed: the write in place was attempted, so the target may exist (whole or not) and a
  // reader may already have seen it
  const error = `rename: ${why(renameErr)}; in place: ${placeErr ? why(placeErr) : 'read back differs'}`;
  if (keepPending) return fail(error, { pending: true, placed: true });
  drop(tmp);
  return fail(error, { placed: true });
}

// state.json as it is, recovered from its pending copy when its CONTENT cannot be used.
// promote: false reads the pending copy without writing it over state.json (a read-only
// reader: status, the bridge's verdict check). A read that fails (EBUSY, EPERM: a sync client
// or an antivirus holding the file) is retried and, if it keeps failing, answered as
// `transient`: the file may be whole and newer than any pending copy, so nothing is promoted.
// -> { state, raw, text, migrated, recovered } | { state: null, error, absent, transient }
export const READ_TRIES = 3;
export function loadStateFile(paths, { fs, journal = true, promote = true } = {}) {
  const f = fsOf(fs);
  let text = null;
  let error = null;
  for (let i = 0; i < READ_TRIES; i++) {
    if (i > 0) sleepMs(RENAME_WAIT_MS * i);
    try { text = f.readFileSync(paths.statePath, 'utf8'); error = null; break; } catch (e) { error = e && e.code === 'ENOENT' ? 'absent' : `unreadable: ${why(e)}`; if (error === 'absent') break; }
  }
  if (text == null && error !== 'absent') return { state: null, error, absent: false, transient: true };
  let rawRev = -1;
  if (text != null) {
    if (!text.trim()) error = 'empty';
    else {
      let raw;
      try { raw = JSON.parse(text); } catch (e) { error = `invalid JSON: ${e.message}`; }
      if (raw !== undefined) {
        const l = loadState(raw);
        if (l.state) return { state: l.state, raw, text, migrated: !!l.migrated, recovered: false };
        error = l.error;
        if (raw && typeof raw === 'object' && Number.isFinite(Number(raw.rev))) rawRev = Number(raw.rev);
      }
    }
  }
  const rec = recoverPending(paths, f, error, journal, promote, rawRev);
  return rec || { state: null, error, absent: error === 'absent' };
}

// rawRev: the rev of a state.json that parses but is not a loop state (-1: none readable);
// a pending copy with a lower rev is older than it and never promoted
function recoverPending(paths, f, was, journal, promote, rawRev = -1) {
  const pp = `${paths.statePath}${PENDING}`;
  // a retained run (archive failure) or a disarmed one whose gate could not be removed whole
  // (a locked file) is not armed: its pending copy must not arm it again
  if (!f.existsSync(pp) || f.existsSync(join(paths.gateDir, RETAINED_STATE)) || f.existsSync(join(paths.gateDir, DISARMED_MARK))) return null;
  let text;
  let raw;
  try { text = f.readFileSync(pp, 'utf8'); raw = JSON.parse(text); } catch { return null; }
  const l = loadState(raw);
  if (!l.state) return null;
  if (rawRev >= 0 && (l.state.rev || 0) < rawRev) return null;
  if (was !== 'absent') {
    let stateAt = 0;
    let pendingAt = 0;
    try { stateAt = f.statSync(paths.statePath).mtimeMs; } catch { /* gone */ }
    try { pendingAt = f.statSync(pp).mtimeMs; } catch { /* gone */ }
    if (stateAt && pendingAt + PENDING_MAX_AGE_MS < stateAt) return null;
  }
  if (!promote) return { state: l.state, raw, text, migrated: !!l.migrated, recovered: true, promoted: false };
  const w = writeDurable(paths.statePath, text, { fs: f, keepPending: true });
  if (journal) appendJournal(paths.gateDir, { type: 'state-recovered', from: `state.json${PENDING}`, was: String(was).slice(0, 120), promoted: w.ok, ...(w.ok ? {} : { error: w.error }) });
  return { state: l.state, raw, text, migrated: !!l.migrated, recovered: true };
}

// A verb's write. mutate(fresh) changes the fields the verb owns (and may return false to
// write nothing). promote: false (the watchdog, a detached process) never writes over a
// state.json that only its pending copy can stand for. -> { ok, state, before, error }
export function updateState(paths, mutate, { fs, tries = UPDATE_TRIES, promote = true } = {}) {
  const f = fsOf(fs);
  let lastErr = 'state changed under every attempt';
  for (let i = 0; i < tries; i++) {
    const r = loadStateFile(paths, { fs: f, promote });
    if (!r.state) return { ok: false, state: null, before: null, error: r.absent ? 'not armed' : `state.json unreadable: ${r.error}`, absent: r.absent };
    if (r.recovered && !promote) return { ok: false, state: null, before: null, error: 'state.json stands only in its pending copy: left to the next Stop or verb' };
    const before = r.state;
    const next = JSON.parse(JSON.stringify(before));
    if (mutate(next, before) === false) return { ok: true, state: before, before, unchanged: true };
    next.rev = (before.rev || 0) + 1;
    const text = JSON.stringify(next, null, 2);
    // written only over the state just read: another writer in between (before any attempt of
    // the rename, the retries included) is a conflict, and we start over from its state
    let expect = r.text;
    if (r.recovered) { try { expect = f.readFileSync(paths.statePath, 'utf8'); } catch { expect = null; } }
    const w = writeDurable(paths.statePath, text, { fs: f, keepPending: true, expect });
    if (w.conflict) { lastErr = 'state changed under every attempt'; sleepMs(RENAME_WAIT_MS * (i + 1)); continue; }
    if (!w.ok) return { ok: false, state: null, before, error: w.error };
    let back = null;
    try { back = f.readFileSync(paths.statePath, 'utf8'); } catch (e) { lastErr = `read back: ${why(e)}`; }
    if (back === text) return { ok: true, state: next, before };
    // someone wrote after us: is our change in what they wrote?
    try {
      const theirs = loadState(JSON.parse(back)).state;
      if (theirs) {
        const probe = JSON.parse(JSON.stringify(theirs));
        mutate(probe, theirs);
        if (JSON.stringify({ ...probe, rev: 0 }) === JSON.stringify({ ...theirs, rev: 0 })) return { ok: true, state: theirs, before };
      }
    } catch { /* unreadable: retried */ }
    lastErr = 'another writer replaced the state after the save';
    sleepMs(RENAME_WAIT_MS * (i + 1));
  }
  return { ok: false, state: null, before: null, error: lastErr };
}

// The state of a run retained after an archive failure: the newest of state.unsaved.json (the
// final state the Stop could not put in state.json) and state.disarmed.json (state.json as the
// archive renamed it). -> { state, file } | null
export function readRetainedState(gateDir, { fs } = {}) {
  const f = fsOf(fs);
  const found = [];
  for (const name of [UNSAVED_STATE, RETAINED_STATE]) {
    const p = join(gateDir, name);
    try {
      const st = loadState(JSON.parse(f.readFileSync(p, 'utf8'))).state;
      if (st) found.push({ state: st, file: name, at: f.statSync(p).mtimeMs });
    } catch { /* absent or unreadable */ }
  }
  found.sort((a, b) => (b.state.rev - a.state.rev) || (b.at - a.at));
  return found.length ? { state: found[0].state, file: found[0].file } : null;
}

// What a new run must not inherit from the gate of an old one.
export function cleanStateResidues(gateDir, { fs } = {}) {
  const f = fsOf(fs);
  const removed = [];
  let names = [];
  try { names = nodeFs.readdirSync(gateDir); } catch { return removed; }
  for (const n of names) {
    if (n === UNSAVED_STATE || n === DISARMED_MARK || n === RESTORE_SENTINEL || n === `state.json${PENDING}` || /^state\.json\.\d+\.[0-9a-f]+\.tmp$/.test(n)) {
      try { f.unlinkSync(join(gateDir, n)); removed.push(n); } catch { /* left */ }
    }
  }
  try { nodeFs.rmSync(join(gateDir, 'usage-inbox'), { recursive: true, force: true }); } catch { /* left */ }
  return removed;
}
