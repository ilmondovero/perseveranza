#!/usr/bin/env node
// Notifica aggiornamenti di perseveranza (stile OMC): confronta la versione installata con
// l'ultima su GitHub, con cache giornaliera in ~/.perseveranza/update-check.json.
// Il controllo di rete gira in un processo DISTACCATO, cosi' non rallenta hook/statusline.
import { readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const CACHE = join(homedir(), '.perseveranza', 'update-check.json');
const LOCK = join(homedir(), '.perseveranza', 'update-check.lock');
const LOCK_STALE_MS = 60 * 1000; // un lock piu' vecchio di 60s e' orfano (processo refresh morto/crashato)
const RAW_URL = 'https://raw.githubusercontent.com/ilmondovero/perseveranza/main/.claude-plugin/plugin.json';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// versione installata: plugin.json sta in <root>/.claude-plugin/ (root = genitore di scripts/)
export function currentVersion(root) {
  try { return JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version || null; }
  catch { return null; }
}
function readCache() { try { return JSON.parse(readFileSync(CACHE, 'utf8')); } catch { return null; } }
export function cmpSemver(a, b) { // >0 se a > b
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
  // lock atomico: hook e statusline (o due render ravvicinati) possono chiamare questa funzione
  // quasi insieme; senza lock spawnerebbero DUE refresh. `writeFileSync` con flag 'wx' fallisce se il
  // lock esiste gia' -> il secondo processo salta. Stale-logic: un lock piu' vecchio di LOCK_STALE_MS
  // e' orfano (refresh crashato) e viene ripreso. Il figlio --refresh rilascia il lock alla fine.
  try {
    mkdirSync(dirname(LOCK), { recursive: true });
    try {
      writeFileSync(LOCK, String(Date.now()), { flag: 'wx' });
    } catch {
      let ts = 0;
      try { ts = Number(readFileSync(LOCK, 'utf8')) || 0; } catch { /* lock illeggibile */ }
      if (Date.now() - ts < LOCK_STALE_MS) return; // un altro refresh e' in corso: salta
      try { writeFileSync(LOCK, String(Date.now())); } catch { /* best-effort */ } // riprendi l'orfano
    }
  } catch { /* se il lock fallisce del tutto (FS read-only): si procede comunque, e' best-effort */ }
  try {
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify({ checkedAt: new Date().toISOString(), latest: (c && c.latest) || null }, null, 2));
  } catch { /* best-effort */ }
  try { spawn(process.execPath, [join(scriptDir, 'update.mjs'), '--refresh'], { detached: true, stdio: 'ignore' }).unref(); }
  catch { /* best-effort */ }
}

async function refresh() {
  let latest = null;
  const ctrl = new AbortController();
  // l'abort da 5s copre l'INTERA richiesta: sia il fetch sia la lettura del body (res.json()),
  // che con un server lento puo' restare appesa. clearTimeout nel finally, a body letto.
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(RAW_URL, { signal: ctrl.signal });
    if (res.ok) latest = (await res.json()).version || null;
  } catch { /* offline: si tiene la cache precedente */ }
  finally { clearTimeout(t); }
  try {
    mkdirSync(dirname(CACHE), { recursive: true });
    const prev = readCache() || {};
    writeFileSync(CACHE, JSON.stringify({ checkedAt: new Date().toISOString(), latest: latest || prev.latest || null }, null, 2));
  } catch { /* ignora */ }
  try { rmSync(LOCK, { force: true }); } catch { /* gia' rimosso */ } // rilascia il lock anti-race
}

// esegui il refresh SOLO se update.mjs e' lanciato direttamente (`node update.mjs --refresh`), non
// quando e' importato (loop-drive/statusline/test): cosi' un '--refresh' di passaggio nell'argv di
// un altro entrypoint non innesca una fetch di rete al load del modulo. (suggerimento review step 6)
// realpathSync rende il confronto robusto ai symlink (argv[1] puo' essere un link, mentre
// import.meta.url e' gia' risolto da node); in try/catch perche' argv[1] puo' mancare o non
// essere leggibile -> in tal caso non e' il modulo principale.
function isMainModule() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] || '.')).href; }
  catch { return false; }
}
if (isMainModule() && process.argv.includes('--refresh')) refresh();
