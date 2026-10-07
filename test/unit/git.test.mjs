import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitFinish, dirtyBeyondLoop, porcelainPaths, VOLATILE_PATHS } from '../../src/shell/git.mjs';
import { GATE_DIRNAME } from '../../src/shell/paths.mjs';
import { LEGACY_GATE_DIRNAME } from '../../src/shell/legacy.mjs';

const STATUS = 'status --porcelain --untracked-files=all';
// oh-my-claudecode's state folder, by the one module that names it (src/shell/tool-state.mjs)
const T = VOLATILE_PATHS[0];
// the listings gitFinish makes before the add: what is loose (untracked, not ignored) under the loop
// folders and the volatile paths, what is tracked under the volatile paths
const LOOSE = `ls-files --others --exclude-standard -z -- ${[GATE_DIRNAME, LEGACY_GATE_DIRNAME, ...VOLATILE_PATHS].map((p) => `:(literal)${p}`).join(' ')}`;
const TRACKED = `ls-files -z -- ${VOLATILE_PATHS.map((p) => `:(literal)${p}`).join(' ')}`;
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const error = { status: 128, stdout: '', stderr: 'fatal: read failed' };

function fixture(overrides = {}) {
  const calls = [];
  const spawn = (_cmd, args) => {
    const key = args.join(' ');
    calls.push(key);
    if (Object.hasOwn(overrides, key)) return overrides[key];
    if (key === 'rev-parse --is-inside-work-tree') return ok('true\n');
    if (key === 'rev-parse --verify HEAD') return ok('abc123\n');
    if (key === 'rev-parse --abbrev-ref --symbolic-full-name @{u}') return ok('origin/main\n');
    if (key === 'rev-list --count @{u}..HEAD') return ok('0\n');
    return ok();
  };
  return { spawn, calls };
}

test('git closure requires successful status and ahead queries', () => {
  for (const [command, response] of [
    [STATUS, error],
    [STATUS, { status: null, error: { code: 'ETIMEDOUT', message: 'timed out' } }],
    ['rev-list --count @{u}..HEAD', error],
    ['rev-list --count @{u}..HEAD', ok('')],
    ['rev-list --count @{u}..HEAD', ok('invalid')],
    ['rev-parse --verify HEAD', error],
    ['push', error],
  ]) {
    const f = fixture({ [command]: response });
    const result = gitFinish('.', { spawn: f.spawn });
    assert.equal(result.ran, true);
    assert.equal(result.confirmed, false, command);
  }
});

test('git closure stops before commit if staging or loop exclusion fails', () => {
  // both loop folders are kept out: the 3.0 one and a leftover 2.x one
  for (const command of ['add -A -- .', `reset -q -- ${GATE_DIRNAME} ${LEGACY_GATE_DIRNAME}`, LOOSE, TRACKED]) {
    const f = fixture({ [command]: error });
    assert.equal(gitFinish('.', { spawn: f.spawn }).confirmed, false);
    assert.ok(!f.calls.some((call) => call.startsWith('commit ')));
    assert.ok(!f.calls.includes('push'));
  }
});

test('git closure distinguishes non-repositories from unavailable git', () => {
  const outside = fixture({ 'rev-parse --is-inside-work-tree': { ...error, stderr: 'fatal: not a git repository (or any of the parent directories): .git' } });
  assert.deepEqual(gitFinish('.', { spawn: outside.spawn }), { ran: false });
  const unavailable = fixture({ 'rev-parse --is-inside-work-tree': { status: null, error: { code: 'ENOENT', message: 'git not found' } } });
  assert.equal(gitFinish('.', { spawn: unavailable.spawn }).confirmed, false);
});

test('git closure confirms successful checks and permits local-only closure', () => {
  assert.equal(gitFinish('.', { spawn: fixture().spawn }).confirmed, true);
  const f = fixture({ 'rev-list --count @{u}..HEAD': ok('2\n') });
  const result = gitFinish('.', { spawn: f.spawn, push: false });
  assert.equal(result.confirmed, true);
  assert.equal(result.ahead, 2);
  assert.ok(!f.calls.includes('push'));
});

