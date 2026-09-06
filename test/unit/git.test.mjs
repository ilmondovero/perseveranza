import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitFinish } from '../../src/shell/git.mjs';

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
    ['status --porcelain', error],
    ['status --porcelain', { status: null, error: { code: 'ETIMEDOUT', message: 'timed out' } }],
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
  for (const command of ['add -A -- . :(exclude).omc-loop', 'reset -q -- .omc-loop']) {
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
