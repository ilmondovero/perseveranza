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

// An outcome (report, claim-done) is the model's word on the work of a running loop. A paused
// loop waits for a human, and the first Stop after the resume would act on an outcome sent
// meanwhile (a review pass resets the retry counter, an accepted claim starts the final
// verification): so while paused it is refused, checked on the state as it is at the write.
// The answer says what is on disk: the check runs inside the write (updateState runs it again
// on every attempt), and when a pause lands right after the write (its writer built on it) the
// outcome is taken back and the refusal says so. -> the state written
//   field: the signal (lastReport, claimedDone); value: what the verb records
export function changeOutcome(paths, verb, field, value) {
  const r = updateState(paths, (st) => { if (st.signals.paused === true) return false; st.signals[field] = value; });
  if (!r.ok) throw new VerbError(r.absent ? 'perseveranza is NOT armed in this project.' : `state.json not saved: ${r.error}`);
  const why = 'A paused loop waits for a human (a plan to approve, an escalation): the user resumes it with /pf resume (or the resume verb from a terminal), then the outcome can be recorded.';
  // refused on the state it read: nothing written
  if (r.unchanged) throw new VerbError(`perseveranza is PAUSED: ${verb} not recorded. ${why} Nothing was changed.`);
  if (r.state.signals.paused !== true) return r.state;
  // written, then paused by another writer that kept it: taken back, if it is still ours
  const prev = r.before ? r.before.signals[field] : null;
  const back = updateState(paths, (st) => {
    if (st.signals.paused !== true || JSON.stringify(st.signals[field]) !== JSON.stringify(value)) return false;
    st.signals[field] = prev;
  });
  if (back.ok) {
    appendJournal(paths.gateDir, { type: 'outcome-dropped-paused', fields: [`signals.${field}`], values: { [field]: value }, by: verb });
    throw new VerbError(`perseveranza is PAUSED: ${verb} not recorded. The loop was paused while it was being written, and it was taken back: nothing of it is left in the state. ${why}`);
  }
  throw new VerbError(`perseveranza is PAUSED: ${verb} WAS recorded (signals.${field} = ${JSON.stringify(value)}) as the loop was being paused, and it could not be taken back (${back.error}). Tell the user: the first Stop after /pf resume would act on it.`);
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
