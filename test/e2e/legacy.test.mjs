// 3.0 renamed the loop folder, the archive folder and the environment variables. The old names
// live in src/shell/legacy.mjs only: what is left of a 2.x run is pointed out, never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, arm, cli, fire, gate, writePlan, freshDir } from '../helpers/cli.mjs';
import { GATE_DIRNAME, ARCHIVE_GATE_DIRNAME, samePath, realPathOr } from '../../src/shell/paths.mjs';
import { LEGACY_GATE_DIRNAME, LEGACY_ARCHIVE_DIRNAME, LEGACY_ENV, legacyRun, archivedGateDir, printable } from '../../src/shell/legacy.mjs';
import { listRuns } from '../../src/shell/archive.mjs';
import { gitFinish } from '../../src/shell/git.mjs';

// Every file under dir with its bytes and mtime: equal before and after = nothing written.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) { out[`${relative(dir, p)}/`] = 'dir'; walk(p); } else out[relative(dir, p)] = `${st.mtimeMs}:${readFileSync(p, 'base64')}`;
    }
  };
  walk(dir);
  return out;
}

// A 2.x run left in the project: 'armed' (state.json) or 'retained' (archive failed).
function legacyGate(p, kind = 'armed', task = 'old 2.x task') {
  const dir = join(p.dir, LEGACY_GATE_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const state = JSON.stringify({ schemaVersion: 2, task, phase: 'implement' });
  if (kind === 'armed') writeFileSync(join(dir, 'state.json'), state);
  if (kind === 'retained') writeFileSync(join(dir, 'state.disarmed.json'), state);
  writeFileSync(join(dir, 'plan.md'), '- [ ] old step\n');
  writeFileSync(join(dir, 'journal.jsonl'), '{"type":"arm"}\n');
  return dir;
}

test('the names: .perseveranza in the project, loop/ in the archive, and the old ones differ', () => {
  assert.equal(GATE_DIRNAME, '.perseveranza');
  assert.equal(ARCHIVE_GATE_DIRNAME, 'loop');
  assert.notEqual(LEGACY_GATE_DIRNAME, GATE_DIRNAME);
  assert.notEqual(LEGACY_ARCHIVE_DIRNAME, ARCHIVE_GATE_DIRNAME);
  const p = project();
  arm(p, 'named task');
  assert.ok(existsSync(join(p.dir, '.perseveranza', 'state.json')), 'arm writes .perseveranza/state.json');
  assert.equal(existsSync(join(p.dir, LEGACY_GATE_DIRNAME)), false);
});

test('a fresh project: arm, a Stop, status and disarm use .perseveranza and never create the old folder', () => {
  const p = project();
  arm(p, 'clean run');
  writePlan(p, '- [ ] one\n');
  const f = fire(p);
  assert.equal(f.blocked, true, f.raw);
  assert.ok(f.reason.includes('.perseveranza/plan.md'), f.reason);
  const st = cli(p, 'status');
  assert.equal(st.code, 0, st.out);
  assert.ok(!st.out.includes(LEGACY_GATE_DIRNAME), st.out);
  assert.equal(cli(p, 'disarm').code, 0);
  assert.equal(existsSync(gate(p, '')), false, 'disarm archives .perseveranza away');
  assert.equal(existsSync(join(p.dir, LEGACY_GATE_DIRNAME)), false);
  const runs = listRuns(p.env);
  assert.equal(runs.length, 1);
  assert.ok(existsSync(join(runs[0].dir, ARCHIVE_GATE_DIRNAME, 'plan.md')), 'archived as loop/');
  assert.equal(existsSync(join(runs[0].dir, LEGACY_ARCHIVE_DIRNAME)), false);
});

test('a 2.x loop still armed: arm and status point it out, how to close it, and leave it untouched', () => {
  const p = project();
  const old = legacyGate(p, 'armed');
  const before = snapshot(old);
  const st0 = cli(p, 'status');
  assert.equal(st0.code, 1, 'not armed: 3.0 does not drive the old run');
  assert.ok(st0.out.includes(`A loop armed by perseveranza 2.x is still in ${LEGACY_GATE_DIRNAME}/ (task: old 2.x task)`), st0.out);
  assert.ok(st0.out.includes(`delete ${LEGACY_GATE_DIRNAME}/ yourself`), st0.out);
  const a = arm(p, 'new task');
  assert.ok(a.out.includes(`still in ${LEGACY_GATE_DIRNAME}/`), a.out);
  assert.ok(a.out.includes('perseveranza ARMED'), 'arm proceeds: the notice does not block');
  const st1 = cli(p, 'status');
  assert.equal(st1.code, 0, st1.out);
  assert.ok(st1.out.includes('perseveranza ARMED — new task') && st1.out.includes(`still in ${LEGACY_GATE_DIRNAME}/`), st1.out);
  // the whole new run beside it: Stops, disarm (archive) never read, move or delete it
  writePlan(p, '- [ ] one\n');
  assert.equal(fire(p).blocked, true);
  assert.equal(cli(p, 'disarm').code, 0);
  assert.deepEqual(snapshot(old), before, 'not one byte of the old folder written');
  assert.equal(listRuns(p.env).length, 1, 'only the 3.0 run archived');
  assert.ok(legacyRun(p.dir), 'still there, still reported');
});

test('a 2.x run retained after an archive failure is reported as such; inert leftovers are not', () => {
  const p = project();
  const old = legacyGate(p, 'retained', 'kept run');
  const before = snapshot(old);
  const st = cli(p, 'status');
  assert.ok(st.out.includes(`A perseveranza 2.x run is retained in ${LEGACY_GATE_DIRNAME}/ after an archive failure (task: kept run)`), st.out);
  assert.deepEqual(snapshot(old), before);
  const q = project();
  mkdirSync(join(q.dir, LEGACY_GATE_DIRNAME));
  writeFileSync(join(q.dir, LEGACY_GATE_DIRNAME, 'notes.md'), 'leftover');
  assert.equal(legacyRun(q.dir), null);
  assert.ok(!cli(q, 'status').out.includes(LEGACY_GATE_DIRNAME));
  assert.ok(!arm(q).out.includes(LEGACY_GATE_DIRNAME));
});

test('the task of a 2.x state is printed on one line: no escape sequence, control character or line break reaches the terminal', () => {
  const hostile = 'fix\u001b[2J\u001b[31m it\u001b]0;pwned title\u0007 now\nline two\r\nthree\u2028four\u009b\u0000\u0008 end\u001b]8;;http://x\u001b\\link';
  assert.equal(printable(hostile), 'fix it now line two three four end link');
  assert.equal(printable('plain task'), 'plain task', 'an ordinary task is untouched');
  assert.equal(printable('caffè — ünïcode ✓'), 'caffè — ünïcode ✓', 'printable text beyond ASCII stays');
  const p = project();
  legacyGate(p, 'armed', hostile);
  assert.equal(legacyRun(p.dir).task, 'fix it now line two three four end link');
  for (const out of [cli(p, 'status').out, arm(p, 'new task').out, cli(p, 'status').out]) {
    const line = out.split('\n').find((l) => l.includes(`still in ${LEGACY_GATE_DIRNAME}/`));
    assert.ok(line && line.includes('(task: fix it now line two three four end link).'), out);
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(out), `no control character in: ${JSON.stringify(out)}`);
    assert.ok(!out.includes('line two\n') && !out.includes('pwned title\u0007'), out);
  }
});

