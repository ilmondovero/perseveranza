import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gate, requireState } from '../shared.mjs';
import { stepCounts } from '../../core/plan.mjs';
import { iterationCap, tokensSpent } from '../../core/budget.mjs';
import { outcomesFor } from '../../core/transitions.mjs';
import { formatTokens } from '../../hud/render.mjs';
import { RETAINED_STATE } from '../../shell/archive.mjs';
import { staleness, releaseOpen, describeLastFire, describeActivity, formatAge, DEFAULT_STALE_MS } from '../../core/staleness.mjs';
import { readLife } from '../../shell/life.mjs';
import { parseTimeoutMs } from '../../shell/util.mjs';

export function summary(s, planText, { now = Date.now(), staleMs = DEFAULT_STALE_MS, activity = null, transcriptAt = 0 } = {}) {
  const c = stepCounts(planText);
  const lines = [];
  lines.push(`perseveranza ARMED — ${s.task}`);
  lines.push(`  phase:       ${s.phase}${s.signals.paused ? '  (PAUSED)' : ''}`);
  lines.push(`  complexity:  ${s.complexity}`);
  lines.push(`  steps:       ${c.done}/${c.total} done${c.open ? ` (${c.open} open)` : ''}`);
  lines.push(`  iterations:  ${s.counters.iterations}/${iterationCap(s)}${s.limits.maxIterationsExplicit ? '' : ' (adaptive)'}`);
  const spent = tokensSpent(s.usage);
  lines.push(`  tokens:      ${spent ? formatTokens(spent) : 'not measured'}${s.limits.maxTokens ? ` / ${formatTokens(s.limits.maxTokens)}` : ''}`);
  lines.push(`  retries:     ${s.counters.retries}/${s.limits.maxRetries} review fixes, ${s.counters.finalFails}/${s.limits.maxRetries} final rejections`);
  lines.push(`  signals:     report=${s.signals.lastReport}${s.signals.claimedDone ? ', claim-done pending' : ''}`);
  lines.push(`  last test:   ${s.lastTest ? `${s.lastTest.cmd} -> exit ${s.lastTest.exitCode} (iteration ${s.lastTest.iteration}${s.lastTest.fingerprint ? ', tree ' + s.lastTest.fingerprint.slice(0, 8) : ''})${s.lastTest.failed && s.lastTest.failed.length ? ` failed: ${s.lastTest.failed.slice(0, 5).join(', ')}${s.lastTest.failed.length > 5 ? ', ...' : ''}` : ''}` : 'none'}`);
  lines.push(`  options:     ${[
    s.options.commitSteps ? 'commit per step' : null,
    s.options.gitFinish ? (s.options.gitPush ? 'git finish: commit+push' : 'git finish: local commit') : 'no git finish',
    s.options.approvePlan ? 'plan approval' : null,
    s.options.testCmd ? `test: ${s.options.testCmd}` : null,
    `lang: ${s.options.lang}`,
  ].filter(Boolean).join(', ')}`);
  lines.push(`  externals:   ${s.options.externals.length ? s.options.externals.join(', ') : 'none'}`);
  const released = s.owner.releasedFrom ? (releaseOpen(s, now, staleMs) ? `released by ${s.owner.releasedFrom.slice(0, 8)}, next fire claims` : `released by ${s.owner.releasedFrom.slice(0, 8)}, window closed (resume --takeover again)`) : 'not claimed yet';
  lines.push(`  session:     ${s.owner.sessionId ? s.owner.sessionId.slice(0, 8) : released}`);
  const st = staleness(s, now, staleMs, activity, transcriptAt);
  const hint = st.stale ? `  <- no sign of life for over ${formatAge(staleMs)}: the owner session is probably gone (resume --takeover to drive it from here, disarm to stop it)`
    : st.paused && st.ageMs != null && st.ageMs > staleMs ? '  <- paused, a human is expected: read .omc-loop/ESCALATION.md if present, then resume' : '';
  lines.push(`  last fire:   ${describeLastFire(s, now, staleMs, activity, transcriptAt)}${hint}`);
  const act = st.via !== 'fire' ? describeActivity(activity, now) : '';
  if (act) lines.push(`  activity:    ${act}`);
  if (transcriptAt > 0 && transcriptAt > s.owner.lastFireAt) lines.push(`  transcript:  written ${formatAge(Math.max(0, now - transcriptAt))} ago${s.owner.claudePid ? ` (Claude Code pid ${s.owner.claudePid})` : ''}`);
  if (s.signals.interrupted) lines.push(`  interrupted: ${s.signals.interrupted.at || '?'} after ${formatAge(s.signals.interrupted.silentMs)} silent in phase ${s.signals.interrupted.phase || '?'}${s.signals.interrupted.pending.length ? `, pending: ${s.signals.interrupted.pending.join(', ')}` : ''}  <- reconciling: read-only until .omc-loop/reconcile.json is written`);
  lines.push(`  armed at:    ${s.armedAt || '?'}  (engine v${s.engineVersion || '?'})`);
  const next = outcomesFor(s.phase).filter((r) => s.signals.interrupted || !r.outcome.startsWith('reconcile-')).map((r) => r.outcome).join(', ');
  lines.push(`  next outcomes: ${next}`);
  return lines.join('\n');
}

export function run({ argv, cwd, env = process.env }) {
  const paths = gate(cwd);
  if (!existsSync(paths.statePath)) {
    console.log('perseveranza is NOT armed in this project.');
    if (existsSync(join(paths.gateDir, RETAINED_STATE))) {
      console.log('Run artifacts retained in .omc-loop after an archive failure. Fix the archive destination and retry disarm.');
    }
    return 1;
  }
  const s = requireState(paths);
  if (argv.includes('--json')) { console.log(JSON.stringify(s, null, 2)); return 0; }
  let planText = '';
  try { planText = readFileSync(paths.planPath, 'utf8'); } catch { /* no plan */ }
  console.log(summary(s, planText, { now: Date.now(), staleMs: parseTimeoutMs(env.OMC_LOOP_STALE_MS, DEFAULT_STALE_MS), ...readLife(paths.gateDir, s) }));
  return 0;
}
