// Executes the effects returned by the core, in order. The only place where the machine's
// decisions touch the filesystem, git, the desktop and stdout.
import { writeFileSync, rmSync, readFileSync, readdirSync, existsSync, renameSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendJournal, readJournal, renderHistory } from './journal.mjs';
import { notify } from './notify.mjs';
import { gitFinish } from './git.mjs';
import { archiveRun, archiveFailureNote, makeDormant } from './archive.mjs';
import { summarizeExternalOpinions, shortTs } from './util.mjs';
import { writeAtomic } from './activity.mjs';
import { writeDurable, UNSAVED_STATE } from './state-file.mjs';
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
      + `- \`.perseveranza/plan.md\` - the steps and what is still open\n`
      + `- \`.perseveranza/notes.md\` - decisions and traps per step\n`
      + `- \`.perseveranza/external-*.md\` - diagnoses from external models, if any\n`
      + `- \`.perseveranza/journal.jsonl\` - every transition (last lines below; \`history\` verb renders it)\n\n`
      + `## How to resume\n\n`
      + `1. Fix the blocked point by hand (start from plan.md + notes.md).\n`
      + `2. Once solved, the user resumes the loop: \`/pf resume\` in Claude Code, or the \`resume\` verb of the CLI from a terminal (it resets the retry counters). Claude cannot resume it with the \`perseveranza\` tool: a pause waits for a human.\n`
      + `3. To give up, use the \`disarm\` verb.\n\n`
      + `## Last transitions\n\n\`\`\`\n${tail}\n\`\`\`\n`;
    writeFileSync(paths.escalationPath, doc);
  } catch { /* the hand-off is a bonus: never block the pause */ }
}

// The state written (writeDurable: never a torn or emptied target, a pending copy when the
// last resort fails) and read back: a save that did not land whole is a failed save. A file
// that reads back as a LATER state (a higher rev: a verb saved right after, on top of this
// one) is a save that landed.
// write: (path, text) -> { ok, error } (a test may simulate a failure). -> { ok, error }
// the Stop's save: merged and attempted again this many times when another writer lands first
export const SAVE_ROUNDS = 3;

export function saveStateVerified(path, state, write = (p, t) => writeDurable(p, t, { keepPending: true })) {
  const text = JSON.stringify(state, null, 2);
  let r;
  try { r = write(path, text); } catch (e) { r = { ok: false, error: e && e.message }; }
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'write failed', conflict: !!(r && r.conflict) };
  let back = null;
  try { back = readFileSync(path, 'utf8'); } catch (e) { return { ok: false, error: `read back: ${e && e.code ? e.code : e && e.message}` }; }
  if (back === text) return { ok: true, error: null };
  try { const later = JSON.parse(back); if (Number(later.rev) > Number(state.rev)) return { ok: true, error: null, superseded: true }; } catch { /* torn */ }
  return { ok: false, error: 'read back: the file does not hold what was written' };
}