test('an unreadable 2.x state is still reported, without the task', () => {
  const p = project();
  mkdirSync(join(p.dir, LEGACY_GATE_DIRNAME));
  writeFileSync(join(p.dir, LEGACY_GATE_DIRNAME, 'state.json'), '{broken');
  const out = cli(p, 'status').out;
  assert.ok(out.includes(`still in ${LEGACY_GATE_DIRNAME}/.`), out);
});

test('runs lists and shows the runs 2.x archived, read-only, beside the 3.0 ones', () => {
  const p = project();
  const old = join(p.home, 'runs', 'proj', '2026-01-01T00-00-00-000Z');
  mkdirSync(join(old, LEGACY_ARCHIVE_DIRNAME), { recursive: true });
  writeFileSync(join(old, 'summary.json'), JSON.stringify({ outcome: 'done', task: 'archived by 2.x', iterations: 4 }));
  writeFileSync(join(old, LEGACY_ARCHIVE_DIRNAME, 'plan.md'), '- [x] old archived step\n');
  writeFileSync(join(old, LEGACY_ARCHIVE_DIRNAME, 'journal.jsonl'), `${JSON.stringify({ at: '2026-01-01T00:00:00.000Z', type: 'arm', task: 'archived by 2.x' })}\n`);
  const before = snapshot(old);
  arm(p, 'fresh run');
  assert.equal(cli(p, 'disarm').code, 0);
  const list = cli(p, 'runs');
  assert.equal(list.code, 0, list.out);
  assert.ok(list.out.includes('archived by 2.x') && list.out.includes('fresh run'), list.out);
  const show = cli(p, 'runs', 'show', '2026-01-01T00-00-00-000Z');
  assert.equal(show.code, 0, show.out);
  assert.ok(show.out.includes('old archived step'), show.out);
  assert.ok(show.out.includes('arm'), 'the journal is read from the old folder');
  assert.deepEqual(snapshot(old), before, 'read-only');
  assert.equal(archivedGateDir(old, ARCHIVE_GATE_DIRNAME), join(old, LEGACY_ARCHIVE_DIRNAME));
  // a run dir with neither folder is not a run
  const empty = join(p.home, 'runs', 'proj', 'not-a-run');
  mkdirSync(empty);
  writeFileSync(join(empty, 'summary.json'), '{}');
  assert.equal(archivedGateDir(empty, ARCHIVE_GATE_DIRNAME), null);
  assert.equal(listRuns(p.env).length, 2);
});

