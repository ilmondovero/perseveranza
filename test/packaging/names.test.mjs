// 3.0 renamed what carried the name of another tool: the loop folder (.perseveranza), the CLI
// (src/cli/perseveranza.mjs), the environment variables (PERSEVERANZA_*). These tests keep the
// rename whole: the new names are read, the old ones only by src/shell/legacy.mjs, and the
// repository mentions the old prefix only where history or migration needs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../../src/shell/paths.mjs';
import { CLI_ENTRY, RUNTIME_FILES } from '../../manifest.mjs';
import { LEGACY_ENV, LEGACY_CLI_ENTRY } from '../../src/shell/legacy.mjs';

const LEGACY_MODULE = 'src/shell/legacy.mjs';
// Written with a character class so that this file does not match itself.
const OLD_PREFIX = /o[m]c/i;
// The only tracked files allowed to contain it, and why:
//   CHANGELOG.md          the history, and the 3.0.0 migration table
//   src/shell/legacy.mjs  the one module that knows the old names
//   src/shell/legacy-hashes.mjs  its table, generated from git: the paths earlier installs wrote
//   .gitignore            the local state of another tool, ignored in this repository
//   src/shell/tool-state.mjs  the same tool's state folder in a user's project, left out of the
//                         work tree's fingerprint (3.0.2): the code and the tests name it from there
//   the dated docs below  records of their time; each opens with the 3.0.0 note
const HISTORICAL_DOCS = ['docs/CODE-REVIEW-2026-09-05.md', 'docs/SEGNALAZIONE-2026-09-07-loop-orfano.md', 'docs/PIANO-V2.md', 'docs/REVIEW-NOTES.md'];
const ALLOWED = new Set(['CHANGELOG.md', LEGACY_MODULE, 'src/shell/legacy-hashes.mjs', '.gitignore', 'src/shell/tool-state.mjs', ...HISTORICAL_DOCS]);
const KEPT_ENV = ['PERSEVERANZA_HOME', 'PERSEVERANZA_LANG'];
// new in 3.0 and not a setting: the mod sets it for the CLI it runs (src/cli/perseveranza.mjs
// journals the verbs as `via: 'tool'` or 'command'); no 2.x name, nothing to document
const INTERNAL_ENV = ['PERSEVERANZA_VIA'];
// new in 3.0, settings with no 2.x name, documented in both READMEs: how long a Stop waits for a
// pf-* subagent still at work (stop-core.mjs subagentWaitMs), and the node the mod runs
// (hooks/lib/gate.js setup), and (3.0.2) the paths whose untracked files are not the work (git.mjs)
const NEW_ENV = ['PERSEVERANZA_SUBAGENT_WAIT_MS', 'PERSEVERANZA_NODE', 'PERSEVERANZA_FINGERPRINT_IGNORE'];

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const rel = (p) => p.slice(ROOT.length + 1).replaceAll('\\', '/');
const srcFiles = () => walk(join(ROOT, 'src')).map((p) => ({ path: rel(p), text: readFileSync(p, 'utf8') }));
// the files git tracks or would track (untracked but not ignored), as they are on disk
function repoFiles() {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `git ls-files failed: ${r.stderr}`);
  return [...new Set(r.stdout.split('\0').filter(Boolean))].filter((f) => existsSync(join(ROOT, f)) && statSync(join(ROOT, f)).isFile());
}

test('the CLI entry is src/cli/perseveranza.mjs and the 2.x one is gone', () => {
  assert.equal(CLI_ENTRY, 'src/cli/perseveranza.mjs');
  assert.ok(RUNTIME_FILES.includes(CLI_ENTRY) && RUNTIME_FILES.includes(LEGACY_MODULE));
  assert.equal(existsSync(join(ROOT, LEGACY_CLI_ENTRY)), false);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.ok(Object.values(pkg.scripts).some((s) => s.includes(CLI_ENTRY)), 'npm run explain uses the new entry');
});

