import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { project, cli, fire, readState, writePlan, writeArtifact, gate, addRemote, gitOut, patchState, requestIdFrom } from '../helpers/cli.mjs';
import { underLoop, dirtyBeyondLoop, porcelainPaths, workTreeFingerprint, treeFingerprints, gitFinish, LOOP_DIRS, VOLATILE_PATHS, volatilePaths } from '../../src/shell/git.mjs';
import { GATE_DIRNAME } from '../../src/shell/paths.mjs';
// oh-my-claudecode's state folder, by the one module that names it (src/shell/tool-state.mjs)
const T = VOLATILE_PATHS[0];
import { LEGACY_GATE_DIRNAME } from '../../src/shell/legacy.mjs';

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

test('the 2.x loop folder left in a migrated project and still written is not a code change', () => {
  const p = project({ git: true });
  const legacy = join(p.dir, LEGACY_GATE_DIRNAME);
  mkdirSync(legacy);
  writeFileSync(join(legacy, 'journal.jsonl'), '{"type":"fire"}\n');
  const before = treeFingerprints(p.dir);
  assert.ok(before.full && before.code);
  // written again (a 2.x watchdog still running): not ignored by git, still out of the snapshot
  appendFileSync(join(legacy, 'journal.jsonl'), '{"type":"watchdog"}\n');
  writeFileSync(join(legacy, 'state.json'), '{"phase":"implement"}');
  assert.deepEqual(treeFingerprints(p.dir), before);
  // tracked there too (committed by mistake in 2.x), then changed: still out
  gitOut(p, 'add', '-f', `${LEGACY_GATE_DIRNAME}/journal.jsonl`);
  gitOut(p, 'commit', '-q', '-m', 'old loop files');
  const committed = treeFingerprints(p.dir);
  appendFileSync(join(legacy, 'journal.jsonl'), '{"type":"fire"}\n');
  assert.deepEqual(treeFingerprints(p.dir), committed);
  // the control: real work changes it
  writeFileSync(join(p.dir, 'work.txt'), 'x');
  assert.notEqual(treeFingerprints(p.dir).full, committed.full);
  // the loop: a green test recorded, the 2.x folder written after it: the green still holds
  armGit(p, ['--no-git-finish', '--test', 'node -e 0']);
  assert.equal(cli(p, 'test').code, 0);
  appendFileSync(join(legacy, 'journal.jsonl'), '{"type":"watchdog"}\n');
  const again = cli(p, 'test', '--if-needed');
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /TEST GREEN already recorded for this exact tree/);
  // the same folder list everywhere: the fingerprint, underLoop and the git finish
  assert.deepEqual(LOOP_DIRS, [GATE_DIRNAME, LEGACY_GATE_DIRNAME]);
  assert.equal(underLoop(`${LEGACY_GATE_DIRNAME}/journal.jsonl`), true);
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
  const stopped = fire(p, {}, { PERSEVERANZA_HOOK_TIMEOUT_MS: '1000' });
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
  assert.equal(underLoop('.perseveranza/state.json'), true);
  assert.equal(underLoop('"\.perseveranza/x y.md"'.replace(/\\/g, '')), true);
  assert.equal(underLoop('src/perseveranza-helper.js'), false);
  assert.equal(dirtyBeyondLoop(' M .perseveranza/state.json\n'), false);
  assert.equal(dirtyBeyondLoop(' M .perseveranza/state.json\n M src/a.js\n'), true);
  assert.equal(dirtyBeyondLoop('R  .perseveranza/a -> src/b\n'), true);
  assert.deepEqual(porcelainPaths(' M a.js\n?? "b c.txt"\nR  x -> y\n M .perseveranza/z\n'), ['a.js', 'b c.txt', 'y']);
});

