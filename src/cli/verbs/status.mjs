import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gate, requireState } from '../shared.mjs';
import { stepCounts } from '../../core/plan.mjs';
import { effectiveLenses, singleLens } from '../../core/state.mjs';
import { parseVerifyVerdict } from '../../core/verdicts.mjs';
import { cleanRequestId, LATE_TOLERANCE_MS } from '../../core/machine.mjs';
import { iterationCap, tokensSpent } from '../../core/budget.mjs';
import { outcomesFor } from '../../core/transitions.mjs';
import { formatTokens } from '../../hud/render.mjs';
import { RETAINED_STATE } from '../../shell/archive.mjs';
import { staleness, releaseOpen, describeLastFire, describeActivity, formatAge, DEFAULT_STALE_MS } from '../../core/staleness.mjs';
import { readLife } from '../../shell/life.mjs';
import { parseTimeoutMs } from '../../shell/util.mjs';

// The lens verdicts of the current round on disk, by the Stop hook's rule: they parse and
// answer this request; one without an id counts only if not written before the request
// (one second of tolerance). The hook decides; this is only what `status` can see.
export function arrivedLenses(gateDir, s) {
  const out = [];
  for (const lens of s.verdictLenses || []) {
    const p = join(gateDir, `verify-${lens}.json`);
    let v = null;
    let at = 0;
    try { v = parseVerifyVerdict(readFileSync(p, 'utf8')); at = statSync(p).mtimeMs; } catch { continue; }
    if (!v.ok) continue;
    const id = cleanRequestId(v.requestId);
    const fresh = s.verdictRequestId && id
      ? id === s.verdictRequestId
      : !(s.verdictRequestedAt > 0 && at > 0 && at + LATE_TOLERANCE_MS < s.verdictRequestedAt);
    if (fresh) out.push(lens);
  }
  return out;
}

