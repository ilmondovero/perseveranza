// Executes the effects returned by the core, in order. The only place where the machine's
// decisions touch the filesystem, git, the desktop and stdout.
import { writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { appendJournal, readJournal, renderHistory } from './journal.mjs';
import { notify } from './notify.mjs';
import { gitFinish } from './git.mjs';
import { archiveRun } from './archive.mjs';
import { summarizeExternalOpinions, shortTs } from './util.mjs';
import { countOpenSteps } from '../core/plan.mjs';
import { finishProject } from '../core/machine.mjs';

// The final gate was supposed to include external falsification: if providers were
// detected but NO opinion succeeded, the pass rests on the internal verification alone.
// Not a rejection (verify.json binds), but it must be said DURABLY (commit body).
export function externalGateNote(gateDir, externals) {
  const ext = Array.isArray(externals) ? externals : [];
  if (!ext.length) return '';
  let arts = [];
  try {
    arts = readdirSync(gateDir)
      .filter((n) => /^external-verify-.+\.md$/i.test(n))
      .map((n) => {
        let text = '';
        try { text = readFileSync(join(gateDir, n), 'utf8'); } catch { /* unreadable = not ok */ }
        return { label: n.replace(/^external-verify-/i, '').replace(/\.md$/i, ''), text };
      });
  } catch { return ''; }
  const sum = summarizeExternalOpinions(arts);
  if (sum.ok > 0) return '';
  return sum.attempted === 0
    ? `no external falsification was recorded at the final gate (providers detected: ${ext.join(', ')}); the pass rests on the internal verification alone`
    : `external falsification unavailable at the final gate (0/${sum.attempted} opinions succeeded: ${sum.failed.join(', ')}); the pass rests on the internal verification alone`;
}

export function writeEscalation(paths, state, why) {
  try {
    const tail = renderHistory(readJournal(paths.gateDir), 12) || '(journal not readable)';
    let planText = '';
    try { planText = readFileSync(paths.planPath, 'utf8'); } catch { /* no plan */ }
    const t = state.lastTest;
    const test = t ? `\`${t.cmd}\` -> exit ${t.exitCode} (iteration ${t.iteration}, ${t.at})` : 'no run recorded';
    const doc = `# Escalation - a human is needed\n\n`
      + `The loop PAUSED itself: ${why}.\n\n`
      + `- when: ${shortTs()}\n`
      + `- task: ${state.task}\n`
      + `- phase at stop: ${state.phase}\n`
      + `- complexity: ${state.complexity}\n`
      + `- consecutive failed reviews: ${state.counters.retries}/${state.limits.maxRetries}\n`
      + `- failed final verifications: ${state.counters.finalFails}/${state.limits.maxRetries}\n`
      + `- iterations used: ${state.counters.iterations}/${state.limits.maxIterations}\n`
      + `- open steps in plan.md: ${countOpenSteps(planText)}\n`
      + `- last test: ${test}\n`
      + `- external models detected: ${(state.options.externals || []).join(', ') || 'none'}\n\n`
      + `## What to look at\n\n`
      + `- \`.omc-loop/plan.md\` - the steps and what is still open\n`
      + `- \`.omc-loop/notes.md\` - decisions and traps per step\n`
      + `- \`.omc-loop/external-*.md\` - diagnoses from external models, if any\n`
      + `- \`.omc-loop/journal.jsonl\` - every transition (last lines below; \`history\` verb renders it)\n\n`
      + `## How to resume\n\n`
      + `1. Fix the blocked point by hand (start from plan.md + notes.md).\n`
      + `2. Once solved, resume the loop with the \`resume\` verb (it resets the retry counters).\n`
      + `3. To give up, use the \`disarm\` verb.\n\n`
      + `## Last transitions\n\n\`\`\`\n${tail}\n\`\`\`\n`;
    writeFileSync(paths.escalationPath, doc);
  } catch { /* the hand-off is a bonus: never block the pause */ }
}

// env: { paths, holder: { state }, deadline, processEnv, out(json) }
export function executeEffects(effects, env) {
  const { paths, holder } = env;
  const processEnv = env.processEnv || process.env;
  let output = null;
  for (const e of effects) {
    switch (e.type) {
      case 'journal': appendJournal(paths.gateDir, e.entry); break;
      case 'saveState':
        try { writeFileSync(paths.statePath, JSON.stringify(holder.state, null, 2)); } catch { /* gate gone (archived) */ }
        break;
      case 'dropArtifact':
        try { rmSync(join(paths.gateDir, e.name), { force: true }); } catch { /* already gone */ }
        break;
      case 'notify': notify(e.title, e.message, { env: processEnv }); break;
      case 'writeEscalation': writeEscalation(paths, holder.state, e.why); break;
      case 'gitFinish': {
        const s = holder.state;
        const externalNote = externalGateNote(paths.gateDir, s.options.externals);
        const g = s.options.gitFinish === false
          ? { ran: false }
          : gitFinish(paths.cwd, { task: s.task, push: s.options.gitPush !== false, baselineDirty: s.baselineDirty, externalNote, deadline: env.deadline });
        const r = finishProject(s, g, { projectName: paths.projectName, externalNote, retry: e.retry === true });
        holder.state = r.state;
        const o = executeEffects(r.effects, env);
        if (o) output = o;
        break;
      }
      case 'archiveRun': {
        const r = archiveRun(paths.gateDir, { projectName: paths.projectName, state: holder.state, outcome: e.outcome, env: processEnv });
        if (!r.ok) appendJournal(paths.gateDir, { type: 'note', text: `archive failed: ${r.error}` });
        break;
      }
      case 'disarm':
        try { rmSync(paths.gateDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        break;
      case 'allowStop': break;
      case 'block': output = { decision: 'block', reason: e.reason }; break;
      default: appendJournal(paths.gateDir, { type: 'note', text: `unknown effect ${e.type}` });
    }
  }
  return output;
}

export { existsSync };
