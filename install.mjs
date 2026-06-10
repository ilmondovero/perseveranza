#!/usr/bin/env node
// Installa "perseveranza" per l'utente corrente (Windows, macOS, Linux):
//   1. copia hook e comando in ~/.claude/
//   2. registra lo Stop hook in ~/.claude/settings.json (idempotente, con backup)
//      sostituendo eventuali voci di versioni precedenti (anche .ps1)
// Uso:  node install.mjs  [--claude-dir <dir>]

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const src = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
let claudeDir = join(homedir(), '.claude');
const dirFlag = argv.indexOf('--claude-dir');
if (dirFlag !== -1 && argv[dirFlag + 1]) claudeDir = argv[dirFlag + 1];

// --- 1. copia dei file ---
const hooksDir = join(claudeDir, 'hooks');
const commandsDir = join(claudeDir, 'commands');
mkdirSync(hooksDir, { recursive: true });
mkdirSync(commandsDir, { recursive: true });
copyFileSync(join(src, 'hooks', 'omc-loop.mjs'), join(hooksDir, 'omc-loop.mjs'));
copyFileSync(join(src, 'hooks', 'loop-drive.mjs'), join(hooksDir, 'loop-drive.mjs'));
copyFileSync(join(src, 'commands', 'perseveranza.md'), join(commandsDir, 'perseveranza.md'));
console.log(`File copiati in ${claudeDir} (hooks/ e commands/).`);

// rimuovi le versioni PowerShell superate, se presenti (erano la vecchia distribuzione)
for (const old of ['omc-loop.ps1', 'loop-drive.ps1']) {
  const p = join(hooksDir, old);
  if (existsSync(p)) { rmSync(p); console.log(`Rimossa versione superata: hooks/${old}`); }
}

// --- 2. registrazione dello Stop hook ---
const settingsPath = join(claudeDir, 'settings.json');
const hookCmd = `node "${join(hooksDir, 'loop-drive.mjs')}"`;

let settings = {};
if (existsSync(settingsPath)) {
  try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')) ?? {}; }
  catch (e) { console.error(`ERRORE: ${settingsPath} non e' JSON valido (${e.message}): correggilo e rilancia.`); process.exit(1); }
}
settings.hooks ??= {};
settings.hooks.Stop ??= [];

// togli ogni voce loop-drive esistente (.ps1 o .mjs, path vecchi inclusi), poi aggiungi quella corrente
const before = JSON.stringify(settings.hooks.Stop);
settings.hooks.Stop = settings.hooks.Stop
  .map((entry) => ({
    ...entry,
    hooks: (entry.hooks ?? []).filter((h) => !/loop-drive\.(ps1|mjs)/.test(h.command ?? '')),
  }))
  .filter((entry) => (entry.hooks ?? []).length > 0);
settings.hooks.Stop.push({
  matcher: '',
  hooks: [{ type: 'command', command: hookCmd, timeout: 20 }],
});

if (JSON.stringify(settings.hooks.Stop) === before) {
  console.log("Stop hook gia' registrato in settings.json: nessuna modifica.");
} else {
  if (existsSync(settingsPath)) {
    copyFileSync(settingsPath, `${settingsPath}.bak-perseveranza`);
    console.log(`Backup di settings.json: ${settingsPath}.bak-perseveranza`);
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log('Stop hook registrato in settings.json.');
}

console.log('');
console.log('Installazione completata. Riavvia Claude Code e usa: /perseveranza <descrizione del task>');
