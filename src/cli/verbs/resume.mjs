import { rmSync } from 'node:fs';
import { gate, requireState, saveState, signal } from '../shared.mjs';

export function run({ cwd }) {
  const paths = gate(cwd);
  const s = requireState(paths);
  s.signals.paused = false;
  s.flags.repeated = false;
  s.counters.retries = 0;
  s.counters.finalFails = 0;
  saveState(paths, s);
  // the escalation hand-off belongs to the pause just closed: remove it so none goes stale
  try { rmSync(paths.escalationPath, { force: true }); } catch { /* already gone */ }
  signal(paths, 'resume');
  console.log('perseveranza RESUMED (retry counters reset).');
  return 0;
}
