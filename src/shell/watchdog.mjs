#!/usr/bin/env node
// The watchdog: a detached process that outlives the hook and speaks when the loop goes
// silent. The Stop hook and `arm` spawn one at every fire; it sleeps until the last sign
// of life (Stop or tool activity) is older than the stale threshold, re-sleeps as long as
// the loop keeps showing life, and, when the silence is real, journals a `watchdog` entry
// and sends the desktop notification. Every fire spawns a fresh one and records its pid in
// .perseveranza/watchdog.json: an older watchdog finds another pid there and exits, so at most
// one speaks. It exits on disarm (no state.json), on pause (a human is expected) and after
// a maximum lifetime. Disabled with PERSEVERANZA_NO_WATCHDOG=1 (tests).
//
// With PERSEVERANZA_RESTORE=1 it does not only speak: after the alert it waits a second
// threshold (PERSEVERANZA_RESTORE_AFTER_MS, default twice the stale threshold), and if the
// silence is still unbroken it terminates the Claude Code process that drove the loop
// (recorded by the Stop hook) and reopens the same session with a restore prompt, so a
// hung turn costs an hour, not a night. Two stages because a session waiting on a human
// (a permission prompt, a question) writes nothing either: the alert is the human's chance.
// At most MAX_RESTORES per run: a session that dies at every restore is a problem the
// human sees. Never a blind relaunch: no recorded process, no restore.
//
//   node watchdog.mjs <gateDir>          (spawned detached; run by hand to watch a loop)
import { readFileSync, writeFileSync, existsSync, realpathSync, unlinkSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { staleness, describeActivity, restorePrompt, DEFAULT_STALE_MS, formatAge, formatAt } from '../core/staleness.mjs';
import { stepCounts } from '../core/plan.mjs';
import { writeAtomic } from './activity.mjs';
import { readLife } from './life.mjs';
import { appendJournal, readJournal } from './journal.mjs';
import { updateState, loadStateFile, writeDurable, sleepMs, RESTORE_SENTINEL, RENAME_TRIES, RENAME_WAIT_MS } from './state-file.mjs';
import { DISARMED_MARK, RETAINED_STATE } from './archive.mjs';
import { loadPromptLayers } from './packs.mjs';
import { ROOT, loopCommand } from './paths.mjs';
import { processInfo, sameProcess, killTree, launchRestore } from './restore.mjs';
import { notify } from './notify.mjs';
import { readModFault, modFaultText } from './mod-fault.mjs';
import { parseTimeoutMs, boolEnv } from './util.mjs';

export const WATCHDOG_FILE = 'watchdog.json';
const TITLE = 'Claude Code - perseveranza';
const MAX_LIFE_MS = 48 * 60 * 60 * 1000;
const MAX_NAP_MS = 60 * 60 * 1000; // a clock jump must not strand it asleep for hours
export const MAX_RESTORES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function currentPid(gateDir) {
  try { return Number(JSON.parse(readFileSync(join(gateDir, WATCHDOG_FILE), 'utf8')).pid) || 0; } catch { return 0; }
}

// Is the process still there? EPERM means "yes, not ours to signal".
export function alive(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

// Spawn a detached watchdog for the gate and record its pid, unless a live one already
// watches it: it re-reads the gate at every wake, so it needs no replacement, and one
// process per loop is the whole budget. -> pid (new or incumbent) or 0.
export function spawnWatchdog(gateDir, env = process.env, { replace = false } = {}) {
  if (boolEnv(env.PERSEVERANZA_NO_WATCHDOG)) return 0;
  const incumbent = currentPid(gateDir);
  if (!replace && alive(incumbent)) return incumbent;
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), gateDir], { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.unref();
    const pid = child.pid || 0;
    // atomic: a torn pid file would read as "nobody owns it" and let every watchdog speak
    if (pid) writeAtomic(join(gateDir, WATCHDOG_FILE), JSON.stringify({ pid, spawnedAt: new Date().toISOString() }));
    return pid;
  } catch { return 0; }
}

