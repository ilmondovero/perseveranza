import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gate, requireState } from '../shared.mjs';
import { stepCounts } from '../../core/plan.mjs';
import { iterationCap, tokensSpent } from '../../core/budget.mjs';
import { outcomesFor } from '../../core/transitions.mjs';
import { formatTokens } from '../../hud/render.mjs';
import { RETAINED_STATE } from '../../shell/archive.mjs';

export function summary(s, planText) {
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
  lines.push(`  session:     ${s.owner.sessionId ? s.owner.sessionId.slice(0, 8) : 'not claimed yet'}`);
  lines.push(`  armed at:    ${s.armedAt || '?'}  (engine v${s.engineVersion || '?'})`);
  const next = outcomesFor(s.phase).map((r) => r.outcome).join(', ');
  lines.push(`  next outcomes: ${next}`);
  return lines.join('\n');
}

export function run({ argv, cwd }) {
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
  console.log(summary(s, planText));
  return 0;
}
