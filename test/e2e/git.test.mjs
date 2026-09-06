import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, cli, fire, readState, writePlan, writeArtifact, gate, addRemote, gitOut, patchState } from '../helpers/cli.mjs';
import { underLoop, dirtyBeyondLoop, porcelainPaths, workTreeFingerprint, gitFinish } from '../../src/shell/git.mjs';

test('fingerprint detects edits to existing untracked files, including Unicode names', () => {
  const p = project({ git: true });
  const file = join(p.dir, 'novità file.txt');
  writeFileSync(file, 'before');
  const before = workTreeFingerprint(p.dir);
  assert.ok(before);
  writeFileSync(file, 'after!');
  assert.notEqual(workTreeFingerprint(p.dir), before);
});

test('fingerprint detects successive binary edits and changes committed after testing', () => {
  const p = project({ git: true });
  const file = join(p.dir, 'binary.dat');
  writeFileSync(file, Buffer.from([0, 1, 2]));
  gitOut(p, 'add', 'binary.dat');
  gitOut(p, 'commit', '-qm', 'binary');
  const clean = workTreeFingerprint(p.dir);
  writeFileSync(file, Buffer.from([0, 3, 4]));
  const edited = workTreeFingerprint(p.dir);
  writeFileSync(file, Buffer.from([0, 5, 6]));
  assert.notEqual(workTreeFingerprint(p.dir), edited);
  gitOut(p, 'add', 'binary.dat');
  gitOut(p, 'commit', '-qm', 'changed');
  assert.notEqual(workTreeFingerprint(p.dir), clean);
});

test('fingerprint works before the first commit and ignores loop artifacts', () => {
  const p = project();
  gitOut(p, 'init', '-q');
  writeFileSync(join(p.dir, 'new.txt'), 'before');
  gitOut(p, 'add', 'new.txt');
  const before = workTreeFingerprint(p.dir);
  assert.ok(before);
  mkdirSync(gate(p, ''));
  writeArtifact(p, 'review.json', { blocking: 0 });
  assert.equal(workTreeFingerprint(p.dir), before);
  writeFileSync(join(p.dir, 'new.txt'), 'after!');
  assert.notEqual(workTreeFingerprint(p.dir), before);
});

test('an expired git deadline cannot be mistaken for a non-git project', () => {
  const p = project({ git: true });
  writeFileSync(join(p.dir, 'pending.txt'), 'pending');
  const result = gitFinish(p.dir, { deadline: Date.now() - 1 });
  assert.equal(result.ran, true);
  assert.equal(result.confirmed, false);
  assert.ok(gitOut(p, 'status', '--porcelain').includes('pending.txt'));
  armGit(p);
  toVerifyPass(p);
  const stopped = fire(p, {}, { OMC_HOOK_TIMEOUT_MS: '1000' });
  assert.equal(stopped.state.phase, 'git-finish');
  assert.equal(stopped.state.signals.paused, true);
  assert.equal(gitOut(p, 'log', '-1', '--pretty=%s'), 'init');
});

test('the real hook rejects changes to a file that was already untracked at the green test', () => {
  const p = project({ git: true });
  armGit(p, ['--no-git-finish', '--test', 'node -e 0']);
  writePlan(p, '- [x] done\n');
  patchState(p, (s) => { s.phase = 'implement'; });
  const file = join(p.dir, 'new.txt');
  writeFileSync(file, 'tested');
  assert.equal(cli(p, 'test').code, 0);
  writeFileSync(file, 'broken');
  assert.equal(cli(p, 'claim-done').code, 0);
  const result = fire(p);
  assert.equal(result.blocked, true);
  assert.ok(result.reason.includes('stale'), result.reason);
  assert.equal(result.state.phase, 'implement');
});

function armGit(p, extra = []) {
  const r = cli(p, 'arm', 'git task', '--external', 'off', ...extra);
  if (r.code !== 0) throw new Error(r.out);
}
// drive a fresh loop straight to a passing final verification
function toVerifyPass(p) {
  writePlan(p, '- [x] a\n');
  patchState(p, (s) => { s.phase = 'final-verify'; s.flags.cleanedOnce = true; });
  writeArtifact(p, 'verify.json', { pass: true });
}

test('pure helpers: underLoop by prefix, dirtyBeyondLoop, porcelainPaths', () => {
  assert.equal(underLoop('.omc-loop/state.json'), true);
  assert.equal(underLoop('"\\.omc-loop/x y.md"'.replace(/\\/g, '')), true);
  assert.equal(underLoop('src/omc-loop-helper.js'), false);
  assert.equal(dirtyBeyondLoop(' M .omc-loop/state.json\n'), false);
  assert.equal(dirtyBeyondLoop(' M .omc-loop/state.json\n M src/a.js\n'), true);
  assert.equal(dirtyBeyondLoop('R  .omc-loop/a -> src/b\n'), true);
  assert.deepEqual(porcelainPaths(' M a.js\n?? "b c.txt"\nR  x -> y\n M .omc-loop/z\n'), ['a.js', 'b c.txt', 'y']);
});