// state.json that cannot be read for a moment is not a disarmed loop: this machine syncs the
// project with a cloud client and an antivirus may hold the file (EBUSY), a writer may be in
// the middle of a write in place (a torn file whose pending copy is not there yet), a crash
// may leave the state only in its pending copy. Exiting there would leave a hung session
// without a watchdog until the next Stop, which a hung session never brings. So decide()
// reads it like every other reader (loadStateFile, retried, never promoting a pending copy),
// and only a state that is really gone (absent, or the gate marked disarmed/retained) ends
// the watch. What cannot be read is tried again every UNREADABLE_RETRY_MS, at most
// MAX_UNREADABLE times in a row; then the watchdog exits and journals why.
export const UNREADABLE_RETRY_MS = 15000;
export const MAX_UNREADABLE = 40;

// One pass: -> { action: 'exit'|'sleep'|'retry'|'alert', ms?, why }
//   fs: injected file system for the reads of state.json (tests); the rest reads the disk
export function decide(gateDir, { now = Date.now(), staleMs = DEFAULT_STALE_MS, pid = process.pid, startedAt = now, fs } = {}) {
  if (now - startedAt > MAX_LIFE_MS) return { action: 'exit', why: 'max lifetime' };
  const paths = { gateDir, statePath: join(gateDir, 'state.json') };
  const f = fs ? { existsSync, ...fs } : { existsSync };
  // a gate marked disarmed or retained (an archive failure) is not armed, whatever is left in it
  if (f.existsSync(join(gateDir, DISARMED_MARK)) || f.existsSync(join(gateDir, RETAINED_STATE))) return { action: 'exit', why: 'disarmed' };
  const loaded = loadStateFile(paths, { fs, promote: false, journal: false });
  if (!loaded.state && loaded.absent) return { action: 'exit', why: 'disarmed' };
  // busy (a read refused at every retry), torn or empty with no pending copy to stand for it
  if (!loaded.state) return { action: 'retry', ms: UNREADABLE_RETRY_MS, why: `state.json unreadable (${String(loaded.error).slice(0, 80)})` };
  // only the pending copy stands (a crash in a write in place): it is the last whole state, and
  // it is read as such (never promoted here: the next Stop or verb does it). Watched and alerted
  // on, never restored: a restore must first mark the interruption in a whole state.json
  // (restorable below, restore())
  const state = loaded.state;
  const owner = currentPid(gateDir);
  if (owner && owner !== pid) return { action: 'exit', why: 'newer watchdog' };
  if (state.signals.paused) return { action: 'exit', why: 'paused' };
  const { activity, transcriptAt } = readLife(gateDir, state);
  const st = staleness(state, now, staleMs, activity, transcriptAt);
  const armed = Date.parse(state.armedAt || '') || 0;
  // A restored process needs time to start before it can emit transcript/tool activity.
  // Treat the successful launch recorded in `interrupted.at` as life until the first real
  // signal arrives, otherwise the replacement watchdog immediately restores it again. A
  // launch in the future is a hand edit or a clock jump, not a sign of life.
  // The launch is recorded twice: in the state (interrupted.at) and in the restore sentinel,
  // a file of its own (restoreLaunchedAt): either one counts.
  const launched = Math.max(state.signals.interrupted ? (Date.parse(state.signals.interrupted.at || '') || 0) : 0, restoreLaunchedAt(gateDir, state, { now }));
  const restoredAt = launched <= now ? launched : 0;
  const baseSeen = st.seenAt || armed;
  const seen = Math.max(baseSeen, restoredAt);
  const via = restoredAt > baseSeen ? 'restore' : (st.seenAt ? st.via : 'arm');
  if (!seen) return { action: 'exit', why: 'no clock' };
  const wait = seen + staleMs - now;
  if (wait > 0) return { action: 'sleep', ms: Math.min(wait + 500, MAX_NAP_MS), why: 'alive' };
  // only the owner's activity is the loop's (lastSeen already filtered it); kept after a
  // restore too: its pending delegations are still the ones that never came back
  return { action: 'alert', state, activity: st.via === 'activity' ? activity : null, silentMs: now - seen, seenAt: seen, via, restorable: !loaded.recovered };
}

