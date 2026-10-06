// Shared plumbing for the verbs.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { gatePaths } from '../shell/paths.mjs';
import { DISARMED_MARK } from '../shell/archive.mjs';
import { appendJournal } from '../shell/journal.mjs';
import { loadStateFile, updateState, writeDurable, cleanStateResidues } from '../shell/state-file.mjs';

export class VerbError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

export function gate(cwd = process.cwd()) {
  return gatePaths(cwd);
}

// Load the state or fail with the canonical "not armed" message (a pending copy left by a
// save cut short is promoted: state-file.mjs).
export function requireState(paths) {
  const r = loadStateFile(paths);
  if (!r.state) {
    if (r.absent) throw new VerbError('perseveranza is NOT armed in this project.');
    if (/^(invalid JSON|empty|unreadable)/.test(String(r.error))) throw new VerbError(`state.json unreadable: ${r.error}`);
    throw new VerbError(`state.json is not a loop state (${r.error}).`);
  }
  if (r.migrated) appendJournal(paths.gateDir, { type: 'migrate', from: 1, to: 2 });
  return r.state;
}

// A verb's change: mutate(fresh) on the state reread just before the write, never on a copy
// read earlier (a Stop may have saved meanwhile). -> the state written
export function changeState(paths, mutate) {
  const r = updateState(paths, mutate);
  if (!r.ok) throw new VerbError(r.absent ? 'perseveranza is NOT armed in this project.' : `state.json not saved: ${r.error}`);
  return r.state;
}

// arm: a new run's state, over whatever an old one left behind. The disarm mark must go: a
// new run beside it would have no crash recovery (its pending copy never promoted).
// fs: for the tests (a refused rename, a write cut short)
export function writeNewState(paths, state, { fs } = {}) {
  cleanStateResidues(paths.gateDir, { fs });
  if (existsSync(join(paths.gateDir, DISARMED_MARK))) throw new VerbError(`${DISARMED_MARK} in .perseveranza cannot be removed (a file held open?): close what holds it and arm again.`);
  const w = writeDurable(paths.statePath, JSON.stringify(state, null, 2), { keepPending: true, fs });
  if (!w.ok) throw new VerbError(`state.json not written: ${w.error}`);
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
