#!/usr/bin/env node
// npm run test:mod: the mod's checks that need Claude Code itself, in order:
//   1. claude plugin validate --strict (the static analysis Claude Code runs when it loads the
//      mod: literal event names, $ never destructured, relative imports only...), on the plugin
//      manifest and on the repository (the marketplace);
//   2. claude plugin test (test/mod/*.test.ts: the mod's hooks against the real engine, every
//      bridge answer stubbed, no file system, processes or network);
//   3. test/mod/e2e-claude.mjs (a real `claude -p` drives a mini-task to the git finish).
// Without `claude` on the PATH every step says SKIPPED, never silently (exit 0: nothing ran, so
// nothing failed; test/packaging/install.test.mjs checks the words with an empty PATH). Not part of `npm test`,
// which stays local and deterministic. Extra arguments go to the e2e (e.g. --dir, --keep);
// --no-e2e stops after step 2.
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = process.argv.slice(2);
const noE2e = args.includes('--no-e2e');
const e2eArgs = args.filter((a) => a !== '--no-e2e');

const v = spawnSync('claude', ['--version'], { encoding: 'utf8' });
if (v.error || v.status !== 0) {
  for (const step of ['claude plugin validate', 'claude plugin test', 'e2e-claude']) console.log(`test:mod: ${step}: SKIPPED - claude is not on the PATH`);
  process.exit(0);
}

const steps = [
  ['claude plugin validate --strict .claude-plugin/plugin.json', 'claude', ['plugin', 'validate', '--strict', join('.claude-plugin', 'plugin.json')]],
  ['claude plugin validate --strict .', 'claude', ['plugin', 'validate', '--strict', '.']],
  ['claude plugin test', 'claude', ['plugin', 'test', '.']],
  ...(noE2e ? [] : [['e2e-claude', process.execPath, [join(ROOT, 'test', 'mod', 'e2e-claude.mjs'), ...e2eArgs]]]),
];
// no claude.ai connectors in the children (they slow every start and are not needed here)
const env = { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: '0' };
let failed = 0;
for (const [name, cmd, a] of steps) {
  console.log(`test:mod: ${name}`);
  // the e2e streams (it is long); the others are read too, to name a known cause
  const live = cmd === process.execPath;
  const r = spawnSync(cmd, a, { cwd: ROOT, env, stdio: live ? 'inherit' : ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (!live) { process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); }
  const ok = !r.error && r.status === 0;
  console.log(`test:mod: ${name}: ${ok ? 'ok' : `FAILED (${r.error ? r.error.message : `exit ${r.status}`})`}`);
  if (!ok && /rollout switch/i.test(`${r.stdout || ''}${r.stderr || ''}`)) console.log('test:mod: the mods rollout switch is saved off on this machine: run `claude -p "ok"` once with network access, then npm run test:mod again.');
  if (!ok) failed++;
}
if (noE2e) console.log('test:mod: e2e-claude: SKIPPED - --no-e2e');
process.exit(failed ? 1 : 0);
