import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { project, gate, writeState } from '../helpers/cli.mjs';
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
  assert.equal(fs.readFileSync(join(runs[0].dir, 'omc-loop', 'notes.md'), 'utf8'), 'precious notes');
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