test('commit+push confirmed -> disarm, the commit is on the remote, .omc-loop never committed', () => {
  const p = project({ git: true });
  addRemote(p);
  armGit(p);
  writeFileSync(join(p.dir, 'work.txt'), 'done');
  toVerifyPass(p);
  const r = fire(p);
  assert.equal(r.blocked, false);
  assert.equal(r.state, null);
  assert.ok(gitOut(p, 'log', '-1', '--pretty=%s').startsWith('perseveranza: git task'));
  assert.equal(gitOut(p, 'rev-list', '--count', '@{u}..HEAD'), '0');
  assert.equal(gitOut(p, 'status', '--porcelain'), '');
  assert.ok(!gitOut(p, 'ls-tree', '-r', 'HEAD', '--name-only').includes('.omc-loop'));
  assert.ok(cli(p, 'runs').out.includes('done'));
});

test('no upstream -> paused in git-finish, not disarmed; resume retries and confirms', () => {
  const p = project({ git: true });
  armGit(p);
  writeFileSync(join(p.dir, 'work.txt'), 'done');
  toVerifyPass(p);
  const r = fire(p);
  assert.equal(r.blocked, false);
  assert.equal(r.state.phase, 'git-finish');
  assert.equal(r.state.signals.paused, true);
  assert.ok(gitOut(p, 'log', '-1', '--pretty=%s').startsWith('perseveranza:'), 'committed locally anyway');
  addRemote(p);
  cli(p, 'resume');
  const r2 = fire(p);
  assert.equal(r2.state, null, 'closure confirmed on retry');
});

test('--no-push with an upstream -> local commit, disarm, nothing pushed', () => {
  const p = project({ git: true });
  addRemote(p);
  armGit(p, ['--no-push']);
  writeFileSync(join(p.dir, 'work.txt'), 'done');
  toVerifyPass(p);
  const r = fire(p);
  assert.equal(r.state, null);
  assert.equal(gitOut(p, 'rev-list', '--count', '@{u}..HEAD'), '1');
});

test('local closure creates the first commit without including loop artifacts', () => {
  const p = project();
  gitOut(p, 'init', '-q');
  gitOut(p, 'config', 'user.email', 'test@example.invalid');
  gitOut(p, 'config', 'user.name', 'test');
  gitOut(p, 'config', 'commit.gpgsign', 'false');
  armGit(p, ['--no-push']);
  writeFileSync(join(p.dir, 'first.txt'), 'done');
  toVerifyPass(p);
  assert.equal(fire(p).state, null);
  assert.equal(gitOut(p, 'ls-tree', '-r', 'HEAD', '--name-only'), 'first.txt');
});

test('--no-git-finish -> no commit at all, still done', () => {
  const p = project({ git: true });
  armGit(p, ['--no-git-finish']);
  writeFileSync(join(p.dir, 'work.txt'), 'done');
  toVerifyPass(p);
  const r = fire(p);
  assert.equal(r.state, null);
  assert.equal(gitOut(p, 'log', '-1', '--pretty=%s'), 'init');
});

test('baseline-dirty and the missing external opinion are written into the commit body', () => {
  const p = project({ git: true });
  addRemote(p);
  writeFileSync(join(p.dir, 'pre.txt'), 'dirty before arm');
  armGit(p);
  assert.deepEqual(readState(p).baselineDirty, ['pre.txt']);
  patchState(p, (s) => { s.options.externals = ['codex']; });
  writeFileSync(gate(p, 'external-verify-codex.md'), '# External opinion - codex\n\n- slot: verify\n- status: ERROR\n');
  writeFileSync(join(p.dir, 'work.txt'), 'done');
  toVerifyPass(p);
  fire(p);
  const body = gitOut(p, 'log', '-1', '--pretty=%B');
  assert.ok(body.includes('already modified before the task'));
  assert.ok(body.includes('pre.txt'));
  assert.ok(body.includes('0/1 opinions succeeded: codex'));
});

test('a successful external opinion leaves no note; provider detected but nothing recorded -> "not recorded" note', () => {
  const p = project({ git: true });
  addRemote(p);
  armGit(p);
  patchState(p, (s) => { s.options.externals = ['codex']; });
  writeFileSync(gate(p, 'external-verify-codex.md'), '- status: ok\n');
  writeFileSync(join(p.dir, 'work.txt'), 'x');
  toVerifyPass(p);
  fire(p);
  assert.ok(!gitOut(p, 'log', '-1', '--pretty=%B').includes('perseveranza note'));
  const q = project({ git: true });
  addRemote(q);
  armGit(q);
  patchState(q, (s) => { s.options.externals = ['codex']; });
  writeFileSync(join(q.dir, 'work.txt'), 'x');
  toVerifyPass(q);
  fire(q);
  assert.ok(gitOut(q, 'log', '-1', '--pretty=%B').includes('no external falsification was recorded'));
});

test('a file named like the loop dir (src/omc-loop-helper.js) is real work and gets committed', () => {
  const p = project({ git: true });
  addRemote(p);
  armGit(p);
  spawnSync('node', ['-e', 'require("fs").mkdirSync("src");require("fs").writeFileSync("src/omc-loop-helper.js","x")'], { cwd: p.dir });
  toVerifyPass(p);
  const r = fire(p);
  assert.equal(r.state, null);
  assert.ok(gitOut(p, 'ls-tree', '-r', 'HEAD', '--name-only').includes('src/omc-loop-helper.js'));
  assert.ok(!existsSync(gate(p, '')));
});
