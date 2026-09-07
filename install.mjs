#!/usr/bin/env node
// MANUAL installation of perseveranza (alternative to the plugin, same engine).
// Prefer the plugin:  /plugin marketplace add https://github.com/ilmondovero/perseveranza
//                     /plugin install perseveranza@perseveranza
// NEVER use both at once: two Stop hooks would drive the same loop.
//
//   1. copies the files listed in manifest.mjs into <claude-dir>/perseveranza/
//   2. installs the command and the agents into <claude-dir>/commands and <claude-dir>/agents
//   3. registers the hooks of manifest HOOK_SPECS in <claude-dir>/settings.json (idempotent, with backup),
//      replacing entries of previous versions (v1 scripts/loop-drive.mjs and .ps1 included)
// Usage:  node install.mjs [--claude-dir <dir>]
//         node install.mjs --uninstall
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { RUNTIME_FILES, AGENT_FILES, COMMAND_FILES, PLUGIN_FILES, HOOK_SPECS, CLI_ENTRY } from './manifest.mjs';

const src = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
let claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const dirFlag = argv.indexOf('--claude-dir');
if (dirFlag !== -1 && argv[dirFlag + 1]) claudeDir = argv[dirFlag + 1];
const uninstall = argv.includes('--uninstall');

const installDir = join(claudeDir, 'perseveranza');
const commandsDir = join(claudeDir, 'commands');
const agentsDir = join(claudeDir, 'agents');
const settingsPath = join(claudeDir, 'settings.json');
// forward slashes in the registered commands: Node accepts them on Windows too, and they
// survive JSON/settings editing without escaping surprises
const cliPath = join(installDir, CLI_ENTRY).replaceAll('\\', '/');
const HOOK_RE = /loop-drive\.(ps1|mjs)|perseveranza[\\/]src[\\/]shell[\\/](stop|session-start|activity-hook)\.mjs/;
const HOOK_EVENTS = [...new Set(HOOK_SPECS.map((h) => h.event))];
const hookEntries = (settings) => JSON.stringify(HOOK_EVENTS.map((ev) => settings.hooks?.[ev] ?? []));

function loadSettings() {
  if (!existsSync(settingsPath)) return {};
  try { return JSON.parse(readFileSync(settingsPath, 'utf8')) ?? {}; }
  catch (e) { console.error(`ERROR: ${settingsPath} is not valid JSON (${e.message}): fix it and retry.`); process.exit(1); }
}
// Remove our entries. With `create`, every event list exists afterwards (install adds to it);
// without it, a list that ends empty and was not there before is dropped (uninstall leaves
// no trace of an event the user never configured).
function stripLoopEntries(settings, { create = true } = {}) {
  settings.hooks ??= {};
  for (const ev of HOOK_EVENTS) {
    const had = Array.isArray(settings.hooks[ev]);
    const list = (had ? settings.hooks[ev] : [])
      .map((entry) => ({ ...entry, hooks: (entry.hooks ?? []).filter((h) => !HOOK_RE.test(h.command ?? '')) }))
      .filter((entry) => (entry.hooks ?? []).length > 0);
    if (create || had) settings.hooks[ev] = list;
    if (!create && !had && list.length === 0) delete settings.hooks[ev];
  }
}
function saveSettings(settings) {
  if (existsSync(settingsPath)) {
    copyFileSync(settingsPath, `${settingsPath}.bak-perseveranza`);
    console.log(`Backup of settings.json: ${settingsPath}.bak-perseveranza`);
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
const copy = (rel, dest) => { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(join(src, rel), dest); };

if (uninstall) {
  if (existsSync(installDir)) { rmSync(installDir, { recursive: true, force: true }); console.log(`Removed: ${installDir}`); }
  for (const f of [...COMMAND_FILES.map((c) => join(commandsDir, basename(c))), ...AGENT_FILES.map((a) => join(agentsDir, basename(a)))]) {
    if (existsSync(f)) { rmSync(f); console.log(`Removed: ${f}`); }
  }
  // v1 leftovers
  for (const old of ['omc-loop.mjs', 'loop-drive.mjs', 'providers.mjs', 'hud.mjs', 'statusline.mjs', 'statusline-resolver.mjs', 'update.mjs', 'util.mjs', 'prompts.mjs', 'omc-loop.ps1', 'loop-drive.ps1']) {
    const p = join(claudeDir, 'hooks', old);
    if (existsSync(p)) { rmSync(p); console.log(`Removed v1 file: ${p}`); }
  }
  const settings = loadSettings();
  const before = hookEntries(settings);
  stripLoopEntries(settings, { create: false });
  if (hookEntries(settings) !== before) { saveSettings(settings); console.log('Hook entries removed from settings.json.'); }
  console.log('Uninstalled. Restart Claude Code.');
  process.exit(0);
}

// --- 1. runtime files (manifest-driven) ---
for (const rel of [...RUNTIME_FILES, ...PLUGIN_FILES]) copy(rel, join(installDir, rel));
// --- 2. command (with the plugin root rewritten to the install dir) and agents ---
mkdirSync(commandsDir, { recursive: true });
for (const c of COMMAND_FILES) {
  const text = readFileSync(join(src, c), 'utf8').replaceAll('${CLAUDE_PLUGIN_ROOT}', installDir.replaceAll('\\', '/'));
  writeFileSync(join(commandsDir, basename(c)), text);
}
mkdirSync(agentsDir, { recursive: true });
for (const a of AGENT_FILES) copy(a, join(agentsDir, basename(a)));
console.log(`Files copied to ${installDir} (+ commands/, agents/).`);
// v1 leftovers in hooks/
for (const old of ['omc-loop.mjs', 'loop-drive.mjs', 'providers.mjs', 'hud.mjs', 'statusline.mjs', 'statusline-resolver.mjs', 'update.mjs', 'util.mjs', 'prompts.mjs', 'omc-loop.ps1', 'loop-drive.ps1']) {
  const p = join(claudeDir, 'hooks', old);
  if (existsSync(p)) { rmSync(p); console.log(`Removed v1 file: hooks/${old}`); }
}

// --- 3. the hooks (manifest HOOK_SPECS) ---
const settings = loadSettings();
const before = hookEntries(settings);
stripLoopEntries(settings);
for (const h of HOOK_SPECS) {
  const entryPath = join(installDir, h.entry).replaceAll('\\', '/');
  settings.hooks[h.event].push({ matcher: h.matcher, hooks: [{ type: 'command', command: `node "${entryPath}"`, timeout: h.timeout }] });
}
if (hookEntries(settings) === before) console.log('Hooks already registered in settings.json: no change.');
else { saveSettings(settings); console.log(`Hooks registered in settings.json: ${HOOK_EVENTS.join(', ')}.`); }

console.log('');
console.log(`Installed. Restart Claude Code and use: /perseveranza <task>   (verbs: node "${cliPath}" ...)`);
console.log('WARNING: if the perseveranza plugin is also installed, uninstall one of the two.');
