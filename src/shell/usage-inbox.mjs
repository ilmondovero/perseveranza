// The mod's token deltas, as an append-only inbox: .perseveranza/usage-inbox/<ts>-<pid>-<rand>.json,
// each { at, session, arm, byAgent } (armUnknown: written by a stop that could not read the
// state; accepted only if written after the current arm). No lock (the repo has none, and must
// survive a crash anywhere): a flush only ever CREATES a file of its own, atomically, and never
// touches state.json. The Stop logic, the one writer of state.json besides the verbs, lists the
// inbox before it reads the state, adds the deltas of the files still there once the state is
// read, and saves their names with their tokens. It does NOT remove the files it counted: a
// later stop removes them, because the state it loaded names them (stop-core.mjs, savedCounts).
//
// state.usageInboxSeen: the names already counted whose files may still be on disk. A listed
// file whose name is there is removed and never counted again. A name leaves the list only
// once its file is really gone (a removal refused by a sync client or an antivirus keeps the
// name, however many stops it takes). The list is not cut by count; MAX_INBOX_SEEN is only a
// guard against a state.json grown out of bounds, journaled when it acts.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileResult } from './activity.mjs';
import { mergeModUsage } from '../core/state.mjs';

export const INBOX_DIR = 'usage-inbox';
const NAME = /^[\w-]+\.json$/;
// a file that does not parse yet may be one written in place (rename refused): it is set
// aside as invalid only once it is this old
export const INBOX_SETTLE_MS = 5000;
export const MAX_INBOX_SEEN = 5000;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export const inboxDir = (gateDir) => join(gateDir, INBOX_DIR);
export const defaultUnlink = (p) => rmSync(p, { force: true });
// gone only when the filesystem says so (ENOENT): a file it refuses to stat (EPERM, EBUSY,
// EACCES: a sync client, an antivirus) is not an absent one
export function gone(p, stat = statSync) {
  try { stat(p); return false; } catch (e) { return !!e && e.code === 'ENOENT'; }
}

// -> { name }: queued, it will be counted |
//    { name, unverified: true, why }: the file under its inbox name may exist (the write in
//      place was attempted, or a file is left): a stop may already have counted it, so it is
//      NEVER sent again; if it never landed whole, that delta is lost. The caller journals it
//      (the stop and the bridge's flush both do, when the journal can be written) |
//    { error: 'no-loop' | 'not writable' }: dropped: the failure came before any file under
//      an inbox name could exist (the folder, the temporary), so no stop ever saw it: send
//      it again.
// So a dropped delta is never counted; the price is that an unverified one may be lost.
// writeDurable's ok already read the content back (the temporary before its rename, or the
// target written in place): no read of the final file, which an antivirus scanning a new
// file may refuse for a moment. The inbox folder is created only
// inside a gate that still exists, and never with its parents: a late flush must not
// recreate .perseveranza/ after the run was archived (the next run would count its tokens). The
// mkdir itself is the check (ENOENT: no gate), so a gate removed meanwhile is never recreated.
export function writeUsageDelta(gateDir, { session = '', arm = null, armUnknown = false, byAgent }, now = Date.now()) {
  const dir = inboxDir(gateDir);
  try { mkdirSync(dir); } catch (e) { if (!e || e.code !== 'EEXIST') return { error: e && e.code === 'ENOENT' ? 'no-loop' : 'not writable' }; }
  const name = `${now}-${process.pid}-${randomBytes(4).toString('hex')}.json`;
  const p = join(dir, name);
  const w = writeFileResult(p, JSON.stringify({ at: now, session, arm, ...(armUnknown ? { armUnknown: true } : {}), byAgent }));
  if (w.ok) return { name };
  // written in place, even if it failed: an overlapping stop may have counted it (and even
  // removed it since): never removed here, never reported dropped
  if (w.placed) return { name, unverified: true, why: w.error };
  return gone(p) ? { error: 'not writable' } : { name, unverified: true, why: w.error };
}

// A file the stop cannot read for longer than the settle time (an ACL, a folder by that
// name) is left where it is, uncounted; this empty marker beside it says it was journaled.
export const NOTED = '.unreadable';

