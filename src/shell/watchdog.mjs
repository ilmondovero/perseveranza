#!/usr/bin/env node
// The watchdog: a detached process that outlives the hook and speaks when the loop goes
// silent. The Stop hook and `arm` spawn one at every fire; it sleeps until the last sign
// of life (Stop or tool activity) is older than the stale threshold, re-sleeps as long as
// the loop keeps showing life, and, when the silence is real, journals a `watchdog` entry
// and sends the desktop notification. Every fire spawns a fresh one and records its pid in
// .omc-loop/watchdog.json: an older watchdog finds another pid there and exits, so at most
// one speaks. It exits on disarm (no state.json), on pause (a human is expected) and after
// a maximum lifetime. Disabled with OMC_LOOP_NO_WATCHDOG=1 (tests).
//
// With OMC_LOOP_RESTORE=1 it does not only speak: after the alert it waits a second
// threshold (OMC_LOOP_RESTORE_AFTER_MS, default twice the stale threshold), and if the
// silence is still unbroken it terminates the Claude Code process that drove the loop
// (recorded by the Stop hook) and reopens the same session with a restore prompt, so a
// hung turn costs an hour, not a night. Two stages because a session waiting on a human
// (a permission prompt, a question) writes nothing either: the alert is the human's chance.
// At most MAX_RESTORES per run: a session that dies at every restore is a problem the
// human sees. Never a blind relaunch: no recorded process, no restore.
//
//   node watchdog.mjs <gateDir>          (spawned detached; run by hand to watch a loop)
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadState } from '../core/state.mjs';
import { staleness, describeActivity, restorePrompt, DEFAULT_STALE_MS, formatAge, formatAt } from '../core/staleness.mjs';
import { stepCounts } from '../core/plan.mjs';
import { writeAtomic } from './activity.mjs';
import { readLife } from './life.mjs';
import { appendJournal, readJournal } from './journal.mjs';
import { loadPromptLayers } from './packs.mjs';
import { ROOT, loopCommand } from './paths.mjs';
import { processInfo, sameProcess, killTree, launchRestore } from './restore.mjs';
import { notify } from './notify.mjs';
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
  if (boolEnv(env.OMC_LOOP_NO_WATCHDOG)) return 0;
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

// One pass: -> { action: 'exit'|'sleep'|'alert', ms?, why }
export function decide(gateDir, { now = Date.now(), staleMs = DEFAULT_STALE_MS, pid = process.pid, startedAt = now } = {}) {
  if (now - startedAt > MAX_LIFE_MS) return { action: 'exit', why: 'max lifetime' };
  const statePath = join(gateDir, 'state.json');
  if (!existsSync(statePath)) return { action: 'exit', why: 'disarmed' };
  let state = null;
  try { state = loadState(JSON.parse(readFileSync(statePath, 'utf8'))).state; } catch { /* unreadable */ }
  if (!state) return { action: 'exit', why: 'unreadable state' };
  const owner = currentPid(gateDir);
  if (owner && owner !== pid) return { action: 'exit', why: 'newer watchdog' };
  if (state.signals.paused) return { action: 'exit', why: 'paused' };
  const { activity, transcriptAt } = readLife(gateDir, state);
  const st = staleness(state, now, staleMs, activity, transcriptAt);
  const armed = Date.parse(state.armedAt || '') || 0;
  const seen = st.seenAt || armed;
  if (!seen) return { action: 'exit', why: 'no clock' };
  const wait = seen + staleMs - now;
  if (wait > 0) return { action: 'sleep', ms: Math.min(wait + 500, MAX_NAP_MS), why: 'alive' };
  // only the owner's activity is the loop's (lastSeen already filtered it)
  return { action: 'alert', state, activity: st.via === 'activity' ? activity : null, silentMs: now - seen, seenAt: seen, via: st.seenAt ? st.via : 'arm' };
}

export function alertText(d, gateDir, now = Date.now()) {
  const proj = basename(dirname(gateDir));
  let planText = '';
  try { planText = readFileSync(join(gateDir, 'plan.md'), 'utf8'); } catch { /* no plan */ }
  const c = stepCounts(planText);
  const last = d.via === 'activity' ? `last activity ${describeActivity(d.activity, now)}`
    : d.via === 'transcript' ? `last output ${formatAge(now - d.seenAt)} ago (${formatAt(d.seenAt)})`
      : d.via === 'fire' ? `last Stop ${formatAge(now - d.seenAt)} ago (${formatAt(d.seenAt)})`
        : `armed ${formatAge(now - d.seenAt)} ago, never fired`;
  return `Loop silent for ${formatAge(d.silentMs)} - ${proj}: phase ${d.state.phase}${c.total ? `, ${c.done}/${c.total} steps` : ''}; ${last}.`;
}

