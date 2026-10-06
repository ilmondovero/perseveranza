// The runs archive: ~/.perseveranza/runs/<project>/<timestamp>/ keeps a finished run's
// .perseveranza/ as loop/ (journal, plan, notes, external opinions, escalation) plus a
// summary.json. Runs archived by 2.x (another folder name, legacy.mjs) are listed too.
// On failure retain the gate locally and rename its state so the Stop hook is dormant.
import { existsSync, mkdirSync, mkdtempSync, renameSync, cpSync, rmSync, unlinkSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runsDir, ARCHIVE_GATE_DIRNAME } from './paths.mjs';
import { archivedGateDir } from './legacy.mjs';
import { readJournal, appendJournal } from './journal.mjs';
import { tokensSpent } from '../core/budget.mjs';

const safe = (s) => String(s).replace(/[^a-z0-9._-]/gi, '_').slice(0, 60) || 'project';
export const RETAINED_STATE = 'state.disarmed.json';
// Written in a gate that could not be removed whole after its run was archived or disarmed (a
// file held open by a sync client or an antivirus): its state copies must not arm it again
// (state-file.mjs never promotes a pending copy beside it). `arm` removes it.
export const DISARMED_MARK = 'state.disarmed.mark';
const STATE_COPY = /^state\.json(\.pending|\.\d+\.[0-9a-f]+\.tmp)?$/;

// After a disarm: whatever is left of the gate can never arm the loop again. The state and
// its copies (pending, temporaries) are removed; one that a lock keeps gets the mark beside it.
// rm, write: for the tests. -> { dormant, marked, left: [names still there] }
export function makeDormant(gateDir, { rm = rmSync, write = writeFileSync } = {}) {
  const copies = () => { try { return readdirSync(gateDir).filter((n) => STATE_COPY.test(n)); } catch { return []; } };
  for (const n of copies()) { try { rm(join(gateDir, n), { force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* locked: marked below */ } }
  const left = copies();
  let marked = false;
  // state.json itself still there: the loop is NOT disarmed, and a mark beside a live state
  // would only disable its crash recovery. Said (dormant: false), not marked.
  if (left.length && !left.includes('state.json')) {
    try { write(join(gateDir, DISARMED_MARK), JSON.stringify({ at: new Date().toISOString(), left }, null, 2)); marked = true; } catch { /* nothing else to try */ }
  }
  return { dormant: !left.includes('state.json') && (!left.length || marked), marked, left };
}

// rename() cannot move the gate: across volumes (EXDEV) or, on Windows, while an indexer,
// an antivirus or a sync client (Google Drive, OneDrive) holds a file inside it open
// (EPERM/EBUSY/EACCES). Both fall back to copy + remove; the lock kinds get a few retries first.
const COPY_FALLBACK = new Set(['EXDEV', 'EPERM', 'EBUSY', 'EACCES']);
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRIES = 3;
const RENAME_RETRY_MS = 150;
const RM_OPTS = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 };
const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait */ } };

function moveGate(gateDir, target, rename = renameSync) {
  for (let attempt = 0; ; attempt++) {
    try { rename(gateDir, target); return; }
    catch (e) {
      if (!COPY_FALLBACK.has(e.code)) throw e;
      if (LOCK_CODES.has(e.code) && attempt < RENAME_RETRIES) { sleep(RENAME_RETRY_MS); continue; }
      return e;
    }
  }
}

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
  const gaps = journal.filter((j) => j.type === 'gap');
  const alerts = journal.filter((j) => j.type === 'watchdog');
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
    tests: tests.map((t) => ({ exitCode: t.exitCode, iteration: t.iteration, via: t.via || 'shell', ts: t.ts })),
    // the verbs that signalled the loop, and who ran them: the mod's tool, the /pf
    // command, or a shell (the CLI through Bash or a terminal)
    verbs: journal.filter((j) => j.type === 'signal').map((g) => ({ verb: g.verb, value: g.value || '', via: g.via || 'shell', ts: g.ts })),
    verdicts: verdicts.map((v) => ({ artifact: v.artifact, blocking: v.blocking, pass: v.pass, error: v.error || null, ts: v.ts })),
    externalOpinions: asks.map((a) => ({ provider: a.provider, model: a.model || null, slot: a.slot, ok: a.ok })),
    // silences longer than the stale threshold between two fires (the loop looked alive, was not)
    gaps: gaps.map((g) => ({ since: g.since, ms: g.ms, paused: g.paused === true, ts: g.ts })),
    // the watchdog spoke: the loop was silent beyond the threshold while it was armed
    watchdogAlerts: alerts.map((a) => ({ action: a.action || 'alerted', silentMs: a.silentMs, seenAt: a.seenAt, via: a.via, phase: a.phase, pending: a.activity && Array.isArray(a.activity.pending) ? a.activity.pending.map((d) => d.agent) : [], notified: a.notified === true, ts: a.ts })),
    lastFireAt: state?.owner?.lastFireAt ? new Date(state.owner.lastFireAt).toISOString() : null,
    externals: state?.options?.externals ?? [],
    armedAt: state?.armedAt ?? null,
    finishedAt: new Date().toISOString(),
    engineVersion: state?.engineVersion ?? null,
  };
}

// -> { ok: true, dir, leftover? } | { ok: false, error, retainedDir, disarmed }
// leftover: the archive is complete but locked originals could not be removed; state.json
// is gone so the hook stays dormant and `arm` can proceed.
// io: { rename, rm } for the tests (a gate that a sync client keeps from moving or going)
export function archiveRun(gateDir, { projectName, state, outcome, env = process.env, io = {} } = {}) {
  const rename = io.rename || renameSync;
  const rm = io.rm || rmSync;
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
    const target = join(dir, ARCHIVE_GATE_DIRNAME);
    if (moveGate(gateDir, target, rename)) {
      // An interrupted copy must not appear as a completed run in runs list.
      unlinkSync(join(dir, 'summary.json'));
      try { cpSync(gateDir, target, { recursive: true, errorOnExist: true, force: false }); }
      catch (copyErr) {
        try { rmSync(dir, RM_OPTS); } catch { /* the partial copy stays as garbage */ }
        throw copyErr;
      }
      writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
      try { rm(gateDir, RM_OPTS); }
      catch (rmErr) {
        // Archived completely, originals locked: at least make the leftover gate dormant, with
        // no copy of the state (a pending copy, a temporary) that could arm it again
        makeDormant(gateDir, { rm });
        if (existsSync(join(gateDir, 'state.json'))) {
          try { rmSync(dir, RM_OPTS); } catch { /* would duplicate on retry: best-effort */ }
          throw rmErr;
        }
        return { ok: true, dir, leftover: gateDir };
      }
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
      const gateDir = summary ? archivedGateDir(rd, ARCHIVE_GATE_DIRNAME) : null;
      if (!gateDir) continue;
      out.push({ id: `${proj}/${stamp}`, project: proj, stamp, dir: rd, gateDir, summary });
    }
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
}

export function readRun(id, env = process.env) {
  return listRuns(env).find((r) => r.id === id || r.stamp === id) || null;
}