export function summary(s, planText, { now = Date.now(), staleMs = DEFAULT_STALE_MS, activity = null, transcriptAt = 0, lensesArrived = [] } = {}) {
  const c = stepCounts(planText);
  const lines = [];
  lines.push(`perseveranza ARMED — ${s.task}`);
  lines.push(`  phase:       ${s.phase}${s.signals.paused ? '  (PAUSED)' : ''}`);
  lines.push(`  complexity:  ${s.complexity}`);
  lines.push(`  steps:       ${c.done}/${c.total} done${c.open ? ` (${c.open} open)` : ''}`);
  lines.push(`  iterations:  ${s.counters.iterations}/${iterationCap(s)}${s.limits.maxIterationsExplicit ? '' : ' (adaptive)'}`);
  const spent = tokensSpent(s.usage);
  lines.push(`  tokens:      ${spent ? formatTokens(spent) : 'not measured'}${s.limits.maxTokens ? ` / ${formatTokens(s.limits.maxTokens)}` : ''}${spent && s.usage.source === 'transcript' ? ' (main transcript only)' : ''}${spent && s.usage.partial ? ' (partial)' : ''}`);
  const agents = spent && s.usage.byAgent ? Object.entries(s.usage.byAgent).map(([k, v]) => [k, tokensSpent(v)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]) : [];
  if (agents.length > 1) lines.push(`  by agent:    ${agents.map(([k, n]) => `${k} ${formatTokens(n)}`).join(', ')}`);
  lines.push(`  retries:     ${s.counters.retries}/${s.limits.maxRetries} review fixes, ${s.counters.finalFails}/${s.limits.maxRetries} final rejections`);
  lines.push(`  signals:     report=${s.signals.lastReport}${s.signals.claimedDone ? ', claim-done pending' : ''}`);
  lines.push(`  last test:   ${s.lastTest ? `${s.lastTest.cmd} -> exit ${s.lastTest.exitCode} (iteration ${s.lastTest.iteration}${s.lastTest.fingerprint ? ', tree ' + s.lastTest.fingerprint.slice(0, 8) : ''})${s.lastTest.failed && s.lastTest.failed.length ? ` failed: ${s.lastTest.failed.slice(0, 5).join(', ')}${s.lastTest.failed.length > 5 ? ', ...' : ''}` : ''}` : 'none'}`);
  lines.push(`  options:     ${[
    s.options.commitSteps ? 'commit per step' : null,
    s.options.gitFinish ? (s.options.gitPush ? 'git finish: commit+push' : 'git finish: local commit') : 'no git finish',
    s.options.approvePlan ? 'plan approval' : null,
    s.options.testCmd ? `test: ${s.options.testCmd}` : null,
    `lang: ${s.options.lang}`,
    `verifiers: ${s.options.verifiers ? s.options.verifiers.join(',') : `auto (now ${effectiveLenses(s).join(',')})`}`,
  ].filter(Boolean).join(', ')}`);
  lines.push(`  externals:   ${s.options.externals.length ? s.options.externals.join(', ') : 'none'}`);
  lines.push(`  Advisor: ${s.options.advisor === false ? 'off' : `on (${s.options.advisorModel || 'opus'})`}${s.priorReviews && s.priorReviews.length ? `  <- failed reviews of this step it reads: ${s.priorReviews.join(', ')}` : ''}`);
  const released = s.owner.releasedFrom ? (releaseOpen(s, now, staleMs) ? `released by ${s.owner.releasedFrom.slice(0, 8)}, next fire claims` : `released by ${s.owner.releasedFrom.slice(0, 8)}, window closed (resume --takeover again)`) : 'not claimed yet';
  lines.push(`  session:     ${s.owner.sessionId ? s.owner.sessionId.slice(0, 8) : released}`);
  const st = staleness(s, now, staleMs, activity, transcriptAt);
  const hint = st.stale ? `  <- no sign of life for over ${formatAge(staleMs)}: the owner session is probably gone (resume --takeover to drive it from here, disarm to stop it)`
    : st.paused && st.ageMs != null && st.ageMs > staleMs ? '  <- paused, a human is expected: read .omc-loop/ESCALATION.md if present, then resume' : '';
  lines.push(`  last fire:   ${describeLastFire(s, now, staleMs, activity, transcriptAt)}${hint}`);
  const act = st.via !== 'fire' ? describeActivity(activity, now) : '';
  if (act) lines.push(`  activity:    ${act}`);
  if (transcriptAt > 0 && transcriptAt > s.owner.lastFireAt) lines.push(`  transcript:  written ${formatAge(Math.max(0, now - transcriptAt))} ago${s.owner.claudePid ? ` (Claude Code pid ${s.owner.claudePid})` : ''}`);
  const lensRound = s.phase === 'final-verify' && !singleLens(s.verdictLenses);
  if ((s.phase === 'review' || s.phase === 'final-verify') && s.verdictRequestId) lines.push(`  verdict request: ${s.verdictRequestId}  <- the ${s.phase === 'review' ? 'reviewer' : 'verifier'} copies it into ${s.phase === 'review' ? 'review.json' : lensRound ? 'verify-<lens>.json' : 'verify.json'} as "requestId"`);
  if (lensRound) lines.push(`  lenses:      expected ${s.verdictLenses.join(', ')}; arrived ${lensesArrived.length ? lensesArrived.join(', ') : 'none'}${s.verdictLenses.some((l) => !lensesArrived.includes(l)) ? `; missing ${s.verdictLenses.filter((l) => !lensesArrived.includes(l)).join(', ')}` : ''}`);
  if (s.priorVerifies && s.priorVerifies.length) lines.push(`  rechecked:   ${s.priorVerifies.join(', ')}  <- findings of rejected rounds the next verification rechecks`);
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
  console.log(summary(s, planText, { now: Date.now(), staleMs: parseTimeoutMs(env.OMC_LOOP_STALE_MS, DEFAULT_STALE_MS), ...readLife(paths.gateDir, s), lensesArrived: arrivedLenses(paths.gateDir, s) }));
  return 0;
}