// The inbox as it is now. note(text) -> bool journals a finding; the marker of an unreadable
// file and the rename of an invalid one happen only once their note is written, so a stop
// that cannot journal leaves them for the next one (never a finding marked but unsaid).
// -> { entries: [{ name, session, arm, byAgent }], seen: [names already counted], invalid: [{ name, as, error }],
//      unreadable: [{ name, error }] (refused now) }
// A file that does not parse (or has no byAgent object) and is old enough is renamed
// <name>.invalid: kept for forensics, never read again, never a crash. readOnly: a reader
// that is not the Stop (status) moves nothing.
export function readUsageInbox(gateDir, seen = [], now = Date.now(), { readOnly = false, note = () => true } = {}) {
  const dir = inboxDir(gateDir);
  const out = { entries: [], seen: [], invalid: [], unreadable: [] };
  let all = [];
  try { all = readdirSync(dir); } catch { return out; }
  const names = all.filter((n) => NAME.test(n)).sort();
  // a marker whose file is gone has done its job
  if (!readOnly) for (const m of all) if (m.endsWith(`.json${NOTED}`) && !all.includes(m.slice(0, -NOTED.length))) { try { rmSync(join(dir, m), { force: true }); } catch { /* next stop */ } }
  const counted = new Set(Array.isArray(seen) ? seen : []);
  for (const name of names) {
    if (counted.has(name)) { out.seen.push(name); continue; }
    const p = join(dir, name);
    let error = null;
    let v = null;
    let readErr = null;
    try { v = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { readErr = e; error = e && e.code === 'ENOENT' ? 'gone' : e && e.code ? 'refused' : `invalid JSON: ${e.message}`; }
    if (error === 'gone') continue; // removed by an overlapping stop since the listing
    // a read refused (EBUSY, EPERM, EACCES: an antivirus, an ACL): never set aside, read again
    // next stop; journaled once if it lasts past the settle time
    if (error === 'refused') {
      const code = String(readErr && readErr.code);
      out.unreadable.push({ name, error: code });
      let age = Infinity;
      try { age = now - statSync(p).mtimeMs; } catch { /* unknown: old */ }
      if (!readOnly && age >= INBOX_SETTLE_MS && !existsSync(`${p}${NOTED}`)
        && note(`usage inbox: ${name} cannot be read (${code}): not counted while it cannot; status lists it`)) {
        try { writeFileSync(`${p}${NOTED}`, ''); } catch { /* noted again next stop */ }
      }
      continue;
    }
    if (!error && !(isObj(v) && isObj(v.byAgent))) error = 'no byAgent object';
    if (error) {
      let age = Infinity;
      try { age = now - statSync(p).mtimeMs; } catch { /* gone */ }
      if (age < INBOX_SETTLE_MS || readOnly) continue;
      const as = `${name}.invalid`;
      const e2 = String(error).slice(0, 200);
      if (!note(`usage inbox: ${name} unreadable (${e2}), set aside as ${as}`)) continue; // said first, then moved
      try { renameSync(p, join(dir, as)); } catch { /* left: retried next stop */ }
      out.invalid.push({ name, as, error: e2 });
      continue;
    }
    out.entries.push({ name, session: typeof v.session === 'string' ? v.session : '', arm: typeof v.arm === 'string' ? v.arm : null, armUnknown: v.armUnknown === true, at: Number(v.at) || 0, byAgent: v.byAgent });
  }
  return out;
}

// Whose tokens a file holds: this run's (same arm, same session as the owner) or not.
// -> null when it is this run's, else why not
export function foreignReason(entry, state) {
  // a stop's own delta written while the state could not be read: this run's if written after it was armed
  if (entry.armUnknown && !entry.arm) { if (state.armedAt && !(entry.at >= Date.parse(state.armedAt))) return 'another arm'; }
  else if (state.armedAt && entry.arm !== state.armedAt) return 'another arm';
  if (entry.session && state.owner.sessionId && entry.session !== state.owner.sessionId) return 'another session';
  return null;
}

// The usage with every delta of the entries added; `clamped` collects the fields cut to
// MAX_TOKEN_DELTA. -> normalized usage (source 'mod')
export function applyInbox(usage, entries, clamped = null) {
  return entries.reduce((u, e) => mergeModUsage(u, e.byAgent, clamped), usage);
}

// The tokens waiting in the inbox (for `status`, which moves nothing): -> { files, usage,
// unreadable } where usage is the state's usage with them added and unreadable the names of
// the files that cannot be read now (not counted), or null when nothing waits.
export function pendingUsage(gateDir, state) {
  const r = readUsageInbox(gateDir, state.usageInboxSeen, Date.now(), { readOnly: true });
  const own = r.entries.filter((e) => !foreignReason(e, state));
  if (!own.length && !r.unreadable.length) return null;
  return { files: own.length, usage: applyInbox(state.usage, own), unreadable: r.unreadable.map((x) => x.name) };
}

export function removeInboxFiles(gateDir, names, unlink = defaultUnlink) {
  for (const n of names) { try { unlink(join(inboxDir(gateDir), n)); } catch { /* the name stays in seen: retried */ } }
}

// The names of `seen` whose files are still on disk, after one more attempt to remove them.
// Safe before the save: a name in the state read from disk is counted in that state.
export function settleSeen(gateDir, seen, unlink = defaultUnlink, stat = statSync) {
  const left = [];
  for (const n of Array.isArray(seen) ? seen : []) {
    const p = join(inboxDir(gateDir), n);
    try { unlink(p); } catch { /* still there, perhaps */ }
    if (!gone(p, stat)) left.push(n);
  }
  return left;
}

// -> { seen, dropped, droppedPresent }: the list (oldest first) bounded by the guard. Past
// it, the names whose files are already gone go first; only then the oldest of those still
// on disk (droppedPresent: those may be counted again, and the caller journals it). The
// newest, the names counted in this very save, are always kept.
export function boundSeen(names, gateDir = null, stat = statSync) {
  const unique = [...new Set(names)];
  let excess = unique.length - MAX_INBOX_SEEN;
  if (excess <= 0) return { seen: unique, dropped: 0, droppedPresent: 0 };
  const drop = new Set();
  if (gateDir) for (const n of unique) { if (excess <= drop.size) break; if (gone(join(inboxDir(gateDir), n), stat)) drop.add(n); }
  const droppedAbsent = drop.size;
  for (const n of unique) { if (drop.size >= excess) break; drop.add(n); }
  return { seen: unique.filter((n) => !drop.has(n)), dropped: drop.size, droppedPresent: drop.size - droppedAbsent };
}