test('an old environment variable is named with its new name and NOT read (no silent fallback)', () => {
  const p = project();
  const [oldModel, newModel] = LEGACY_ENV.find(([, n]) => n === 'PERSEVERANZA_ADVISOR_MODEL');
  const old = { ...p, env: { ...p.env, [oldModel]: 'haiku' } };
  const a = arm(old, 'env task');
  assert.ok(a.out.includes(`Ignored since 3.0 (renamed): ${oldModel} -> ${newModel}.`), a.out);
  assert.ok(a.out.includes('Internal advisor: on (model opus'), 'the old variable has no effect');
  assert.ok(cli(old, 'status').out.includes(`${oldModel} -> ${newModel}`));
  const q = project();
  const fresh = { ...q, env: { ...q.env, [newModel]: 'haiku' } };
  const b = arm(fresh, 'env task');
  assert.ok(b.out.includes('Internal advisor: on (model haiku'), b.out);
  assert.ok(!b.out.includes('Ignored since 3.0'), b.out);
});

test('the old kill switch does not stop a 3.0 loop; the new one does', () => {
  const [oldKill, newKill] = LEGACY_ENV.find(([, n]) => n === 'PERSEVERANZA_KILL');
  const p = project();
  arm(p);
  writePlan(p, '- [ ] one\n');
  assert.equal(fire(p, {}, { [oldKill]: '1' }).blocked, true, 'still armed');
  assert.ok(existsSync(gate(p, 'state.json')));
  assert.equal(fire(p, {}, { [newKill]: '1' }).blocked, false);
  assert.equal(existsSync(gate(p, 'state.json')), false, 'disarmed by the new name');
});

test('arm refuses a directory whose loop folder would be the perseveranza home', () => {
  const dir = freshDir('prs-homeproj-');
  const p = project();
  const homeLike = { ...p, dir, env: { ...p.env, PERSEVERANZA_HOME: join(dir, GATE_DIRNAME) } };
  mkdirSync(join(dir, GATE_DIRNAME));
  writeFileSync(join(dir, GATE_DIRNAME, 'config.json'), '{}');
  const r = cli(homeLike, 'arm', 'task', '--external', 'off');
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('holds the perseveranza config and the runs archive'), r.out);
  assert.equal(existsSync(join(dir, GATE_DIRNAME, 'state.json')), false);
  assert.equal(readFileSync(join(dir, GATE_DIRNAME, 'config.json'), 'utf8'), '{}');
});

