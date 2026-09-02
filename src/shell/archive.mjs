// The runs archive: ~/.perseveranza/runs/<project>/<timestamp>/ keeps a finished run's
// .omc-loop/ (journal, plan, notes, external opinions, escalation) plus a summary.json.
// Best-effort: a failure here never blocks the closure (the caller disarms anyway).
import { existsSync, mkdirSync, renameSync, cpSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runsDir } from './paths.mjs';
import { readJournal } from './journal.mjs';
import { tokensSpent } from '../core/budget.mjs';

const safe = (s) => String(s).replace(/[^a-z0-9._-]/gi, '_').slice(0, 60) || 'project';

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

// -> { ok: true, dir } | { ok: false, error }
export function archiveRun(gateDir, { projectName, state, outcome, env = process.env } = {}) {
  try {
    if (!existsSync(gateDir)) return { ok: false, error: 'gate missing' };
    const summary = buildSummary(state, readJournal(gateDir), outcome);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = join(runsDir(env), safe(projectName), stamp);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(gateDir, 'summary.json'), JSON.stringify(summary, null, 2));
    const target = join(dir, 'omc-loop');
    try { renameSync(gateDir, target); }
    catch { cpSync(gateDir, target, { recursive: true }); rmSync(gateDir, { recursive: true, force: true }); }
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, error: e.message };
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
      out.push({ id: `${proj}/${stamp}`, project: proj, stamp, dir: rd, summary });
    }
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
}

export function readRun(id, env = process.env) {
  return listRuns(env).find((r) => r.id === id || r.stamp === id) || null;
}