// env: { paths, holder: { state }, deadline, processEnv, io: { writeState, fs }, reconcile }
// reconcile(state) -> state: called right before each save (the Stop merges what a verb wrote
// since it read the state, and sets the next rev).
// After the run env.save is { attempted, ok, error }: whether the last saveState landed
// (verified). What depends on the save (the archive, the disarm; the Stop's removal of
// the inbox files) does not proceed on a failed one.
export function executeEffects(effects, env) {
  if (!env.save) env.save = { attempted: false, ok: true, error: null };
  const { paths, holder } = env;
  const processEnv = env.processEnv || process.env;
  let output = null;
  let archiveResult = null;
  for (const e of effects) {
    switch (e.type) {
      case 'journal': appendJournal(paths.gateDir, e.entry); break;
      case 'saveState': {
        // whole or not at all, and read back: a state that did not land is said, and nothing
        // that assumes it landed goes on
        // reconcile: merged with what a verb wrote meanwhile, and written only over the text
        // that merge read; when another writer came in between (a conflict), merged again
        const io = env.io || {};
        let r = null;
        for (let round = 0; round < SAVE_ROUNDS; round++) {
          let expect;
          if (typeof env.reconcile === 'function') {
            const m = env.reconcile(holder.state);
            if (m.abandon) { r = { ok: false, error: m.abandon, abandoned: true }; break; }
            holder.state = m.state;
            expect = m.expect;
          }
          r = saveStateVerified(paths.statePath, holder.state, io.writeState || ((p, t) => writeDurable(p, t, { fs: io.fs, keepPending: true, expect })));
          if (!r.conflict) break;
        }
        if (r.conflict) r = { ...r, error: `state.json changed under every attempt (${SAVE_ROUNDS})` };
        env.save = { attempted: true, ok: r.ok, error: r.error, abandoned: !!r.abandoned };
        if (r.ok && typeof env.saved === 'function') env.saved(holder.state);
        if (r.abandoned) { appendJournal(paths.gateDir, { type: 'state-save-skipped', why: String(r.error).slice(0, 300), phase: holder.state.phase }); break; }
        if (!r.ok) appendJournal(paths.gateDir, { type: 'state-save-failed', error: String(r.error).slice(0, 300), phase: holder.state.phase });
        break;
      }
      case 'dropArtifact':
        try { rmSync(join(paths.gateDir, e.name), { force: true }); } catch { /* already gone */ }
        break;
      case 'keepArtifact': {
        // consumed, not lost: review.json -> review-<n>.json (copy+delete when rename is refused)
        const from = join(paths.gateDir, e.name);
        const to = join(paths.gateDir, e.as);
        try { renameSync(from, to); } catch {
          try { copyFileSync(from, to); rmSync(from, { force: true }); } catch { /* keep the original rather than lose it */ }
        }
        break;
      }
      case 'writeArtifact':
        // a file the machine composed (the merged findings of a lens round): a plain name in
        // the gate, written whole or not at all, never a crash of the hook
        if (typeof e.name === 'string' && /^[\w.-]+$/.test(e.name) && typeof e.content === 'string') {
          try { writeAtomic(join(paths.gateDir, e.name), e.content); } catch { /* gate gone */ }
        } else appendJournal(paths.gateDir, { type: 'note', text: `writeArtifact refused: bad name ${JSON.stringify(e.name)}` });
        break;
      case 'notify': notify(e.title, [e.message, archiveResult && archiveFailureNote(archiveResult)].filter(Boolean).join(' · '), { env: processEnv }); break;
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
        // the final state must be on disk to be archived: when state.json refused it, a file of
        // its own beside it; when that fails too, no archive and no disarm (the next stop retries)
        // a save abandoned (the loop disarmed meanwhile, or another stop's state on disk): this
        // stop's final state is not the run's, nothing to archive or disarm
        if (env.save.abandoned) { archiveResult = { ok: false, error: `not archived: ${env.save.error}` }; appendJournal(paths.gateDir, { type: 'archive-skipped', why: archiveResult.error.slice(0, 300) }); break; }
        const asidePath = join(paths.gateDir, UNSAVED_STATE);
        // saved: a side file of an earlier failed attempt of this run is stale, not archived
        if (!env.save.attempted || env.save.ok) { try { rmSync(asidePath, { force: true }); } catch { /* left: the newer state.json wins on read */ } }
        if (env.save.attempted && !env.save.ok) {
          const io = env.io || {};
          const aside = saveStateVerified(asidePath, holder.state, io.writeState || ((p, t) => writeDurable(p, t, { fs: io.fs })));
          if (!aside.ok) {
            archiveResult = { ok: false, error: `final state not saved (${env.save.error}; state.unsaved.json: ${aside.error}): not archived, not disarmed` };
            appendJournal(paths.gateDir, { type: 'archive-skipped', why: archiveResult.error.slice(0, 300) });
            break;
          }
          appendJournal(paths.gateDir, { type: 'note', text: 'state.json refused the final state: archived with state.unsaved.json' });
        }
        archiveResult = archiveRun(paths.gateDir, { projectName: paths.projectName, state: holder.state, outcome: e.outcome, env: processEnv });
        break;
      }
      case 'disarm':
        if (archiveResult && !archiveResult.ok) break;
        try { rmSync(paths.gateDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        // a file held open kept part of the gate: nothing left in it may arm the loop again
        if (existsSync(paths.gateDir)) makeDormant(paths.gateDir);
        break;
      case 'allowStop': break;
      case 'block': output = { decision: 'block', reason: e.reason }; break;
      default: appendJournal(paths.gateDir, { type: 'note', text: `unknown effect ${e.type}` });
    }
  }
  return output;
}

export { existsSync };
