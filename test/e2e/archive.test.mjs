import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { project, arm, cli, fire, gate, writePlan, patchState, writeArtifact } from '../helpers/cli.mjs';
import { listRuns, RETAINED_STATE } from '../../src/shell/archive.mjs';

for (const outcome of ['done', 'budget-iterations', 'killed', 'corrupt-state', 'disarmed']) {
  test(`archive failure preserves ${outcome} run, disarms it and supports recovery`, () => {
    const p = project();
    arm(p, 'keep this task');
    writePlan(p, '- [x] precious plan\n');
    writeFileSync(gate(p, 'notes.md'), 'irreplaceable notes');
    const archiveBlocker = join(p.home, 'runs');
    writeFileSync(archiveBlocker, 'file blocks the archive directory');
    if (outcome === 'done') {
      patchState(p, (s) => { s.phase = 'final-verify'; });
      writeArtifact(p, 'verify.json', { pass: true });
    } else if (outcome === 'budget-iterations') {
      patchState(p, (s) => { s.phase = 'implement'; s.counters.iterations = s.limits.maxIterations; });
    } else if (outcome === 'killed') writeFileSync(gate(p, 'STOP'), '');
    else if (outcome === 'corrupt-state') writeFileSync(gate(p, 'state.json'), '{broken JSON');
    if (outcome === 'disarmed') {
      const r = cli(p, 'disarm');
      assert.equal(r.code, 1);
      assert.ok(r.out.includes('Artifacts retained'), r.out);
    } else assert.equal(fire(p).blocked, false);
    assert.equal(existsSync(gate(p, 'state.json')), false);
    assert.equal(existsSync(gate(p, RETAINED_STATE)), true);
    assert.ok(cli(p, 'status').out.includes('artifacts retained'));
    assert.equal(readFileSync(gate(p, 'notes.md'), 'utf8'), 'irreplaceable notes');
    assert.equal(readFileSync(gate(p, 'plan.md'), 'utf8'), '- [x] precious plan\n');
    const journal = readFileSync(gate(p, 'journal.jsonl'), 'utf8');
    assert.ok(journal.includes('Archive failed'));
    assert.equal(fire(p).raw, '');
    assert.equal(readFileSync(gate(p, 'journal.jsonl'), 'utf8'), journal, 'dormant hook leaves recovery data alone');
    assert.equal(cli(p, 'arm', 'overwrite', '--force', '--external', 'off').code, 1);
    assert.equal(cli(p, 'disarm').code, 1, 'failed retries still preserve artifacts');
    unlinkSync(archiveBlocker);
    assert.equal(cli(p, 'disarm').code, 0);
    assert.equal(existsSync(gate(p, '')), false);
    const runs = listRuns(p.env);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].summary.outcome, outcome);
    assert.equal(readFileSync(join(runs[0].dir, 'omc-loop', 'notes.md'), 'utf8'), 'irreplaceable notes');
    assert.equal(cli(p, 'arm', 'next task', '--external', 'off').code, 0);
  });
}