test('git closure reports why the commit failed, not just that it did', () => {
  for (const push of [true, false]) {
    const f = fixture({ [STATUS]: ok(' M src/app.mjs\n') });
    const spawn = (cmd, args) => (args[0] === 'commit'
      ? { status: 128, stdout: '', stderr: 'Author identity unknown\n\n*** Please tell me who you are.\nfatal: unable to auto-detect email address\n' }
      : f.spawn(cmd, args));
    const result = gitFinish('.', { spawn, push });
    assert.equal(result.confirmed, false);
    assert.ok(result.error.includes('unable to auto-detect email address'), result.error);
    assert.ok(!f.calls.includes('push'));
  }
  // a clean-looking commit that still leaves the tree dirty keeps the generic wording
  const dirty = fixture({ [STATUS]: ok(' M src/app.mjs\n') });
  assert.ok(gitFinish('.', { spawn: dirty.spawn }).error.startsWith('commit did not happen'));
});

// Other tools' state (git.mjs VOLATILE_PATHS): untracked there is not the work, tracked there is.
test('volatile paths: an untracked file there is not dirt nor baseline, a tracked change there is', () => {
  const vol = VOLATILE_PATHS;
  assert.equal(dirtyBeyondLoop(`?? ${T}/\n`, vol), false);
  assert.equal(dirtyBeyondLoop(`?? ${T}/state/idle-notif-cooldown.json\n?? .claude/settings.local.json\n?? .claude/scheduled_tasks.lock\n`, vol), false);
  // tracked and changed: counts
  assert.equal(dirtyBeyondLoop(` M ${T}/project-memory.json\n`, vol), true);
  // a project's own .claude/ content is code
  assert.equal(dirtyBeyondLoop('?? .claude/commands/deploy.md\n', vol), true);
  // a name that only starts like one is not under it
  assert.equal(dirtyBeyondLoop(`?? ${T}x/a.js\n`, vol), true);
  // without the list (the 3.0.1 behaviour), everything counts
  assert.equal(dirtyBeyondLoop(`?? ${T}/\n`), true);
  assert.deepEqual(porcelainPaths(`?? ${T}/\n M a.js\n M ${T}/tracked.json\n?? "b c.txt"\n`, vol), ['a.js', `${T}/tracked.json`, 'b c.txt']);
});

test('git finish: a loop folder or a volatile path is excluded only where a loose file is (git refuses to exclude an ignored path)', () => {
  // the loop folder ignored by the project (the README's advice) and nothing loose anywhere: a plain add
  const ignored = fixture({ [STATUS]: ok('') });
  assert.equal(gitFinish('.', { spawn: ignored.spawn, push: false }).confirmed, true);
  assert.ok(ignored.calls.includes('add -A -- .'), ignored.calls.join('\n'));
  assert.ok(!ignored.calls.some((c) => c.startsWith('add -u')));
  // loose files in the loop folder and in the tool-state folder, and a volatile file in .claude/: those three excluded
  const loose = fixture({ [LOOSE]: ok(`.perseveranza/state.json\0${T}/state/x.json\0.claude/settings.local.json\0`), [STATUS]: ok(`?? ${T}/state/x.json\n?? .claude/settings.local.json\n`) });
  const r = gitFinish('.', { spawn: loose.spawn, push: false });
  assert.equal(r.confirmed, true, JSON.stringify(r));
  assert.ok(loose.calls.includes(`add -A -- . :(exclude,literal)${GATE_DIRNAME} :(exclude,literal)${T} :(exclude,literal).claude/settings.local.json`), loose.calls.join('\n'));
  // one tracked under the tool-state folder: only that path is updated
  const tracked = fixture({ [TRACKED]: ok(`${T}/project-memory.json\0`) });
  assert.equal(gitFinish('.', { spawn: tracked.spawn, push: false }).confirmed, true);
  assert.ok(tracked.calls.includes(`add -u -- :(literal)${T}`), tracked.calls.join('\n'));
  // the update fails: not confirmed, nothing committed
  const upd = fixture({ [TRACKED]: ok(`${T}/a\0`), [`add -u -- :(literal)${T}`]: error });
  assert.equal(gitFinish('.', { spawn: upd.spawn }).confirmed, false);
  assert.ok(!upd.calls.some((c) => c.startsWith('commit ')));
  // an empty volatile list (the 3.0.1 set): only the loop folders are listed, nothing tracked is
  const plain = fixture();
  gitFinish('.', { spawn: plain.spawn, volatile: [] });
  assert.ok(plain.calls.includes(`ls-files --others --exclude-standard -z -- :(literal)${GATE_DIRNAME} :(literal)${LEGACY_GATE_DIRNAME}`), plain.calls.join('\n'));
  assert.ok(!plain.calls.some((c) => c.startsWith('ls-files -z')));
});

