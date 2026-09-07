import { existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gate } from '../shared.mjs';
import { loadState } from '../../core/state.mjs';
import { stepCounts } from '../../core/plan.mjs';
import { staleness, describeLastFire, describeActivity, openStepTitles, DEFAULT_STALE_MS } from '../../core/staleness.mjs';
import { readActivity } from '../../shell/activity.mjs';
import { appendJournal } from '../../shell/journal.mjs';
import { archiveRun, archiveFailureNote, RETAINED_STATE } from '../../shell/archive.mjs';
import { parseTimeoutMs } from '../../shell/util.mjs';

// What a human asks right after disarming: "had it finished?". The answer lives in the plan
// and the owner's last fire, both about to be archived, so it is printed here first.
export function recap(state, planText, { now = Date.now(), staleMs = DEFAULT_STALE_MS, activity = null } = {}) {
  if (!state) return [];
  const c = stepCounts(planText);
  const open = openStepTitles(planText);
  const lines = [];
  lines.push(`  task:        ${state.task}`);
  lines.push(`  phase:       ${state.phase}${state.signals?.paused ? '  (PAUSED)' : ''}  after ${state.counters?.iterations ?? 0} iterations`);
  lines.push(`  steps:       ${c.total ? `${c.done}/${c.total} done` : 'no plan'}${open.count ? ` — ${open.count} still open: ${open.shown.map((t) => `"${t}"`).join(', ')}${open.count > open.shown.length ? ', ...' : ''}` : c.total ? ' — all done' : ''}`);
  lines.push(`  session:     ${state.owner?.sessionId ? state.owner.sessionId.slice(0, 8) : 'not claimed'}, last fire ${describeLastFire(state, now, staleMs, activity)}`);
  const act = staleness(state, now, staleMs, activity).via === 'activity' ? describeActivity(activity, now) : '';
  if (act) lines.push(`  activity:    ${act}`);
  return lines;
}

export function run({ argv, cwd, env }) {
  const paths = gate(cwd);
  if (!existsSync(paths.gateDir)) { console.log('perseveranza was not armed.'); return 0; }
  const noArchive = argv.includes('--no-archive');
  let state = null;
  const statePath = existsSync(paths.statePath) ? paths.statePath : join(paths.gateDir, RETAINED_STATE);
  try { state = loadState(JSON.parse(readFileSync(statePath, 'utf8'))).state; } catch { /* unreadable */ }
  let planText = '';
  try { planText = readFileSync(paths.planPath, 'utf8'); } catch { /* no plan */ }
  for (const l of recap(state, planText, { staleMs: parseTimeoutMs(env?.OMC_LOOP_STALE_MS, DEFAULT_STALE_MS), activity: readActivity(paths.gateDir) })) console.log(l);
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
