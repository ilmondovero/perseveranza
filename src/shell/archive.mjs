// The runs archive: ~/.perseveranza/runs/<project>/<timestamp>/ keeps a finished run's
// .omc-loop/ (journal, plan, notes, external opinions, escalation) plus a summary.json.
// On failure retain the gate locally and rename its state so the Stop hook is dormant.
import { existsSync, mkdirSync, mkdtempSync, renameSync, cpSync, rmSync, unlinkSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runsDir } from './paths.mjs';
import { readJournal, appendJournal } from './journal.mjs';
import { tokensSpent } from '../core/budget.mjs';

const safe = (s) => String(s).replace(/[^a-z0-9._-]/gi, '_').slice(0, 60) || 'project';
export const RETAINED_STATE = 'state.disarmed.json';

export function archiveFailureNote(result) {
  if (result.ok) return '';
  return `Archive failed: ${result.error}. Artifacts retained in ${result.retainedDir}. `
    + `${result.disarmed ? 'Loop disarmed' : 'Could not disarm the loop'}; fix the archive destination and retry disarm.`;
}

export function buildSummary(state, journal, outcome) {
  const transitions = journal.filter((j) => j.type === 'transition');
  const tests = journal.filter((j) => j.type === 'test');
  const verdicts = journal.filter((j) => j.type === 'verdict');
  const asks = journal.filter((j) => j.type === 'ask');
  return {
    task: state?.task ?? '',
    outcome,
    phaseAtEnd: state?.phase ?? null,
    complexity: state?.complexity ?? null,
    iterations: state?.counters?.iterations ?? 0,
    tokens: tokensSpent(state?.usage),
    usage: state?.usage ?? null,
    retriesAtEnd: state?.counters?.retries ?? 0,
    finalFails: state?.counters?.finalFails ?? 0,
    transitions: transitions.length,
    tests: tests.map((t) => ({ exitCode: t.exitCode, iteration: t.iteration, ts: t.ts })),
    verdicts: verdicts.map((v) => ({ artifact: v.artifact, blocking: v.blocking, pass: v.pass, error: v.error || null, ts: v.ts })),
    externalOpinions: asks.map((a) => ({ provider: a.provider, model: a.model || null, slot: a.slot, ok: a.ok })),
    externals: state?.options?.externals ?? [],
    armedAt: state?.armedAt ?? null,
    finishedAt: new Date().toISOString(),
    engineVersion: state?.engineVersion ?? null,
  };
}

// -> { ok: true, dir } | { ok: false, error, retainedDir, disarmed }
export function archiveRun(gateDir, { projectName, state, outcome, env = process.env } = {}) {
  try {
    if (!existsSync(gateDir)) throw new Error('gate missing');
    let summary = buildSummary(state, readJournal(gateDir), outcome);
    // A retry keeps the original outcome (done/killed/budget), not "disarmed".
    if (existsSync(join(gateDir, RETAINED_STATE))) {
      try {
        const saved = JSON.parse(readFileSync(join(gateDir, 'summary.json'), 'utf8'));
        if (saved && typeof saved.outcome === 'string') summary = saved;
      } catch { /* the original summary was unavailable */ }
    }
    writeFileSync(join(gateDir, 'summary.json'), JSON.stringify(summary, null, 2));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const projectDir = join(runsDir(env), safe(projectName));
    mkdirSync(projectDir, { recursive: true });
    const dir = mkdtempSync(join(projectDir, `${stamp}-`));
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
    const target = join(dir, 'omc-loop');
    try { renameSync(gateDir, target); }
    catch (e) {
      if (e.code !== 'EXDEV') throw e;
      // An interrupted copy must not appear as a completed run in runs list.
      unlinkSync(join(dir, 'summary.json'));
      cpSync(gateDir, target, { recursive: true, errorOnExist: true, force: false });
      writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
      rmSync(gateDir, { recursive: true, force: true });
    }
    return { ok: true, dir };
  } catch (e) {
    const statePath = join(gateDir, 'state.json');
    const retained = join(gateDir, RETAINED_STATE);
    let error = e.message;
    try {
      if (existsSync(statePath)) {
        if (existsSync(retained)) throw new Error(`${RETAINED_STATE} already exists`);
        renameSync(statePath, retained);
      }
    } catch (failure) { error += `; retaining state: ${failure.message}`; }
    const result = { ok: false, error, retainedDir: gateDir, disarmed: !existsSync(statePath) };
    appendJournal(gateDir, { type: 'note', text: archiveFailureNote(result) });
    return result;
  }
}

export function listRuns(env = process.env) {
  const base = runsDir(env);
  if (!existsSync(base)) return [];
  const out = [];
  for (const proj of readdirSync(base)) {
    const pd = join(base, proj);
    if (!statSync(pd).isDirectory()) continue;
    for (const stamp of readdirSync(pd)) {
      const rd = join(pd, stamp);
      if (!statSync(rd).isDirectory()) continue;
      let summary = null;
      try { summary = JSON.parse(readFileSync(join(rd, 'summary.json'), 'utf8')); } catch { /* no summary */ }
      if (!summary || !existsSync(join(rd, 'omc-loop'))) continue;
      out.push({ id: `${proj}/${stamp}`, project: proj, stamp, dir: rd, summary });
    }
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
}

export function readRun(id, env = process.env) {
  return listRuns(env).find((r) => r.id === id || r.stamp === id) || null;
}
