#!/usr/bin/env node
// Notifica aggiornamenti di perseveranza (stile OMC): confronta la versione installata con
// l'ultima su GitHub, con cache giornaliera in ~/.perseveranza/update-check.json.
// Il controllo di rete gira in un processo DISTACCATO, cosi' non rallenta hook/statusline.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';

const CACHE = join(homedir(), '.perseveranza', 'update-check.json');
const RAW_URL = 'https://raw.githubusercontent.com/ilmondovero/perseveranza/main/.claude-plugin/plugin.json';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// versione installata: plugin.json sta in <root>/.claude-plugin/ (root = genitore di scripts/)
export function currentVersion(root) {
  try { return JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version || null; }
  catch { return null; }
}
function readCache() { try { return JSON.parse(readFileSync(CACHE, 'utf8')); } catch { return null; } }
function cmpSemver(a, b) { // >0 se a > b
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

// versione piu' recente disponibile (se > installata), altrimenti null
export function updateAvailable(root) {
  const cur = currentVersion(root);
  if (!cur) return null; // installazione senza plugin.json (es. manuale): niente notifica
  const c = readCache();
  if (!c || !c.latest) return null;
  return cmpSemver(c.latest, cur) > 0 ? c.latest : null;
}

// se la cache e' assente/vecchia, segna subito (throttle) e lancia un refresh distaccato
export function maybeSpawnRefresh(scriptDir) {
  const c = readCache();
  if (c && c.checkedAt && Date.parse(c.checkedAt) > Date.now() - MAX_AGE_MS) return;
  try {
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify({ checkedAt: new Date().toISOString(), latest: (c && c.latest) || null }, null, 2));
  } catch { /* best-effort */ }
  try { spawn(process.execPath, [join(scriptDir, 'update.mjs'), '--refresh'], { detached: true, stdio: 'ignore' }).unref(); }
  catch { /* best-effort */ }
}

async function refresh() {
  let latest = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(RAW_URL, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) latest = (await res.json()).version || null;
  } catch { /* offline: si tiene la cache precedente */ }
  try {
    mkdirSync(dirname(CACHE), { recursive: true });
    const prev = readCache() || {};
    writeFileSync(CACHE, JSON.stringify({ checkedAt: new Date().toISOString(), latest: latest || prev.latest || null }, null, 2));
  } catch { /* ignora */ }
}

if (process.argv.includes('--refresh')) refresh();
