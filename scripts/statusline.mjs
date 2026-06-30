#!/usr/bin/env node
// Statusline di perseveranza. Mostra il progresso del loop SOLO quando armato nella cwd,
// e si COMPONE con la statusline "base" preesistente (es. OMC HUD) senza sostituirla:
// la base viene catturata da `omc-loop.mjs hud on` e richiamata qui con lo stesso stdin.
// Dormiente fuori da un progetto armato: stampa solo l'output della base.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadConfig } from './providers.mjs';
import { renderProgress } from './hud.mjs';
import { maybeSpawnRefresh, updateAvailable, currentVersion } from './update.mjs';
import { parseTimeoutMs } from './util.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// Claude Code passa su stdin il JSON di sessione (contiene la cwd)
let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { /* nessuno stdin */ }
let sess = {};
try { sess = raw ? JSON.parse(raw) : {}; } catch { /* malformato */ }
const cwd = sess.cwd || sess.workspace?.current_dir || sess.workspace?.cwd || process.cwd();

// statusline base (es. OMC HUD), salvata da `hud on`: la eseguiamo con lo stesso stdin
const base = loadConfig().statusline?.base || '';
let baseOut = '';
if (base) {
  // timeout configurabile (default 5s; su repo grandi tienilo >= 5s perche' `git status` della
  // base puo' durare 2-3s). VALIDATO: un valore non-intero/negativo passato a spawnSync({timeout})
  // lancerebbe ERR_OUT_OF_RANGE -> qui si ricade sul default (floor 1s). killSignal SIGKILL per non
  // lasciare un processo base appeso. Il try/catch e' coerente col resto del file: una base che
  // esplode non deve MAI azzerare l'intera statusline (base + segmento perseveranza).
  const baseTimeout = parseTimeoutMs(process.env.OMC_STATUSLINE_BASE_TIMEOUT_MS, 5000);
  let r = {};
  try { r = spawnSync(base, { shell: true, input: raw, encoding: 'utf8', timeout: baseTimeout, killSignal: 'SIGKILL' }); }
  catch { /* base illeggibile/timeout-config rotto: si tiene baseOut vuoto, niente crash */ }
  baseOut = (r.stdout || '').replace(/\r?\n+$/, '');
}

// segmento perseveranza: solo se c'e' un loop armato in questa cwd
let seg = '';
const statePath = join(cwd, '.omc-loop', 'state.json');
if (existsSync(statePath)) {
  try {
    const s = JSON.parse(readFileSync(statePath, 'utf8'));
    const planPath = join(cwd, '.omc-loop', 'plan.md');
    const planText = existsSync(planPath) ? readFileSync(planPath, 'utf8') : '';
    const root = join(SCRIPT_DIR, '..');
    seg = renderProgress(s, planText, { color: true, marker: true, version: currentVersion(root) });
    // notifica aggiornamenti: marker compatto se c'e' una versione piu' nuova
    maybeSpawnRefresh(SCRIPT_DIR);
    const upd = updateAvailable(root);
    if (upd) seg += ` \x1b[1;33m⬆v${upd}\x1b[0m`;
  } catch { /* stato illeggibile: niente segmento */ }
}

const out = seg && baseOut ? `${seg} │ ${baseOut}` : (seg || baseOut);
process.stdout.write(out);
