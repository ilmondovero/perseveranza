#!/usr/bin/env node
// Installazione MANUALE di "perseveranza" (alternativa al plugin, stessa logica).
// Preferire il plugin:  /plugin marketplace add ilmondovero/perseveranza
//                       /plugin install perseveranza@perseveranza
// NON usare entrambe le modalita' insieme: due Stop hook guiderebbero lo stesso loop.
//
//   1. copia gli script e il comando in ~/.claude/
//   2. registra lo Stop hook in ~/.claude/settings.json (idempotente, con backup)
//      sostituendo eventuali voci di versioni precedenti (anche .ps1)
// Uso:  node install.mjs [--claude-dir <dir>]
//       node install.mjs --uninstall     rimuove file e voce hook
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const src = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
let claudeDir = join(homedir(), '.claude');
const dirFlag = argv.indexOf('--claude-dir');
if (dirFlag !== -1 && argv[dirFlag + 1]) claudeDir = argv[dirFlag + 1];
const uninstall = argv.includes('--uninstall');

const hooksDir = join(claudeDir, 'hooks');
const commandsDir = join(claudeDir, 'commands');
const agentsDir = join(claudeDir, 'agents');
const settingsPath = join(claudeDir, 'settings.json');
const loopPath = join(hooksDir, 'omc-loop.mjs');
const drivePath = join(hooksDir, 'loop-drive.mjs');
const AGENTS = ['pf-reviewer.md', 'pf-verifier.md', 'pf-executor.md'];

function loadSettings() {
  if (!existsSync(settingsPath)) return {};
  try { return JSON.parse(readFileSync(settingsPath, 'utf8')) ?? {}; }
  catch (e) { console.error(`ERRORE: ${settingsPath} non e' JSON valido (${e.message}): correggilo e rilancia.`); process.exit(1); }
}
// toglie ogni voce Stop che punta a loop-drive (.ps1 o .mjs, path vecchi inclusi)
function stripLoopEntries(settings) {
  settings.hooks ??= {};
  settings.hooks.Stop ??= [];
  settings.hooks.Stop = settings.hooks.Stop
    .map((entry) => ({
      ...entry,
      hooks: (entry.hooks ?? []).filter((h) => !/loop-drive\.(ps1|mjs)/.test(h.command ?? '')),
    }))
    .filter((entry) => (entry.hooks ?? []).length > 0);
}
function saveSettings(settings) {
  if (existsSync(settingsPath)) {
    copyFileSync(settingsPath, `${settingsPath}.bak-perseveranza`);
    console.log(`Backup di settings.json: ${settingsPath}.bak-perseveranza`);
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

if (uninstall) {
  const toRemove = [loopPath, drivePath, join(hooksDir, 'omc-loop.ps1'), join(hooksDir, 'loop-drive.ps1'), join(commandsDir, 'perseveranza.md')];
  toRemove.push(...AGENTS.map((a) => join(agentsDir, a)));
  for (const p of toRemove) {
    if (existsSync(p)) { rmSync(p); console.log(`Rimosso: ${p}`); }
  }
  const settings = loadSettings();
  const before = JSON.stringify(settings.hooks?.Stop ?? []);
  stripLoopEntries(settings);
  if (JSON.stringify(settings.hooks.Stop) !== before) {
    saveSettings(settings);
    console.log('Voce Stop hook rimossa da settings.json.');
  }
  console.log('Disinstallazione completata. Riavvia Claude Code.');
  process.exit(0);
}

// --- 1. copia dei file ---
mkdirSync(hooksDir, { recursive: true });
mkdirSync(commandsDir, { recursive: true });
copyFileSync(join(src, 'scripts', 'omc-loop.mjs'), loopPath);
copyFileSync(join(src, 'scripts', 'loop-drive.mjs'), drivePath);
// il comando del plugin usa ${CLAUDE_PLUGIN_ROOT}: nell'installazione manuale
// va riscritto col path assoluto degli script copiati
const cmd = readFileSync(join(src, 'commands', 'perseveranza.md'), 'utf8')
  .replaceAll('${CLAUDE_PLUGIN_ROOT}/scripts/omc-loop.mjs', loopPath.replaceAll('\\', '/'));
writeFileSync(join(commandsDir, 'perseveranza.md'), cmd);
// agenti propri del ciclo (pf-reviewer/verifier/executor): nell'installazione manuale
// vivono in ~/.claude/agents/ e si invocano col nome semplice (senza namespace plugin)
mkdirSync(agentsDir, { recursive: true });
for (const a of AGENTS) copyFileSync(join(src, 'agents', a), join(agentsDir, a));
console.log(`File copiati in ${claudeDir} (hooks/, commands/, agents/).`);

// rimuovi le versioni PowerShell superate, se presenti (erano la vecchia distribuzione)
for (const old of ['omc-loop.ps1', 'loop-drive.ps1']) {
  const p = join(hooksDir, old);
  if (existsSync(p)) { rmSync(p); console.log(`Rimossa versione superata: hooks/${old}`); }
}

// --- 2. registrazione dello Stop hook ---
const settings = loadSettings();
const before = JSON.stringify(settings.hooks?.Stop ?? []);
stripLoopEntries(settings);
settings.hooks.Stop.push({
  matcher: '',
  hooks: [{ type: 'command', command: `node "${drivePath}"`, timeout: 20 }],
});

if (JSON.stringify(settings.hooks.Stop) === before) {
  console.log("Stop hook gia' registrato in settings.json: nessuna modifica.");
} else {
  saveSettings(settings);
  console.log('Stop hook registrato in settings.json.');
}

console.log('');
console.log('Installazione completata. Riavvia Claude Code e usa: /perseveranza <descrizione del task>');
console.log('ATTENZIONE: se hai installato anche il plugin perseveranza, disinstallane uno dei due.');