// Kill the driving Claude Code process (if it is still that process) and reopen the session.
// -> { attempted, killed, launched, how, why }
export function restore(gateDir, d, env = process.env) {
  const s = d.state;
  // the whole journal, not its tail: an overnight run is exactly when the cap matters
  const restores = readJournal(gateDir).filter((j) => j.type === 'watchdog' && j.action === 'restored').length;
  if (restores >= MAX_RESTORES) return { attempted: false, why: `restore limit (${MAX_RESTORES}) reached for this run` };
  if (!s.owner.sessionId) return { attempted: false, why: 'no session to restore' };
  const pid = s.owner.claudePid;
  // "never recorded" is not "known dead": a relaunch beside a still-running session would
  // put two processes on the same session id
  if (!(pid > 0)) return { attempted: false, why: 'no Claude Code process recorded at the last Stop: refusing a blind relaunch' };
  const info = processInfo(pid);
  let killed = false;
  if (info.alive) {
    if (!sameProcess(info, s.owner.claudeStartedAt)) return { attempted: false, why: `pid ${pid} is not the recorded Claude Code process any more` };
    killed = killTree(pid);
    if (!killed) return { attempted: true, killed: false, why: `could not terminate pid ${pid}` };
  }
  const packs = loadPromptLayers({ gateDir, env, lang: s.options.lang, root: ROOT });
  const prompt = restorePrompt(s, { silentMs: d.silentMs, LOOP: loopCommand(ROOT), layers: packs.layers, activity: d.activity });
  const r = launchRestore({ cwd: dirname(gateDir), sessionId: s.owner.sessionId, prompt, env });
  // the next Stop of the restored session reconciles first, read-only: mark the interruption,
  // but only once a session exists to do it (a marked loop with nobody to reconcile would
  // refuse every edit to the next human who opens the project)
  if (r.ok) {
    try {
      const fresh = loadState(JSON.parse(readFileSync(join(gateDir, 'state.json'), 'utf8'))).state;
      if (fresh) {
        fresh.signals.interrupted = { at: new Date().toISOString(), silentMs: d.silentMs, phase: fresh.phase, pending: d.activity ? d.activity.pending.map((p) => p.agent) : [] };
        fresh.flags.reconcileAsked = false;
        writeAtomic(join(gateDir, 'state.json'), JSON.stringify(fresh, null, 2));
      }
    } catch { /* the restore prompt still asks for the reconciliation */ }
  }
  return { attempted: true, killed, wasAlive: info.alive, launched: r.ok, how: r.how, why: r.error || '' };
}

const entry = (d, extra) => ({ type: 'watchdog', silentMs: d.silentMs, seenAt: new Date(d.seenAt).toISOString(), via: d.via, phase: d.state.phase, activity: d.activity ? { event: d.activity.event, tool: d.activity.tool, agent: d.activity.agent, pending: d.activity.pending } : null, ...extra });

async function run(gateDir, env = process.env) {
  const staleMs = parseTimeoutMs(env.OMC_LOOP_STALE_MS, DEFAULT_STALE_MS);
  const restoreOn = boolEnv(env.OMC_LOOP_RESTORE);
  const restoreAfterMs = Math.max(staleMs, parseTimeoutMs(env.OMC_LOOP_RESTORE_AFTER_MS, 2 * staleMs));
  const startedAt = Date.now();
  let alerted = false;
  for (;;) {
    const d = decide(gateDir, { staleMs, startedAt });
    if (d.action === 'sleep') { alerted = false; await sleep(d.ms); continue; }
    if (d.action === 'exit') return 0;
    if (!alerted) {
      // stage one: speak. The human may be the reason for the silence.
      alerted = true;
      const text = `${alertText(d, gateDir)}${restoreOn ? ` The session will be terminated and restored in ${formatAge(Math.max(0, d.seenAt + restoreAfterMs - Date.now()))} unless it shows life.` : ' Check the session: status, resume --takeover, or disarm.'}`;
      const notified = notify(TITLE, text, { env });
      appendJournal(gateDir, entry(d, { action: 'alerted', restore: null, notified, text }));
      if (!restoreOn) return 0;
    }
    const due = d.seenAt + restoreAfterMs - Date.now();
    if (due > 0) { await sleep(Math.min(due + 500, MAX_NAP_MS)); continue; }
    // stage two: the silence outlived the second threshold. Kill and restore.
    const r = restore(gateDir, d, env);
    // the restored session is watched from its first breath, not from its first Stop
    if (r.launched) r.watchdog = spawnWatchdog(gateDir, env, { replace: true });
    const text = r.launched
      ? `${alertText(d, gateDir)} ${r.wasAlive ? 'Terminated the hung session' : 'Its process was already gone'}; reopened it (${r.how}): the loop continues.`
      : `${alertText(d, gateDir)} Restore ${r.attempted ? 'FAILED' : 'skipped'}: ${r.why}. Check the session: status, resume --takeover, or disarm.`;
    const notified = notify(TITLE, text, { env });
    appendJournal(gateDir, entry(d, { action: r.launched ? 'restored' : 'alerted', restore: r, notified, text }));
    return 0;
  }
}

function isMainModule() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] || '.')).href; }
  catch { return false; }
}

if (isMainModule()) {
  const gateDir = process.argv[2];
  if (!gateDir) process.exit(2);
  run(gateDir).then((c) => process.exit(c)).catch(() => process.exit(0));
}