test('the migration table: one new name per old one, all distinct, every new one PERSEVERANZA_*', () => {
  const olds = LEGACY_ENV.map(([o]) => o);
  const news = LEGACY_ENV.map(([, n]) => n);
  assert.equal(new Set(olds).size, olds.length);
  assert.equal(new Set(news).size, news.length);
  for (const [o, n] of LEGACY_ENV) {
    assert.match(o, /^[A-Z][A-Z0-9_]+$/);
    assert.match(n, /^PERSEVERANZA_[A-Z0-9_]+$/);
    assert.ok(!KEPT_ENV.includes(n), `${n} collides with a name that did not change`);
  }
});

test('every new variable is read by the code, every old one by nothing but legacy.mjs', () => {
  const files = srcFiles().filter((f) => f.path !== LEGACY_MODULE);
  for (const [oldName, newName] of LEGACY_ENV) {
    const reads = files.filter((f) => new RegExp(`\\.${newName}\\b`).test(f.text));
    assert.ok(reads.length, `${newName} is not read anywhere in src/`);
    const stale = files.filter((f) => new RegExp(`\\b${oldName}\\b`).test(f.text));
    assert.deepEqual(stale.map((f) => f.path), [], `${oldName} still in src/`);
  }
  // and no PERSEVERANZA_* is read that the table (or the unchanged names) does not know
  const known = new Set([...LEGACY_ENV.map(([, n]) => n), ...KEPT_ENV, ...INTERNAL_ENV, ...NEW_ENV]);
  for (const f of files) {
    for (const m of f.text.matchAll(/\.(PERSEVERANZA_[A-Z0-9_]+)\b/g)) assert.ok(known.has(m[1]), `${f.path} reads ${m[1]}, missing from LEGACY_ENV/KEPT_ENV`);
  }
});

test('both READMEs document every variable by its new name; the CHANGELOG has the old -> new table', () => {
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  for (const readme of ['README.md', 'README.en.md']) {
    const text = readFileSync(join(ROOT, readme), 'utf8');
    for (const [, n] of LEGACY_ENV) assert.ok(text.includes(`\`${n}\``), `${readme} does not document ${n}`);
  }
  for (const [o, n] of LEGACY_ENV) assert.ok(changelog.includes(`| \`${o}\` | \`${n}\` |`), `CHANGELOG: no migration row ${o} -> ${n}`);
});

test('the old prefix appears only in the allowed files, never in a file name', () => {
  const offenders = [];
  for (const f of repoFiles()) {
    if (OLD_PREFIX.test(f)) offenders.push(`${f} (name)`);
    if (ALLOWED.has(f)) continue;
    const text = readFileSync(join(ROOT, f), 'latin1');
    if (!OLD_PREFIX.test(text)) continue;
    const lines = text.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => OLD_PREFIX.test(l));
    offenders.push(...lines.slice(0, 3).map(([i, l]) => `${f}:${i}: ${l.trim().slice(0, 120)}`));
  }
  assert.deepEqual(offenders, []);
});

test('the dated docs open with the 3.0.0 note; .gitignore keeps only another tool\'s folder', () => {
  for (const doc of HISTORICAL_DOCS) {
    const first = readFileSync(join(ROOT, doc), 'utf8').split('\n')[0];
    assert.ok(first.startsWith('> Nota 3.0.0:') && first.includes('`.perseveranza`') && first.includes('`PERSEVERANZA_*`') && first.includes('CHANGELOG'), `${doc}: ${first}`);
  }
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
  assert.ok(ignore.includes('.perseveranza/'), 'the loop folder of this repository is ignored');
  const lines = ignore.filter((l) => OLD_PREFIX.test(l));
  assert.equal(lines.length, 1, 'one line, no comment naming the tool');
  assert.match(lines[0], /^\.o[m]c\/$/);
});

test('the settings new in 3.0 are documented in both READMEs', () => {
  for (const readme of ['README.md', 'README.en.md']) {
    const text = readFileSync(join(ROOT, readme), 'utf8');
    for (const name of NEW_ENV) assert.ok(text.includes(`| \`${name}\` |`), `${name} in ${readme}`);
  }
});