// The same folder under another name: a link (a junction on Windows) in the path of the home or
// of the project, the way macOS reaches its temp folders (/var -> /private/var). Compared as
// strings the two names differed and arm went ahead in the home.
test('arm refuses the perseveranza home reached under another name: through a link, existing or not yet made', () => {
  const p = project();
  const refused = (dir, homeAt, label) => {
    const r = cli({ ...p, dir, env: { ...p.env, PERSEVERANZA_HOME: homeAt } }, 'arm', 'task', '--external', 'off');
    assert.equal(r.code, 1, `${label}: ${r.out}`);
    assert.ok(r.out.includes('holds the perseveranza config and the runs archive'), `${label}: ${r.out}`);
  };
  const real = freshDir('prs-homeproj-');
  const link = join(freshDir('prs-homelink-'), 'via');
  symlinkSync(real, link, 'junction');
  mkdirSync(join(real, GATE_DIRNAME));
  writeFileSync(join(real, GATE_DIRNAME, 'config.json'), '{}');
  refused(real, join(link, GATE_DIRNAME), 'the home named through the link');
  refused(link, join(real, GATE_DIRNAME), 'the project entered through the link');
  assert.equal(existsSync(join(real, GATE_DIRNAME, 'state.json')), false);
  assert.equal(readFileSync(join(real, GATE_DIRNAME, 'config.json'), 'utf8'), '{}');
  // the home not made yet: the part of the path that exists is resolved
  const bare = freshDir('prs-homeproj-');
  const bareLink = join(freshDir('prs-homelink-'), 'via');
  symlinkSync(bare, bareLink, 'junction');
  refused(bare, join(bareLink, GATE_DIRNAME), 'a home still to be made');
  assert.equal(existsSync(join(bare, GATE_DIRNAME, 'state.json')), false);
  // a different folder is not the home, link or not
  const other = freshDir('prs-homeproj-');
  const r = cli({ ...p, dir: other, env: { ...p.env, PERSEVERANZA_HOME: join(link, GATE_DIRNAME) } }, 'arm', 'task', '--external', 'off', '--no-git-finish');
  assert.equal(r.code, 0, r.out);
});

test('samePath: one folder under two names, never two folders under one', () => {
  const real = freshDir('prs-same-');
  const link = join(freshDir('prs-samelink-'), 'via');
  symlinkSync(real, link, 'junction');
  mkdirSync(join(real, 'a'));
  assert.equal(samePath(real, link), true);
  assert.equal(samePath(join(link, 'a'), join(real, 'a', '')), true);
  assert.equal(samePath(join(link, 'missing', 'x'), join(real, 'missing', 'x')), true, 'not there: by the real path of what exists');
  assert.equal(realPathOr(join(link, 'a', 'missing', 'x')), join(realpathSync(real), 'a', 'missing', 'x'), 'the missing tail kept in order');
  assert.equal(samePath(join(real, 'a'), real), false);
  assert.equal(samePath(join(link, 'a'), join(real, 'b')), false);
  assert.equal(samePath('/X/y', '/x/y', 'win32'), true, 'Windows ignores case');
  if (process.platform !== 'win32') assert.equal(samePath('/no-such-root/X', '/no-such-root/x', 'linux'), false);
});

test('the end-of-project commit never sweeps a leftover old folder into the repository', () => {
  const p = project({ git: true });
  legacyGate(p, 'armed');
  mkdirSync(gate(p, ''), { recursive: true });
  writeFileSync(gate(p, 'state.json'), '{}');
  writeFileSync(join(p.dir, 'work.txt'), 'real work\n');
  const r = gitFinish(p.dir, { task: 'legacy', push: false });
  assert.equal(r.committed, true, JSON.stringify(r));
  const tree = spawnSync('git', ['ls-tree', '-r', 'HEAD', '--name-only'], { cwd: p.dir, encoding: 'utf8' }).stdout;
  assert.ok(tree.includes('work.txt'));
  assert.ok(!tree.includes(LEGACY_GATE_DIRNAME) && !tree.includes(GATE_DIRNAME), tree);
});
