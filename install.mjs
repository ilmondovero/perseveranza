#!/usr/bin/env node
// MANUAL installation of perseveranza (alternative to the plugin, same engine).
// Prefer the plugin:  /plugin marketplace add https://github.com/ilmondovero/perseveranza
//                     /plugin install perseveranza@perseveranza
// NEVER use both at once: two Stop hooks would drive the same loop.
//
//   1. copies the files listed in manifest.mjs into <claude-dir>/perseveranza/
//   2. installs the command and the agents into <claude-dir>/commands and <claude-dir>/agents
//   3. registers the Stop hook in <claude-dir>/settings.json (idempotent, with backup),
//      replacing entries of previous versions (v1 scripts/loop-drive.mjs and .ps1 included)
// Usage:  node install.mjs [--claude-dir <dir>]
//         node install.mjs --uninstall
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { RUNTIME_FILES, AGENT_FILES, COMMAND_FILES, PLUGIN_FILES, HOOK_ENTRY, CLI_ENTRY } from './manifest.mjs';

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
const hookPath = join(installDir, HOOK_ENTRY).replaceAll('\\', '/');
const cliPath = join(installDir, CLI_ENTRY).replaceAll('\\', '/');
const HOOK_RE = /loop-drive\.(ps1|mjs)|perseveranza[\\/]src[\\/]shell[\\/]stop\.mjs/;

function loadSettings() {
  if (!existsSync(settingsPath)) return {};
  try { return JSON.parse(readFileSync(settingsPath, 'utf8')) ?? {}; }
  catch (e) { console.error(`ERROR: ${settingsPath} is not valid JSON (${e.message}): fix it and retry.`); process.exit(1); }
}
function stripLoopEntries(settings) {
  settings.hooks ??= {};
  settings.hooks.Stop ??= [];
  settings.hooks.Stop = settings.hooks.Stop
    .map((entry) => ({ ...entry, hooks: (entry.hooks ?? []).filter((h) => !HOOK_RE.test(h.command ?? '')) }))
    .filter((entry) => (entry.hooks ?? []).length > 0);
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
  const before = JSON.stringify(settings.hooks?.Stop ?? []);
  stripLoopEntries(settings);
  if (JSON.stringify(settings.hooks.Stop) !== before) { saveSettings(settings); console.log('Stop hook entry removed from settings.json.'); }
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

// --- 3. Stop hook ---
const settings = loadSettings();
const before = JSON.stringify(settings.hooks?.Stop ?? []);
stripLoopEntries(settings);
settings.hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command: `node "${hookPath}"`, timeout: 120 }] });
if (JSON.stringify(settings.hooks.Stop) === before) console.log('Stop hook already registered in settings.json: no change.');
else { saveSettings(settings); console.log('Stop hook registered in settings.json.'); }

console.log('');
console.log(`Installed. Restart Claude Code and use: /perseveranza <task>   (verbs: node "${cliPath}" ...)`);
console.log('WARNING: if the perseveranza plugin is also installed, uninstall one of the two.');
