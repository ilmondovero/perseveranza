import { existsSync, rmSync, readFileSync } from 'node:fs';
import { gate } from '../shared.mjs';
import { loadStateFile, readRetainedState } from '../../shell/state-file.mjs';
import { stepCounts } from '../../core/plan.mjs';
import { staleness, describeLastFire, describeActivity, openStepTitles, DEFAULT_STALE_MS } from '../../core/staleness.mjs';
import { readLife } from '../../shell/life.mjs';
import { appendJournal } from '../../shell/journal.mjs';
import { archiveRun, archiveFailureNote, makeDormant } from '../../shell/archive.mjs';
import { parseTimeoutMs } from '../../shell/util.mjs';

// What a human asks right after disarming: "had it finished?". The answer lives in the plan
// and the owner's last fire, both about to be archived, so it is printed here first.
export function recap(state, planText, { now = Date.now(), staleMs = DEFAULT_STALE_MS, activity = null, transcriptAt = 0 } = {}) {
  if (!state) return [];
  const c = stepCounts(planText);
  const open = openStepTitles(planText);
  const lines = [];
  lines.push(`  task:        ${state.task}`);
  lines.push(`  phase:       ${state.phase}${state.signals?.paused ? '  (PAUSED)' : ''}  after ${state.counters?.iterations ?? 0} iterations`);
  lines.push(`  steps:       ${c.total ? `${c.done}/${c.total} done` : 'no plan'}${open.count ? ` — ${open.count} still open: ${open.shown.map((t) => `"${t}"`).join(', ')}${open.count > open.shown.length ? ', ...' : ''}` : c.total ? ' — all done' : ''}`);
  lines.push(`  session:     ${state.owner?.sessionId ? state.owner.sessionId.slice(0, 8) : 'not claimed'}, last fire ${describeLastFire(state, now, staleMs, activity, transcriptAt)}`);
  const act = staleness(state, now, staleMs, activity, transcriptAt).via !== 'fire' ? describeActivity(activity, now) : '';
  if (act) lines.push(`  activity:    ${act}`);
  return lines;
}

// io: { rename, rm } for the tests (files a sync client keeps from going)
export function run({ argv, cwd, env, io = {} }) {
  const rm = io.rm || rmSync;
  const paths = gate(cwd);
  if (!existsSync(paths.gateDir)) { console.log('perseveranza was not armed.'); return 0; }
  const noArchive = argv.includes('--no-archive');
  // the run's state: state.json (or its pending copy), or after an archive failure the newest of
  // state.unsaved.json and state.disarmed.json, whichever is the latest save of the run (rev)
  const live = loadStateFile(paths).state;
  const retained = readRetainedState(paths.gateDir);
  const state = live && (!retained || (live.rev || 0) >= (retained.state.rev || 0)) ? live : retained ? retained.state : null;
  let planText = '';
  try { planText = readFileSync(paths.planPath, 'utf8'); } catch { /* no plan */ }
  for (const l of recap(state, planText, { staleMs: parseTimeoutMs(env?.PERSEVERANZA_STALE_MS, DEFAULT_STALE_MS), ...readLife(paths.gateDir, state) })) console.log(l);
  appendJournal(paths.gateDir, { type: 'signal', verb: 'disarm' });
  if (!noArchive) {
    const r = archiveRun(paths.gateDir, { projectName: paths.projectName, state, outcome: 'disarmed', env, io });
    if (!r.ok) { console.log(archiveFailureNote(r)); return 1; }
    console.log(`Run archived in ${r.dir}`);
  }
  try { rm(paths.gateDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  // a file held open kept part of the gate: nothing left in it may arm the loop again; and if
  // what is held open is state.json itself, the loop is still armed: said, not hidden
  if (existsSync(paths.gateDir)) {
    const d = makeDormant(paths.gateDir, { rm });
    if (!d.dormant) {
      console.log(`Could not disarm: .perseveranza/state.json cannot be removed (held open by another process?). The loop is still ARMED; close what holds it and run disarm again.`);
      return 1;
    }
  }
  console.log('perseveranza DISARMED.');
  return 0;
}
