#!/usr/bin/env node
// Statusline di perseveranza. Mostra il progresso del loop SOLO quando armato nella cwd,
// e si COMPONE con la statusline "base" preesistente (es. OMC HUD) senza sostituirla:
// la base viene catturata da `omc-loop.mjs hud on` e richiamata qui con lo stesso stdin.
// Dormiente fuori da un progetto armato: stampa solo l'output della base.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from './providers.mjs';
import { renderProgress } from './hud.mjs';

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
  const r = spawnSync(base, { shell: true, input: raw, encoding: 'utf8', timeout: 8000 });
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
    seg = renderProgress(s, planText, { color: true, marker: true });
  } catch { /* stato illeggibile: niente segmento */ }
}

const out = seg && baseOut ? `${seg} │ ${baseOut}` : (seg || baseOut);
process.stdout.write(out);
