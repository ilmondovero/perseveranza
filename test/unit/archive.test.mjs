import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { project, gate, writeState } from '../helpers/cli.mjs';
import { ARCHIVE_GATE_DIRNAME } from '../../src/shell/paths.mjs';
import { defaultState } from '../../src/core/state.mjs';
import { archiveRun, listRuns, RETAINED_STATE } from '../../src/shell/archive.mjs';

// rename() refused: across volumes (EXDEV) or, on Windows, by a lock held by an indexer,
// an antivirus or a sync client (EPERM). Both must fall back to copy + remove.
for (const [code, copyFails] of [['EXDEV', false], ['EXDEV', true], ['EPERM', false], ['EBUSY', false]]) {
  test(`archive with rename refused (${code}) ${copyFails ? 'retains originals on partial copy failure' : 'preserves all artifacts before removing originals'}`, (t) => {
    const p = project();
    const state = defaultState({ task: 'cross-volume' });
    writeState(p, state);
    fs.writeFileSync(gate(p, 'notes.md'), 'precious notes');
    const rename = fs.renameSync;
    const copy = fs.cpSync;
    let target;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (from === gate(p, '')) {
        target = to;
        throw Object.assign(new Error('rename refused'), { code });
      }
      return rename(from, to);
    });
    t.mock.method(fs, 'cpSync', (from, to, options) => {
      if (copyFails) {
        fs.mkdirSync(to);
        fs.writeFileSync(join(to, 'partial.txt'), 'partial copy');
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return copy(from, to, options);
    });
    syncBuiltinESMExports();
    let result;
    try { result = archiveRun(gate(p, ''), { projectName: 'p', state, outcome: 'done', env: p.env }); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.equal(result.ok, !copyFails);
    assert.equal(listRuns(p.env).length, copyFails ? 0 : 1, 'incomplete copies are not published as archived runs');
    if (copyFails) {
      assert.equal(fs.readFileSync(gate(p, 'notes.md'), 'utf8'), 'precious notes');
      assert.equal(fs.existsSync(gate(p, RETAINED_STATE)), true);
      assert.equal(fs.existsSync(gate(p, 'state.json')), false);
    } else {
      assert.equal(fs.existsSync(gate(p, '')), false);
      assert.equal(fs.readFileSync(join(target, 'notes.md'), 'utf8'), 'precious notes');
    }
  });
}

test('archive with locked originals after a complete copy is published once and leaves a dormant gate', (t) => {
  const p = project();
  const state = defaultState({ task: 'locked-originals' });
  writeState(p, state);
  fs.writeFileSync(gate(p, 'notes.md'), 'precious notes');
  const rename = fs.renameSync;
  const rm = fs.rmSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === gate(p, '')) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return rename(from, to);
  });
  // the recursive removal of the gate fails (a file inside is still open), single files can go
  t.mock.method(fs, 'rmSync', (path, options) => {
    if (path === gate(p, '') && options && options.recursive) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return rm(path, options);
  });
  syncBuiltinESMExports();
  let result;
  try { result = archiveRun(gate(p, ''), { projectName: 'p', state, outcome: 'done', env: p.env }); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(result.ok, true);
  assert.equal(result.leftover, gate(p, ''));
  const runs = listRuns(p.env);
  assert.equal(runs.length, 1);
  assert.equal(fs.readFileSync(join(runs[0].dir, ARCHIVE_GATE_DIRNAME, 'notes.md'), 'utf8'), 'precious notes');
  assert.equal(fs.existsSync(gate(p, 'state.json')), false, 'the leftover gate must be dormant');
  assert.equal(fs.existsSync(gate(p, RETAINED_STATE)), false, 'nothing to recover: the archive is complete');
});

test('archive with rename refused for another reason fails and retains the run', (t) => {
  const p = project();
  const state = defaultState({ task: 'other-error' });
  writeState(p, state);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === gate(p, '')) throw Object.assign(new Error('read-only'), { code: 'EROFS' });
    return rename(from, to);
  });
  syncBuiltinESMExports();
  let result;
  try { result = archiveRun(gate(p, ''), { projectName: 'p', state, outcome: 'done', env: p.env }); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(result.ok, false);
  assert.equal(listRuns(p.env).length, 0);
  assert.equal(fs.existsSync(gate(p, RETAINED_STATE)), true);
});

// A budget stop is not a failed verification: the summary says how the last final verification
// went (a real 3.0.1 run: pass at iteration 7, voided as pass-stale by other tools' state, then
// 8/6 iterations).
test('summary: the last final verification and an outcome note for a budget stop', async () => {
  const { buildSummary, lastFinalVerify, outcomeNote } = await import('../../src/shell/archive.mjs');
  const J = [
    { type: 'transition', from: 'cleanup', to: 'final-verify', outcome: 'always', ts: 't1' },
    { type: 'verdict', artifact: 'verify.json', pass: true, ts: 't2' },
    { type: 'transition', from: 'final-verify', to: 'implement', outcome: 'pass-stale', gate: 'code-changed', ts: 't3' },
    { type: 'budget', reason: 'iterations', detail: '8/6 iterations', ts: 't4' },
  ];
  assert.deepEqual(lastFinalVerify(J), { outcome: 'pass-stale', pass: true, stale: 'code-changed', ts: 't3' });
  const s = buildSummary(defaultState({ task: 't' }), J, 'budget-iterations');
  assert.equal(s.outcome, 'budget-iterations');
  assert.equal(s.outcomeNote, 'stopped by the iterations budget (8/6 iterations); last final verification: pass (stale: code-changed): the work passed, the pass did not cover the tree at the stop, nothing was committed');
  assert.deepEqual(s.finalVerify, lastFinalVerify(J));
  // a rejection, no verification at all, a pass that went on: each said as it was
  const rejected = [J[0], { type: 'transition', from: 'final-verify', to: 'implement', outcome: 'fail', ts: 't3' }, J[3]];
  assert.match(outcomeNote('budget-iterations', rejected), /last final verification: rejected \(fail\)$/);
  assert.equal(outcomeNote('budget-tokens', [{ type: 'budget', reason: 'tokens', detail: '9/8 tokens' }]), 'stopped by the tokens budget (9/8 tokens), before any final verification');
  assert.match(outcomeNote('budget-iterations', [J[0], { type: 'transition', from: 'final-verify', to: 'git-finish', outcome: 'pass' }]), /last final verification: pass$/);
  // the adaptive budget line is not the stop's
  assert.equal(outcomeNote('budget-iterations', [{ type: 'budget', adaptive: true, steps: 2, maxIterations: 14 }]), 'stopped by the iterations budget, before any final verification');
  // a run that ended otherwise has no note; a subagent-running wait inside final-verify is not its end
  assert.equal(outcomeNote('done', J), null);
  assert.equal(buildSummary(defaultState(), J, 'done').outcomeNote, undefined);
  assert.equal(lastFinalVerify([J[0], { type: 'transition', from: 'final-verify', to: 'final-verify', outcome: 'subagent-running' }]), null);
});
