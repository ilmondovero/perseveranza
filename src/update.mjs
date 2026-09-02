#!/usr/bin/env node
// Update notice: compares the installed version with the latest on GitHub, cached daily
// in ~/.perseveranza/update-check.json. The network check runs in a DETACHED process so
// it never slows down the hook or the statusline.
import { readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { home } from './shell/paths.mjs';

const RAW_URL = 'https://raw.githubusercontent.com/ilmondovero/perseveranza/main/.claude-plugin/plugin.json';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 60 * 1000;

const cachePath = (env) => join(home(env), 'update-check.json');
const lockPath = (env) => join(home(env), 'update-check.lock');

export function currentVersion(root) {
  try { return JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version || null; }
  catch { return null; }
}
function readCache(env) { try { return JSON.parse(readFileSync(cachePath(env), 'utf8')); } catch { return null; } }

export function cmpSemver(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

export function updateAvailable(root, env = process.env) {
  const cur = currentVersion(root);
  if (!cur) return null;
  const c = readCache(env);
  if (!c || !c.latest) return null;
  return cmpSemver(c.latest, cur) > 0 ? c.latest : null;
}

// If the cache is missing/old, mark it now (throttle) and spawn a detached refresh.
// A `wx` lock keeps the hook and the statusline from spawning two refreshes.
export function maybeSpawnRefresh(env = process.env) {
  if (env.OMC_NO_UPDATE_CHECK) return;
  const c = readCache(env);
  if (c && c.checkedAt && Date.parse(c.checkedAt) > Date.now() - MAX_AGE_MS) return;
  const LOCK = lockPath(env);
  try {
    mkdirSync(dirname(LOCK), { recursive: true });
    try { writeFileSync(LOCK, String(Date.now()), { flag: 'wx' }); }
    catch {
      let ts = 0;
      try { ts = Number(readFileSync(LOCK, 'utf8')) || 0; } catch { /* unreadable */ }
      if (Date.now() - ts < LOCK_STALE_MS) return;
      try { writeFileSync(LOCK, String(Date.now())); } catch { /* best-effort */ }
    }
  } catch { /* read-only FS: proceed, best-effort */ }
  try {
    writeFileSync(cachePath(env), JSON.stringify({ checkedAt: new Date().toISOString(), latest: (c && c.latest) || null }, null, 2));
  } catch { /* best-effort */ }
  try {
    spawn(process.execPath, [fileURLToPath(import.meta.url), '--refresh'], { detached: true, stdio: 'ignore', env }).unref();
  } catch { /* best-effort */ }
}

async function refresh(env = process.env) {
  let latest = null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(RAW_URL, { signal: ctrl.signal });
    if (res.ok) latest = (await res.json()).version || null;
  } catch { /* offline: keep the previous cache */ }
  finally { clearTimeout(t); }
  try {
    mkdirSync(dirname(cachePath(env)), { recursive: true });
    const prev = readCache(env) || {};
    writeFileSync(cachePath(env), JSON.stringify({ checkedAt: new Date().toISOString(), latest: latest || prev.latest || null }, null, 2));
  } catch { /* ignore */ }
  try { rmSync(lockPath(env), { force: true }); } catch { /* already gone */ }
}

function isMainModule() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] || '.')).href; }
  catch { return false; }
}
if (isMainModule() && process.argv.includes('--refresh')) refresh();