test('commit+push confirmed -> disarm, the commit is on the remote, .perseveranza never committed', () => {
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
  assert.ok(!gitOut(p, 'ls-tree', '-r', 'HEAD', '--name-only').includes('.perseveranza'));
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

test('a file named like the loop dir (src/perseveranza-helper.js) is real work and gets committed', () => {
  const p = project({ git: true });
  addRemote(p);
  armGit(p);
  spawnSync('node', ['-e', 'require("fs").mkdirSync("src");require("fs").writeFileSync("src/perseveranza-helper.js","x")'], { cwd: p.dir });
  toVerifyPass(p);
  const r = fire(p);
  assert.equal(r.state, null);
  assert.ok(gitOut(p, 'ls-tree', '-r', 'HEAD', '--name-only').includes('src/perseveranza-helper.js'));
  assert.ok(!existsSync(gate(p, '')));
});

// --- other tools' state (git.mjs VOLATILE_PATHS): a real run lost its verified pass to oh-my-claudecode's folder ---

test(`fingerprint: untracked tool state (${T}/, .claude volatile files) does not count, real work and tracked files there do`, () => {
  const p = project({ git: true });
  mkdirSync(join(p.dir, `${T}`, 'state', 'sessions', 's1'), { recursive: true });
  mkdirSync(join(p.dir, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(p.dir, '.claude', 'commands', 'deploy.md'), 'deploy\n');
  writeFileSync(join(p.dir, 'a.js'), 'export const a = 1;\n');
  const before = treeFingerprints(p.dir);
  assert.ok(before.full && before.code);
  // what oh-my-claudecode's hooks rewrite at every tool call, and Claude Code's own local files
  writeFileSync(join(p.dir, `${T}`, 'state', 'idle-notif-cooldown.json'), `{"at":${Date.now()}}`);
  writeFileSync(join(p.dir, `${T}`, 'state', 'sessions', 's1', 'pre-tool-advisory-throttle.json'), '{}');
  writeFileSync(join(p.dir, `${T}`, 'project-memory.json.lock'), String(process.pid));
  writeFileSync(join(p.dir, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Bash(ls)"]}}');
  writeFileSync(join(p.dir, '.claude', 'scheduled_tasks.lock'), 'x');
  assert.deepEqual(treeFingerprints(p.dir), before);
  // a sibling whose name only starts the same is real work (and so is the 2.x folder's name)
  writeFileSync(join(p.dir, `${T}x.js`), 'x');
  const sibling = treeFingerprints(p.dir);
  assert.notEqual(sibling.full, before.full);
  // the project's own .claude/ content is code (a .md: not in the code snapshot, in the full one)
  writeFileSync(join(p.dir, '.claude', 'commands', 'deploy.md'), 'deploy, changed\n');
  const command = treeFingerprints(p.dir);
  assert.notEqual(command.full, sibling.full);
  // a real file
  writeFileSync(join(p.dir, 'a.js'), 'export const a = 2;\n');
  assert.notEqual(treeFingerprints(p.dir).code, command.code);
  // tracked in that folder (a project that commits it): its changes count
  gitOut(p, 'add', '-f', `${T}/project-memory.json.lock`);
  gitOut(p, 'commit', '-q', '-m', 'tracked tool state');
  const committed = treeFingerprints(p.dir);
  writeFileSync(join(p.dir, `${T}`, 'project-memory.json.lock'), 'another');
  assert.notEqual(treeFingerprints(p.dir).full, committed.full);
  // back as committed, and an untracked file beside it rewritten: does not count
  writeFileSync(join(p.dir, `${T}`, 'project-memory.json.lock'), String(process.pid));
  writeFileSync(join(p.dir, `${T}`, 'state', 'idle-notif-cooldown.json'), '{"at":1}');
  assert.deepEqual(treeFingerprints(p.dir), committed);
});

test('fingerprint ignore list: PERSEVERANZA_FINGERPRINT_IGNORE and arm --ignore, validated', () => {
  const p = project({ git: true });
  mkdirSync(join(p.dir, 'scratch'), { recursive: true });
  const { paths, rejected } = volatilePaths({ env: { PERSEVERANZA_FINGERPRINT_IGNORE: ' scratch/ , .., *, /etc, C:/x' } });
  assert.deepEqual(paths, [...VOLATILE_PATHS, 'scratch']);
  assert.deepEqual(rejected, ['..', '*', '/etc', 'C:/x']);
  const before = treeFingerprints(p.dir, { volatile: paths });
  writeFileSync(join(p.dir, 'scratch', 'tmp.txt'), String(Date.now()));
  assert.deepEqual(treeFingerprints(p.dir, { volatile: paths }), before);
  assert.notEqual(treeFingerprints(p.dir).full, before.full, 'without the list it counts');
  // arm: refused when a path would leave the repository, or leave out everything
  for (const bad of ['..', '.', './', '*', '/tmp', 'a/../../b', ':(top)x']) {
    const r = cli(p, 'arm', 'task', '--external', 'off', '--ignore', bad);
    assert.notEqual(r.code, 0, `${bad}: ${r.out}`);
    assert.match(r.out, /Invalid --ignore/, bad);
  }
  const r = cli(p, 'arm', 'task', '--external', 'off', '--no-git-finish', '--test', 'node -e 0', '--ignore', 'scratch,build/out/', '--ignore', 'tmp');
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes(`Not the work (untracked files left out of the tree snapshot and of the final commit): ${[...VOLATILE_PATHS, 'scratch', 'build/out', 'tmp'].join(', ')}`), r.out);
  assert.deepEqual(readState(p).options.fingerprintIgnore, ['scratch', 'build/out', 'tmp']);
  // the test verb (and the Stop) read it from the state: a green test survives a write there
  assert.equal(cli(p, 'test').code, 0);
  writeFileSync(join(p.dir, 'scratch', 'tmp.txt'), 'rewritten');
  const again = cli(p, 'test', '--if-needed');
  assert.match(again.out, /TEST GREEN already recorded for this exact tree/, again.out);
  // the environment's entries refused are said at arm
  const q = project({ git: true });
  const said = cli({ ...q, env: { ...q.env, PERSEVERANZA_FINGERPRINT_IGNORE: '..,ok' } }, 'arm', 'task', '--external', 'off');
  assert.equal(said.code, 0, said.out);
  assert.match(said.out, /PERSEVERANZA_FINGERPRINT_IGNORE entries refused \(absolute, '\.\.', '\.', glob\): \.\./);
});

test(`a process rewriting ${T}/ between the green test and the final pass: the pass closes, ${T}/ is not committed`, async () => {
  const p = project({ git: true });
  armGit(p, ['--no-push', '--test', 'node -e 0']);
  writePlan(p, '- [x] one\n');
  writeFileSync(join(p.dir, 'sum.js'), 'export const sum = (a, b) => a + b;\n');
  mkdirSync(join(p.dir, `${T}`, 'state'), { recursive: true });
  // a stand-in for oh-my-claudecode's hooks: its state rewritten every 20 ms, the whole round
  const script = "const fs = require('fs'); const path = require('path'); let n = 0;"
    + " const tick = () => { n++; fs.writeFileSync(path.join(process.argv[1], 'state', 'idle-notif-cooldown.json'), JSON.stringify({ n, at: Date.now() })); };"
    + ' tick(); setInterval(tick, 20); setTimeout(() => process.exit(0), 60000);';
  const writer = spawn(process.execPath, ['-e', script, join(p.dir, `${T}`)], { stdio: 'ignore' });
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  try {
    await sleep(150);
    patchState(p, (s) => { s.phase = 'implement'; });
    assert.equal(cli(p, 'test').code, 0);
    assert.equal(cli(p, 'claim-done').code, 0);
    let r = fire(p); // -> cleanup
    assert.equal(r.state.phase, 'cleanup', r.reason);
    assert.match(cli(p, 'test', '--if-needed').out, /TEST GREEN already recorded/);
    r = fire(p); // -> final-verify
    assert.equal(r.state.phase, 'final-verify', r.reason);
    await sleep(150);
    writeArtifact(p, 'verify.json', { requestId: requestIdFrom(r.reason), pass: true });
    r = fire(p);
    assert.equal(r.state, null, `closed and disarmed, not pass-stale: ${r.reason}`);
  } finally { writer.kill(); }
  assert.equal(gitOut(p, 'ls-tree', '-r', 'HEAD', '--name-only'), 'README.md\nsum.js');
  assert.equal(gitOut(p, 'status', '--porcelain'), `?? ${T}/`);
});

test(`git finish: tracked files under ${T}/ are committed, untracked ones beside them are not`, () => {
  const p = project({ git: true });
  // the developer's global gitignore (which may well list .claude/settings.local.json) out of it
  gitOut(p, 'config', 'core.excludesFile', join(p.dir, '.git', 'no-global-excludes'));
  mkdirSync(join(p.dir, `${T}`), { recursive: true });
  writeFileSync(join(p.dir, `${T}`, 'shared.json'), '{"v":1}');
  gitOut(p, 'add', '-f', `${T}/shared.json`);
  gitOut(p, 'commit', '-q', '-m', 'shared tool config');
  armGit(p, ['--no-push']);
  writeFileSync(join(p.dir, 'work.txt'), 'done');
  writeFileSync(join(p.dir, `${T}`, 'shared.json'), '{"v":2}');
  writeFileSync(join(p.dir, `${T}`, 'volatile.json'), '{}');
  mkdirSync(join(p.dir, '.claude'), { recursive: true });
  writeFileSync(join(p.dir, '.claude', 'settings.local.json'), '{}');
  writeFileSync(join(p.dir, '.claude', 'agent.md'), 'an agent of the project');
  toVerifyPass(p);
  assert.equal(fire(p).state, null);
  const tree = gitOut(p, 'ls-tree', '-r', 'HEAD', '--name-only').split('\n');
  assert.deepEqual(tree.sort(), ['.claude/agent.md', `${T}/shared.json`, 'README.md', 'work.txt']);
  assert.equal(gitOut(p, 'show', `HEAD:${T}/shared.json`), '{"v":2}');
  assert.equal(gitOut(p, 'status', '--porcelain', '--untracked-files=all'), `?? .claude/settings.local.json\n?? ${T}/volatile.json`);
});

test(`git finish in a project that ignores .perseveranza/ and ${T}/ (the README\'s advice): confirmed`, () => {
  // 3.0.1: `git add -A -- . :(exclude).perseveranza` exits 1 when the folder is gitignored
  // ("The following paths are ignored"), and the closure was never confirmed
  const p = project({ git: true });
  writeFileSync(join(p.dir, '.gitignore'), `.perseveranza/\n${T}/\n.claude/settings.local.json\n`);
  gitOut(p, 'add', '.gitignore');
  gitOut(p, 'commit', '-q', '-m', 'ignore the loop');
  mkdirSync(join(p.dir, `${T}`), { recursive: true });
  writeFileSync(join(p.dir, `${T}`, 'state.json'), '{}');
  mkdirSync(join(p.dir, '.claude'), { recursive: true });
  writeFileSync(join(p.dir, '.claude', 'settings.local.json'), '{}');
  armGit(p, ['--no-push']);
  writeFileSync(join(p.dir, 'work.txt'), 'done');
  toVerifyPass(p);
  const r = fire(p);
  assert.equal(r.state, null, r.reason);
  assert.equal(gitOut(p, 'ls-tree', '-r', 'HEAD', '--name-only'), '.gitignore\nREADME.md\nwork.txt');
  assert.equal(gitOut(p, 'status', '--porcelain'), '');
});
