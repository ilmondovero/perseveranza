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
//   node watchdog.mjs <gateDir>          (spawned detached; run by hand to watch a loop)
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadState } from '../core/state.mjs';
import { staleness, describeActivity, DEFAULT_STALE_MS, formatAge, formatAt } from '../core/staleness.mjs';
import { stepCounts } from '../core/plan.mjs';
import { readActivity, writeAtomic } from './activity.mjs';
import { appendJournal } from './journal.mjs';
import { notify } from './notify.mjs';
import { parseTimeoutMs, boolEnv } from './util.mjs';

export const WATCHDOG_FILE = 'watchdog.json';
const TITLE = 'Claude Code - perseveranza';
const MAX_LIFE_MS = 48 * 60 * 60 * 1000;
const MAX_NAP_MS = 60 * 60 * 1000; // a clock jump must not strand it asleep for hours
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
export function spawnWatchdog(gateDir, env = process.env) {
  if (boolEnv(env.OMC_LOOP_NO_WATCHDOG)) return 0;
  const incumbent = currentPid(gateDir);
  if (alive(incumbent)) return incumbent;
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
  const activity = readActivity(gateDir);
  const st = staleness(state, now, staleMs, activity);
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
    : d.via === 'fire' ? `last Stop ${formatAge(now - d.seenAt)} ago (${formatAt(d.seenAt)})`
      : `armed ${formatAge(now - d.seenAt)} ago, never fired`;
  return `Loop silent for ${formatAge(d.silentMs)} - ${proj}: phase ${d.state.phase}${c.total ? `, ${c.done}/${c.total} steps` : ''}; ${last}. Check the session: status, resume --takeover, or disarm.`;
}

async function run(gateDir, env = process.env) {
  const staleMs = parseTimeoutMs(env.OMC_LOOP_STALE_MS, DEFAULT_STALE_MS);
  const startedAt = Date.now();
  for (;;) {
    const d = decide(gateDir, { staleMs, startedAt });
    if (d.action === 'sleep') { await sleep(d.ms); continue; }
    if (d.action === 'exit') return 0;
    const text = alertText(d, gateDir);
    const notified = notify(TITLE, text, { env });
    appendJournal(gateDir, { type: 'watchdog', silentMs: d.silentMs, seenAt: new Date(d.seenAt).toISOString(), via: d.via, phase: d.state.phase, activity: d.activity ? { event: d.activity.event, tool: d.activity.tool, agent: d.activity.agent, pending: d.activity.pending } : null, notified, text });
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