// The restore sentinel: .perseveranza/restore-launched.json,
//   { at (ISO), session, by (the claiming watchdog's pid), nonce, phase: 'claimed' | 'launched' }
// CREATED EXCLUSIVELY (flag wx) by restore() before it marks, terminates or launches anything:
// the creation is the act that wins a restore, so of two watchdogs that both believe they own
// the gate (an empty or lost watchdog.json) one launches and the other refuses. Rewritten with
// phase 'launched' once the launch succeeded, and kept until a Stop of the restored session is
// on record (dropRestoreSentinel, called by every Stop). The guard does not rest on
// signals.interrupted alone, a field that may not be written. It never blocks for ever:
//   - dated in the future beyond SENTINEL_FUTURE_MS (a clock set back, a hand edit): stale;
//   - still 'claimed' (the watchdog died between its marks and the launch, a window of seconds:
//     taskkill) past the abandon interval, its watchdog gone: abandoned, the attempt counted in
//     MAX_RESTORES, and the interruption it marked cleared (no restored session reconciles it);
//   - unreadable (torn, empty) past the abandon interval: abandoned likewise;
//   - not a file at its path (a directory): moved aside, journaled.
// A 'launched' one waits for the Stop: the restored session may be alive on a trust or
// permission prompt, and a second `claude -r` beside it is what the sentinel prevents.
export const SENTINEL_FUTURE_MS = 5 * 60 * 1000;
export const SENTINEL_ABANDON_MIN_MS = 10 * 60 * 1000;
const SENTINEL_STALE_ACTIONS = ['restored', 'restore-abandoned'];

// the thresholds of the watch, from the environment (run() and restore() read the same)
export function restoreTimes(env = process.env) {
  const staleMs = parseTimeoutMs(env.PERSEVERANZA_STALE_MS, DEFAULT_STALE_MS);
  const restoreAfterMs = Math.max(staleMs, parseTimeoutMs(env.PERSEVERANZA_RESTORE_AFTER_MS, 2 * staleMs));
  return { staleMs, restoreAfterMs, abandonMs: Math.max(2 * restoreAfterMs, SENTINEL_ABANDON_MIN_MS) };
}

