import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { project, gate, writeState } from '../helpers/cli.mjs';
import { defaultState } from '../../src/core/state.mjs';
import { archiveRun, listRuns, RETAINED_STATE } from '../../src/shell/archive.mjs';

for (const copyFails of [false, true]) {
  test(`archive across volumes ${copyFails ? 'retains originals on partial copy failure' : 'preserves all artifacts before removing originals'}`, (t) => {
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
        throw Object.assign(new Error('different device'), { code: 'EXDEV' });
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
