// Shared plumbing for the verbs.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gatePaths } from '../shell/paths.mjs';
import { loadState } from '../core/state.mjs';
import { appendJournal } from '../shell/journal.mjs';

export class VerbError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

export function gate(cwd = process.cwd()) {
  return gatePaths(cwd);
}

// Load the state or fail with the canonical "not armed" message.
export function requireState(paths) {
  if (!existsSync(paths.statePath)) throw new VerbError('perseveranza is NOT armed in this project.');
  let raw;
  try { raw = JSON.parse(readFileSync(paths.statePath, 'utf8')); } catch (e) { throw new VerbError(`state.json unreadable: ${e.message}`); }
  const r = loadState(raw);
  if (!r.state) throw new VerbError(`state.json is not a loop state (${r.error}).`);
  if (r.migrated) appendJournal(paths.gateDir, { type: 'migrate', from: 1, to: 2 });
  return r.state;
}

export function saveState(paths, state) {
  writeFileSync(paths.statePath, JSON.stringify(state, null, 2));
}

export function signal(paths, verb, value = '') {
  appendJournal(paths.gateDir, { type: 'signal', verb, value });
}

// Everything after `--` on the raw command line (shared by `ask` and `test`).
export function argsAfterDoubleDash(argv = process.argv) {
  const sep = argv.indexOf('--');
  return sep !== -1 && argv.length > sep + 1 ? argv.slice(sep + 1).join(' ') : '';
}

export const fileSafe = (x) => String(x).replace(/[^a-z0-9._-]/gi, '-');

export function positiveInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 ? n : def;
}
