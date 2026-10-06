// src/shell/legacy-hashes.mjs, the table install.mjs trusts to delete what earlier installs left:
// every hash in it must be one git says a past installer copied, and every such hash must be in
// it. Recomputed here from the history (scripts/legacy-hashes.mjs), so it needs a clone with its
// full history (in CI: actions/checkout with fetch-depth: 0); a copy of the sources without git
// has no history to check against, and the test says so instead of passing quietly on the table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../../src/shell/paths.mjs';
import { LEGACY_HASHES } from '../../src/shell/legacy.mjs';
import { computeLegacyHashes, tableModule, TABLE_MODULE, LEGACY_ANCHORS } from '../../scripts/legacy-hashes.mjs';

// the first commit of the repository: its install.ps1 is the oldest installer
const ROOT_COMMIT = '6d83420';

test('the table of the earlier installs is exactly what git says they copied, hash for hash', async () => {
  const git = existsSync(join(ROOT, '.git'));
  assert.ok(git, `${ROOT} is not a git clone: the table cannot be checked against the history (run the tests from a clone)`);
  const root = spawnSync('git', ['cat-file', '-e', `${ROOT_COMMIT}^{commit}`], { cwd: ROOT });
  assert.equal(root.status, 0, `the history is incomplete (commit ${ROOT_COMMIT} is missing): a shallow clone? In CI, actions/checkout needs fetch-depth: 0`);
  const table = await computeLegacyHashes(ROOT);
  assert.ok(table, 'git answered');
  assert.deepEqual(LEGACY_HASHES, table, 'regenerate it: node scripts/legacy-hashes.mjs --write');
  // and the module is the one the script writes, byte for byte
  assert.equal(readFileSync(TABLE_MODULE, 'utf8'), tableModule(table));
});

test('the table depends on the releases only, not on the other refs of the clone (a branch with another installer and agent changes nothing)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'prs-legacy-'));
  try {
    const git = (...a) => { const r = spawnSync('git', a, { cwd: d, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout; };
    git('clone', '-q', '--no-checkout', ROOT, '.');
    git('checkout', '-q', '-b', 'not-a-release', LEGACY_ANCHORS[0]);
    writeFileSync(join(d, 'agents', 'pf-verifier.md'), 'an agent of a branch that is no release\n');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', 'not a release');
    assert.deepEqual(await computeLegacyHashes(d), LEGACY_HASHES, 'the same table');
    const all = await computeLegacyHashes(d, ['--all']);
    assert.notDeepEqual(all, LEGACY_HASHES, 'walking every ref would have taken the branch in');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the table covers every kind of earlier install: the first installers, 1.x, 2.x (with its CLI), their commands', () => {
  const keys = Object.keys(LEGACY_HASHES.files);
  for (const k of ['hooks/loop-drive.ps1', 'hooks/loop-drive.mjs', 'hooks/statusline.mjs', 'hooks/util.mjs', 'agents/pf-verifier.md', 'perseveranza/.claude-plugin/plugin.json', 'perseveranza/src/shell/stop.mjs']) assert.ok(keys.includes(k), k);
  assert.ok(keys.some((k) => /^perseveranza\/src\/cli\/o[m]c-loop\.mjs$/.test(k)), 'the 2.x CLI');
  for (const form of ['verbatim', 'v1-cli', 'v2-root']) assert.ok(LEGACY_HASHES.commands[form].length > 0, form);
  for (const list of [...Object.values(LEGACY_HASHES.files), ...Object.values(LEGACY_HASHES.commands)]) for (const h of list) assert.match(h, /^[0-9a-f]{64}$/);
});
