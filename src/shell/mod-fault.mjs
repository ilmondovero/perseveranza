// .perseveranza/mod-fault.json: the trace the mod leaves when its Stop hook could not reach the
// bridge at all (node unreachable, the bridge crashed) and so could not journal the failure. The
// mod writes it itself with $.fs.write (hooks/lib/gate.js writeFault); the shell only reads it:
//   - `status` shows it (the stop that let Claude go is not silent);
//   - the watchdog's notification names it (the silence that follows has a cause);
//   - the next stop that reaches the bridge journals it (mod-fault) and removes it;
//   - `arm` reports a leftover one and removes it (it belonged to a run that is gone).
// Never throws.
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { appendJournal } from './journal.mjs';
import { formatAge } from '../core/time.mjs';

export const MOD_FAULT_FILE = 'mod-fault.json';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

// -> { at, hook, error, session, stopHookActive, recovery } | { unreadable: true } | null (none)
export function readModFault(gateDir) {
  const p = join(gateDir, MOD_FAULT_FILE);
  if (!existsSync(p)) return null;
  let raw = null;
  try { raw = JSON.parse(readFileSync(p, 'utf8')); } catch { return { unreadable: true }; }
  if (!isObj(raw)) return { unreadable: true };
  const at = Number(raw.at);
  return {
    at: Number.isFinite(at) && at > 0 ? at : 0,
    hook: str(raw.hook, 40) || 'classic.Stop',
    error: str(raw.error, 300),
    session: str(raw.session, 80),
    stopHookActive: raw.stopHookActive === true,
    recovery: raw.recovery === true,
  };
}

// One line for a human: what failed, when, and what the loop did about it.
export function modFaultText(f, now = Date.now()) {
  if (!f) return '';
  if (f.unreadable) return 'the mod left a fault marker (.perseveranza/mod-fault.json) that cannot be read';
  const when = f.at ? `${formatAge(Math.max(0, now - f.at))} ago` : 'at an unknown time';
  return `the mod's ${f.hook} hook could not reach its helper ${when}${f.error ? ` (${f.error})` : ''}: ${f.recovery ? 'it asked the session to carry on' : 'the session was let stop'}`;
}

// A marker left by a run that is gone (`arm`): removed. -> true when it was removed
export function clearModFault(gateDir) {
  try { rmSync(join(gateDir, MOD_FAULT_FILE), { force: true }); return !existsSync(join(gateDir, MOD_FAULT_FILE)); } catch { return false; }
}

// The marker -> a journal line (mod-fault) and gone. -> the fault, or null when there was none.
export function takeModFault(gateDir) {
  const f = readModFault(gateDir);
  if (!f) return null;
  appendJournal(gateDir, { type: 'mod-fault', ...(f.unreadable ? { unreadable: true } : { at: f.at ? new Date(f.at).toISOString() : null, hook: f.hook, error: f.error, session: f.session.slice(0, 8), stopHookActive: f.stopHookActive, recovery: f.recovery }) });
  try { rmSync(join(gateDir, MOD_FAULT_FILE), { force: true }); } catch { /* the next stop tries again */ }
  return f;
}