// -> { kind: 'absent' } | { kind: 'notfile' } | { kind: 'unreadable', text, mtimeMs }
//  | { kind: 'other', text } (another session's) | { kind: 'record', at, phase, by, nonce, text }
// Unreadable: not JSON, not an object, no valid `at`. A record without `session` is the owner's
// (it fails closed: a guard, not a pass).
export function readSentinel(gateDir, state, { fs } = {}) {
  const f = { readFileSync, statSync, ...(fs || {}) };
  const p = join(gateDir, RESTORE_SENTINEL);
  let st;
  try { st = f.statSync(p); } catch (e) { return e && e.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', text: null, mtimeMs: 0 }; }
  if (!st.isFile()) return { kind: 'notfile' };
  let text;
  try { text = f.readFileSync(p, 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', text: null, mtimeMs: st.mtimeMs }; }
  let r;
  try { r = JSON.parse(text); } catch { return { kind: 'unreadable', text, mtimeMs: st.mtimeMs }; }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { kind: 'unreadable', text, mtimeMs: st.mtimeMs };
  const owner = state && state.owner ? state.owner.sessionId : null;
  if (typeof r.session === 'string' && r.session && owner && r.session !== owner) return { kind: 'other', text };
  const at = Date.parse(r.at || '');
  if (!(Number.isFinite(at) && at > 0)) return { kind: 'unreadable', text, mtimeMs: st.mtimeMs };
  return { kind: 'record', at, phase: r.phase === 'launched' ? 'launched' : 'claimed', by: Number(r.by) || 0, nonce: String(r.nonce || ''), text };
}

// The launch time of the owner's sentinel as a sign of life for decide(): ms; 0 when absent,
// another session's or dated in the future; Infinity when it cannot be read (no life, a guard)
export function restoreLaunchedAt(gateDir, state, { fs, now = Date.now() } = {}) {
  const s = readSentinel(gateDir, state, { fs });
  if (s.kind === 'record') return s.at > now + SENTINEL_FUTURE_MS ? 0 : s.at;
  return s.kind === 'unreadable' || s.kind === 'notfile' ? Infinity : 0;
}

// What the sentinel means for a restore now (pure but for isAlive).
// -> { block: why|null, retire: why|null, abandoned }
export function sentinelVerdict(sen, state, { now = Date.now(), abandonMs = SENTINEL_ABANDON_MIN_MS, isAlive = alive } = {}) {
  const fired = state && state.owner ? Number(state.owner.lastFireAt) || 0 : 0;
  const ok = { block: null, retire: null, abandoned: false };
  const waiting = 'the restored session has not reached a Stop yet, so its Claude Code process is unknown: refusing a blind relaunch';
  switch (sen.kind) {
    case 'absent': return ok;
    case 'other': return { ...ok, retire: "another session's" };
    case 'notfile': return { ...ok, retire: 'not a file (a directory?) at its path' };
    case 'unreadable':
      if (sen.mtimeMs > 0 && fired >= sen.mtimeMs) return { ...ok, retire: 'unreadable, and the session stopped since' };
      if (sen.mtimeMs > 0 && now - sen.mtimeMs > abandonMs) return { ...ok, retire: `unreadable for over ${formatAge(abandonMs)}: abandoned`, abandoned: true };
      return { ...ok, block: `the restore sentinel cannot be read (a restore may be under way): ${waiting}` };
    default:
      if (sen.at > now + SENTINEL_FUTURE_MS) return { ...ok, retire: `dated in the future (${formatAt(sen.at)}): a clock set back or a hand edit` };
      if (fired >= sen.at) return { ...ok, retire: 'the restored session has stopped since' };
      if (sen.phase !== 'launched' && now - sen.at > abandonMs && !isAlive(sen.by)) return { ...ok, retire: `claimed ${formatAge(now - sen.at)} ago by watchdog ${sen.by}, which is gone, and never launched: abandoned`, abandoned: true };
      return { ...ok, block: waiting };
  }
}

// Remove the sentinel that was read (sen), and only that one: moved aside first (between two
// watchdogs one rename wins), compared with what was read, then deleted; a newer claim moved
// aside by mistake goes back. Something that is not a file stays aside (removed when empty).
// -> true when the sentinel read is no longer at its path
export function retireSentinel(gateDir, sen) {
  const p = join(gateDir, RESTORE_SENTINEL);
  const aside = `${p}.${process.pid}.${randomBytes(3).toString('hex')}.old`;
  // retried: a file or folder just created may be held a moment (an antivirus, a sync client)
  let moved = false;
  for (let i = 0; i < RENAME_TRIES + 2 && !moved; i++) {
    if (i > 0) sleepMs(RENAME_WAIT_MS * i);
    try { renameSync(p, aside); moved = true; } catch (e) { if (e && e.code === 'ENOENT') return true; }
  }
  if (!moved) return false;
  if (sen.kind === 'notfile') { try { rmdirSync(aside); } catch { /* not empty: left aside, journaled by the caller */ } return true; }
  let text = null;
  try { text = readFileSync(aside, 'utf8'); } catch { /* compared as unknown */ }
  if (sen.text != null && text !== sen.text) {
    try { if (!existsSync(p)) renameSync(aside, p); } catch { /* left aside */ }
    return false;
  }
  try { unlinkSync(aside); } catch { /* left aside */ }
  return true;
}

// Called at the end of every Stop: the sentinel goes once the owner has a Stop on record after
// the launch (or it is dated in the future: a Stop is happening, the session is alive), when it
// is another session's or not a file, and an unreadable one once a Stop came after it was
// written. -> true when removed
export function dropRestoreSentinel(gateDir, { now = Date.now() } = {}) {
  if (!existsSync(join(gateDir, RESTORE_SENTINEL))) return false;
  let state = null;
  try { state = JSON.parse(readFileSync(join(gateDir, 'state.json'), 'utf8')); } catch { return false; }
  const sen = readSentinel(gateDir, state);
  const fired = state && state.owner ? Number(state.owner.lastFireAt) || 0 : 0;
  const go = sen.kind === 'other' || sen.kind === 'notfile'
    || (sen.kind === 'record' && fired > 0 && (fired >= sen.at || sen.at > now + SENTINEL_FUTURE_MS))
    || (sen.kind === 'unreadable' && sen.mtimeMs > 0 && fired >= sen.mtimeMs);
  return go ? retireSentinel(gateDir, sen) : false;
}

// Undo the mark of an interruption whose restore did not happen (a marked loop with nobody to
// reconcile would refuse every edit to the next human who opens the project). Only the mark
// this watchdog wrote (same `at`).
export function clearInterrupted(gateDir, at, { fs } = {}) {
  try {
    return updateState({ gateDir, statePath: join(gateDir, 'state.json') }, (fresh) => {
      if (!fresh.signals.interrupted || fresh.signals.interrupted.at !== at) return false;
      fresh.signals.interrupted = null;
      fresh.flags.reconcileAsked = false;
    }, { promote: false, fs });
  } catch (e) { return { ok: false, error: String(e && e.message) }; }
}

export function alertText(d, gateDir, now = Date.now()) {
  const proj = basename(dirname(gateDir));
  let planText = '';
  try { planText = readFileSync(join(gateDir, 'plan.md'), 'utf8'); } catch { /* no plan */ }
  const c = stepCounts(planText);
  const last = d.via === 'activity' ? `last activity ${describeActivity(d.activity, now)}`
    : d.via === 'transcript' ? `last output ${formatAge(now - d.seenAt)} ago (${formatAt(d.seenAt)})`
      : d.via === 'fire' ? `last Stop ${formatAge(now - d.seenAt)} ago (${formatAt(d.seenAt)})`
        : d.via === 'restore' ? `restored ${formatAge(now - d.seenAt)} ago (${formatAt(d.seenAt)})`
        : `armed ${formatAge(now - d.seenAt)} ago, never fired`;
  // the silence may have a cause the mod could not journal (mod-fault.json): said with it
  const fault = modFaultText(readModFault(gateDir), now);
  return `Loop silent for ${formatAge(d.silentMs)} - ${proj}: phase ${d.state.phase}${c.total ? `, ${c.done}/${c.total} steps` : ''}; ${last}.${fault ? ` Note: ${fault}.` : ''}`;
}

// Kill the driving Claude Code process (if it is still that process) and reopen the session.
// -> { attempted, killed, launched, how, why }
//   io (tests): fs, processInfo, killTree, launchRestore, alive (of a sentinel's watchdog)
export function restore(gateDir, d, env = process.env, io = {}) {
  const s = d.state;
  const now = Date.now();
  // the state stands only in its pending copy: the interruption cannot be marked, so no restore
  // (checked first: nothing is written, not even a stale sentinel retired)
  if (d.restorable === false) return { attempted: false, why: 'state.json stands only in its pending copy: the interruption cannot be marked, no restore' };
  if (!s.owner.sessionId) return { attempted: false, why: 'no session to restore' };
  const pid = s.owner.claudePid;
  // "never recorded" is not "known dead": a relaunch beside a still-running session would
  // put two processes on the same session id
  if (!(pid > 0)) return { attempted: false, why: 'no Claude Code process recorded at the last Stop: refusing a blind relaunch' };
  // A restored session records its process at its first Stop. Before that, the pid on record
  // is the one the previous restore terminated: found dead it would read as "already gone",
  // and a second `claude -r` would open beside a restored session that may well be alive
  // (waiting on a trust or permission prompt, typically). The sentinel says so first; a stale or
  // abandoned one is retired here (see above), never left to block for ever.
  const sen = readSentinel(gateDir, s, { fs: io.fs });
  const v = sentinelVerdict(sen, s, { now, abandonMs: restoreTimes(env).abandonMs, isAlive: io.alive || alive });
  if (v.block) return { attempted: false, why: v.block };
  let interAt = s.signals.interrupted ? (Date.parse(s.signals.interrupted.at || '') || 0) : 0;
  if (v.retire) {
    const gone = retireSentinel(gateDir, sen);
    appendJournal(gateDir, { type: 'watchdog', action: v.abandoned ? 'restore-abandoned' : 'sentinel-retired', why: v.retire, removed: gone });
    if (!gone) return { attempted: false, why: `the restore sentinel (${v.retire}) could not be moved away: no restore` };
    // the interruption the abandoned attempt marked goes with it: no restored session followed
    if (v.abandoned && sen.kind === 'record' && interAt === sen.at) { clearInterrupted(gateDir, s.signals.interrupted.at, { fs: io.fs }); interAt = 0; }
  }
  // the interruption on record, as the round-1 guard: a launch not followed by a Stop yet
  // (one dated in the future beyond the tolerance is a clock set back, not a launch)
  if (interAt > s.owner.lastFireAt && interAt <= now + SENTINEL_FUTURE_MS) return { attempted: false, why: 'the restored session has not reached a Stop yet, so its Claude Code process is unknown: refusing a blind relaunch' };
  // the whole journal, not its tail: an overnight run is exactly when the cap matters; an
  // abandoned attempt counts as one
  const restores = readJournal(gateDir).filter((j) => j.type === 'watchdog' && SENTINEL_STALE_ACTIONS.includes(j.action)).length;
  if (restores >= MAX_RESTORES) return { attempted: false, why: `restore limit (${MAX_RESTORES}) reached for this run` };
  const info = (io.processInfo || processInfo)(pid);
  if (info.alive && !sameProcess(info, s.owner.claudeStartedAt)) return { attempted: false, why: `pid ${pid} is not the recorded Claude Code process any more` };
  // Claimed BEFORE anything is marked, terminated or launched: the exclusive creation of the
  // sentinel. Then the interruption in the state (the restored session reconciles first,
  // read-only). Either failing: no restore. Stamped before the launch: the restored session's
  // first Stop, however quick, comes after.
  const launchedAt = new Date(now).toISOString();
  const rec = { at: launchedAt, session: s.owner.sessionId, by: process.pid, nonce: randomBytes(6).toString('hex'), phase: 'claimed' };
  const claim = claimSentinel(gateDir, rec, { fs: io.fs });
  if (!claim.ok) return { attempted: false, why: claim.exists ? 'another watchdog has just claimed this restore (the restore sentinel is there): not a second one' : `the restore sentinel could not be written (${claim.error}): no restore` };
  const mineGone = () => retireSentinel(gateDir, { kind: 'record', text: claim.text });
  const mark = markInterrupted(gateDir, { at: launchedAt, silentMs: d.silentMs, pending: d.activity ? d.activity.pending.map((p) => p.agent) : [] }, { fs: io.fs });
  if (!mark || !mark.ok || mark.unchanged) { mineGone(); return { attempted: false, why: `the interruption could not be marked in state.json (${mark ? mark.error : 'no result'}): no restore without it` }; }
  const undo = () => { clearInterrupted(gateDir, launchedAt, { fs: io.fs }); mineGone(); };
  let killed = false;
  if (info.alive) {
    killed = (io.killTree || killTree)(pid);
    if (!killed) { undo(); return { attempted: true, killed: false, why: `could not terminate pid ${pid}` }; }
  }
  const packs = loadPromptLayers({ gateDir, env, lang: s.options.lang, root: ROOT });
  const prompt = restorePrompt(s, { silentMs: d.silentMs, LOOP: loopCommand(ROOT), layers: packs.layers, activity: d.activity });
  const r = (io.launchRestore || launchRestore)({ cwd: dirname(gateDir), sessionId: s.owner.sessionId, prompt, env });
  // no session to reconcile: the marks go
  if (!r.ok) undo();
  // launched: the sentinel says so, and from now on only the restored session's Stop retires it
  else writeDurable(join(gateDir, RESTORE_SENTINEL), JSON.stringify({ ...rec, phase: 'launched' }), { fs: io.fs });
  return { attempted: true, killed, wasAlive: info.alive, launched: r.ok, how: r.how, why: r.error || '' };
}

// The exclusive creation of the sentinel. -> { ok, text } | { ok: false, exists, error }
function claimSentinel(gateDir, rec, { fs } = {}) {
  const write = (fs && fs.writeFileSync) || writeFileSync;
  const text = JSON.stringify(rec);
  try { write(join(gateDir, RESTORE_SENTINEL), text, { flag: 'wx' }); return { ok: true, text }; } catch (e) { return { ok: false, exists: !!(e && e.code === 'EEXIST'), error: String((e && (e.code || e.message)) || e) }; }
}

// The interruption the restored session reconciles, written on the state as it is at the
// write (updateState: a Stop of the restored session may save), before the restore launches
// anything. A detached process never promotes a pending copy (decide() does not either): with
// state.json standing only in its pending copy nothing is written, and then no restore starts.
// -> the updateState result
export function markInterrupted(gateDir, { at, silentMs, pending = [] }, { fs } = {}) {
  try {
    return updateState({ gateDir, statePath: join(gateDir, 'state.json') }, (fresh) => {
      fresh.signals.interrupted = { at, silentMs, phase: fresh.phase, pending };
      fresh.flags.reconcileAsked = false;
    }, { promote: false, fs });
  } catch (e) { return { ok: false, error: String(e && e.message) }; }
}

const entry = (d, extra) => ({ type: 'watchdog', silentMs: d.silentMs, seenAt: new Date(d.seenAt).toISOString(), via: d.via, phase: d.state.phase, activity: d.activity ? { event: d.activity.event, tool: d.activity.tool, agent: d.activity.agent, pending: d.activity.pending } : null, ...extra });

// The watch. deps (tests): decide, sleep, fs (handed to decide), maxUnreadable, restoreIo,
// spawnWatchdog (the replacement after a restore).
// -> { code: 0, why } (the reason it stopped watching)
export async function run(gateDir, env = process.env, deps = {}) {
  const decideFn = deps.decide || decide;
  const nap = deps.sleep || sleep;
  const maxUnreadable = deps.maxUnreadable || MAX_UNREADABLE;
  const { staleMs, restoreAfterMs } = restoreTimes(env);
  const restoreOn = boolEnv(env.PERSEVERANZA_RESTORE);
  const startedAt = Date.now();
  let alerted = false;
  let unreadable = 0;
  for (;;) {
    const d = decideFn(gateDir, { staleMs, startedAt, fs: deps.fs });
    // state.json not readable now: tried again later, a bounded number of times in a row
    if (d.action === 'retry') {
      unreadable += 1;
      if (unreadable >= maxUnreadable) {
        const why = `${d.why}, ${unreadable} times in a row: the watchdog stops watching (the next Stop starts a new one)`;
        try { appendJournal(gateDir, { type: 'watchdog', action: 'exit', why }); } catch { /* the journal may be held too */ }
        return { code: 0, why };
      }
      await nap(d.ms);
      continue;
    }
    unreadable = 0;
    if (d.action === 'sleep') { alerted = false; await nap(d.ms); continue; }
    if (d.action === 'exit') return { code: 0, why: d.why };
    if (!alerted) {
      // stage one: speak. The human may be the reason for the silence.
      alerted = true;
      const noRestore = restoreOn && d.restorable === false;
      const text = `${alertText(d, gateDir)}${noRestore ? ' No restore: state.json stands only in its pending copy (a write cut short), and a restore needs a whole state to mark the interruption in. Check the session: status, resume --takeover, or disarm.' : restoreOn ? ` The session will be terminated and restored in ${formatAge(Math.max(0, d.seenAt + restoreAfterMs - Date.now()))} unless it shows life.` : ' Check the session: status, resume --takeover, or disarm.'}`;
      const notified = notify(TITLE, text, { env });
      appendJournal(gateDir, entry(d, { action: 'alerted', restore: null, notified, text }));
      if (!restoreOn) return { code: 0, why: 'alerted' };
    }
    // a state read from its pending copy only is watched, never restored: once a Stop or a verb
    // writes it whole again the watch goes on as usual (alerted once, not at every look)
    if (d.restorable === false) { await nap(UNREADABLE_RETRY_MS); continue; }
    const due = d.seenAt + restoreAfterMs - Date.now();
    if (due > 0) { await nap(Math.min(due + 500, MAX_NAP_MS)); continue; }
    // stage two: the silence outlived the second threshold. Kill and restore.
    const r = restore(gateDir, d, env, deps.restoreIo || {});
    // the restored session is watched from its first breath, not from its first Stop
    if (r.launched) r.watchdog = (deps.spawnWatchdog || spawnWatchdog)(gateDir, env, { replace: true });
    const text = r.launched
      ? `${alertText(d, gateDir)} ${r.wasAlive ? 'Terminated the hung session' : 'Its process was already gone'}; reopened it (${r.how}): the loop continues.`
      : `${alertText(d, gateDir)} Restore ${r.attempted ? 'FAILED' : 'skipped'}: ${r.why}. Check the session: status, resume --takeover, or disarm.`;
    const notified = notify(TITLE, text, { env });
    appendJournal(gateDir, entry(d, { action: r.launched ? 'restored' : 'alerted', restore: r, notified, text }));
    return { code: 0, why: r.launched ? 'restored' : 'restore not done' };
  }
}

function isMainModule() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] || '.')).href; }
  catch { return false; }
}

if (isMainModule()) {
  const gateDir = process.argv[2];
  if (!gateDir) process.exit(2);
  run(gateDir).then((r) => process.exit(r.code)).catch(() => process.exit(0));
}
