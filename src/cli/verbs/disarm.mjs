import { existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gate } from '../shared.mjs';
import { loadState } from '../../core/state.mjs';
import { appendJournal } from '../../shell/journal.mjs';
import { archiveRun, archiveFailureNote, RETAINED_STATE } from '../../shell/archive.mjs';

export function run({ argv, cwd, env }) {
  const paths = gate(cwd);
  if (!existsSync(paths.gateDir)) { console.log('perseveranza was not armed.'); return 0; }
  const noArchive = argv.includes('--no-archive');
  let state = null;
  const statePath = existsSync(paths.statePath) ? paths.statePath : join(paths.gateDir, RETAINED_STATE);
  try { state = loadState(JSON.parse(readFileSync(statePath, 'utf8'))).state; } catch { /* unreadable */ }
  appendJournal(paths.gateDir, { type: 'signal', verb: 'disarm' });
  if (!noArchive) {
    const r = archiveRun(paths.gateDir, { projectName: paths.projectName, state, outcome: 'disarmed', env });
    if (!r.ok) { console.log(archiveFailureNote(r)); return 1; }
    console.log(`Run archived in ${r.dir}`);
  }
  try { rmSync(paths.gateDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log('perseveranza DISARMED.');
  return 0;
}
