// install.mjs, the manual installation: a plugin directory loaded through
// env.CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json, no settings hook. Each test runs it
// in a throw-away home (HOME, USERPROFILE and PERSEVERANZA_HOME pointed at a temp folder,
// CLAUDE_CONFIG_DIR unset), the way a user runs it: `node install.mjs`. Every home is removed
// at the end.
//
// What it may delete is the point of most of these tests: only what its marker lists and is
// intact, files byte for byte equal to what a past release copied (the earlier installs are
// rebuilt here by their own installers, read from the git history: a clone with its full
// history is needed, as in CI), and the leftovers of its own runs recognized by their sentinel.
// Everything else stays and is named.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, chmodSync, statSync, lstatSync, readdirSync, rmSync, symlinkSync, renameSync, copyFileSync, cpSync, utimesSync, unlinkSync } from 'node:fs';
import { join, dirname, basename, delimiter, resolve } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../../src/shell/paths.mjs';
import { ALL_FILES, AGENT_FILES, CLI_ENTRY } from '../../manifest.mjs';
import { LEGACY_CLI_ENTRY, LEGACY_V1_CLI_FILE, LEGACY_HASHES } from '../../src/shell/legacy.mjs';
import { planOf } from '../../scripts/legacy-hashes.mjs';
import { parseSettings, setPluginDir, stripLegacyHooks, isLegacyHookCommand, isLegacyCopy, isOldCommand, sameDir, marketplaceCopies, writeAtomic, readMarker, buildStaging, swapIn, inspectInstall, removeInstall, recoverLeftovers, leftoverOf, acquireLock, settingsFormat, patchSettings, legacyHookPlan, samePlace, PLUGIN_DIRS_VAR, BACKUP_SUFFIX, INSTALL_DIRNAME, MARKER, SENTINEL, LOCK_NAME } from '../../install.mjs';

const INSTALL = join(ROOT, 'install.mjs');
const BAK = BACKUP_SUFFIX;
const TEMPS = [];
const temp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); TEMPS.push(d); return d; };
after(() => { for (const d of TEMPS) rmSync(d, { recursive: true, force: true }); });
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function home() {
  const h = temp('prs-install-');
  const claude = join(h, '.claude');
  const env = { ...process.env, HOME: h, USERPROFILE: h, PERSEVERANZA_HOME: join(h, '.perseveranza') };
  delete env.CLAUDE_CONFIG_DIR;
  const run = (...args) => spawnSync(process.execPath, [INSTALL, ...args], { encoding: 'utf8', env, cwd: h });
  const settingsPath = join(claude, 'settings.json');
  const dir = join(claude, 'perseveranza');
  const read = () => readFileSync(settingsPath, 'utf8');
  const settings = () => JSON.parse(read());
  const write = (v) => { mkdirSync(claude, { recursive: true }); writeFileSync(settingsPath, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
  const ours = dir.replaceAll('\\', '/');
  const complete = () => ALL_FILES.every((f) => existsSync(join(dir, f)));
  return { h, claude, env, run, settingsPath, dir, read, settings, write, ours, complete };
}
const out = (r) => r.stdout + r.stderr;
// every file under a folder, with its content: what "nothing was touched" compares
function snapshot(dir) {
  const res = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (lstatSync(p).isDirectory()) walk(p); else res[p.slice(dir.length)] = readFileSync(p, 'latin1'); } };
  walk(dir);
  return res;
}
// the same with each file's modification time: what "not rewritten" compares
function stamps(dir) {
  const res = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const st = lstatSync(p); if (st.isDirectory()) walk(p); else res[p.slice(dir.length)] = [st.mtimeMs, sha(readFileSync(p))]; } };
  walk(dir);
  return res;
}
const writeAt = (p, buf) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, buf); };

// A pid no process has any more: a node that has exited.
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
// A leftover of a run of the installer, as it makes one: <install>.<kind>-<ms>-<pid>-<nonce> with
// its sentinel; from: a folder renamed to it (the install renamed away), else a new one.
function leftover(installDir, kind, { pid = deadPid(), at = Date.now(), from = null } = {}) {
  const nonce = randomBytes(8).toString('hex');
  const p = `${installDir}.${kind}-${at}-${pid}-${nonce}`;
  if (from) renameSync(from, p); else mkdirSync(p);
  writeFileSync(join(p, SENTINEL), JSON.stringify({ installer: 'perseveranza', kind, at, pid, nonce }));
  return p;
}

// ---- the earlier installs, rebuilt by their own installers from the git history
const REV = {
  ps1: '6d83420', // install.ps1: hooks\*.ps1 and the command, verbatim
  node0: '69f3d61', // the first install.mjs: hooks/*.mjs and the command, verbatim
  v1: 'f9c3a6e', // 1.x: scripts into hooks/, the agents, the command with the CLI path written in
  v2: 'a263a0c', // 2.x: the plugin into perseveranza/, the agents, the command with its root written in
};
const blobCache = new Map();
function gitShow(rev, path, { optional = false } = {}) {
  const key = `${rev}:${path}`;
  if (!blobCache.has(key)) {
    const r = spawnSync('git', ['show', key], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
    blobCache.set(key, r.status === 0 ? r.stdout : null);
  }
  const buf = blobCache.get(key);
  if (!buf && !optional) throw new Error(`git show ${key} failed: these tests rebuild the earlier installs from the git history, so they need a clone with its full history (in CI: actions/checkout with fetch-depth: 0)`);
  return buf;
}
const crlf = (buf) => Buffer.from(buf.toString('latin1').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'), 'latin1');
// What the installer of rev wrote under claudeDir, written there the way it wrote it.
// -> the paths it wrote (relative to claudeDir, '/')
async function oldInstall(rev, claudeDir, { lineEnds = null } = {}) {
  const plan = await planOf(gitShow(rev, 'install.ps1', { optional: true }), gitShow(rev, 'install.mjs', { optional: true }), gitShow(rev, 'manifest.mjs', { optional: true }));
  assert.ok(plan.copies.length, `the installer of ${rev} copies files`);
  const c = resolve(claudeDir).replaceAll('\\', '/');
  const fix = (buf) => (lineEnds === 'crlf' ? crlf(buf) : buf);
  const wrote = [];
  for (const [target, from] of plan.copies) { writeAt(join(claudeDir, ...target.split('/')), fix(gitShow(rev, from))); wrote.push(target); }
  if (plan.command) {
    let text = gitShow(rev, plan.command[1]).toString('utf8');
    if (plan.command[0] === 'v1-cli') text = text.replaceAll(`\${CLAUDE_PLUGIN_ROOT}/scripts/${LEGACY_V1_CLI_FILE}`, `${c}/hooks/${LEGACY_V1_CLI_FILE}`);
    if (plan.command[0] === 'v2-root') text = text.replaceAll('${CLAUDE_PLUGIN_ROOT}', `${c}/perseveranza`);
    writeAt(join(claudeDir, 'commands', 'perseveranza.md'), fix(Buffer.from(text, 'utf8')));
    wrote.push('commands/perseveranza.md');
  }
  return wrote;
}

test('install: the whole plugin directory with its marker, loaded by CLAUDE_CODE_PLUGIN_DIRS; no settings hook, nothing outside it', () => {
  const t = home();
  const r = t.run();
  assert.equal(r.status, 0, out(r));
  assert.ok(t.complete());
  // the marker lists every installed file with its size and hash
  const m = readMarker(t.dir);
  assert.equal(m.plugin, 'perseveranza');
  assert.deepEqual(m.files.map((f) => f[0]).sort(), [...ALL_FILES].sort());
  assert.equal(m.version, JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version);
  assert.equal(m.settings, 'created', 'the marker remembers that settings.json was not there');
  assert.deepEqual(JSON.parse(readFileSync(join(t.dir, 'hooks', 'hooks.json'), 'utf8')).modules, ['./register.js']);
  assert.ok(readFileSync(join(t.dir, 'commands', 'perseveranza.md'), 'utf8').includes('${CLAUDE_PLUGIN_ROOT}'), 'the command is the plugin\'s, its root resolved by Claude Code');
  assert.deepEqual(t.settings(), { env: { [PLUGIN_DIRS_VAR]: t.ours } });
  assert.ok(!existsSync(t.settingsPath + BAK), 'nothing to back up: there was no settings.json');
  // nothing beside it: no staging copy, no old copy, no lock, no command or agent in ~/.claude
  assert.deepEqual(readdirSync(t.claude).sort(), ['perseveranza', 'settings.json']);
  assert.ok(!existsSync(join(t.dir, SENTINEL)));
  assert.match(r.stdout, /Installed\. Restart Claude Code/);
  const s = spawnSync(process.execPath, [join(t.dir, CLI_ENTRY), 'status'], { encoding: 'utf8', env: t.env, cwd: t.h });
  assert.match(s.stdout, /NOT armed in this project/, out(s));
});

test('install keeps every other key and entry; a second run of the same version rewrites nothing at all', () => {
  const t = home();
  const other = ['/opt/other-mod', 'C:/x/y'].join(delimiter);
  const before = { model: 'opus', env: { FOO: '1', [PLUGIN_DIRS_VAR]: other }, permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'my-own-stop' }] }] }, statusLine: { type: 'command', command: 'x' } };
  t.write(before);
  const original = t.read();
  assert.equal(t.run().status, 0);
  const after = t.settings();
  assert.deepEqual({ ...after, env: { ...after.env, [PLUGIN_DIRS_VAR]: null } }, { ...before, env: { ...before.env, [PLUGIN_DIRS_VAR]: null } });
  assert.equal(after.env[PLUGIN_DIRS_VAR], `${other}${delimiter}${t.ours}`);
  assert.equal(readFileSync(t.settingsPath + BAK, 'utf8'), original, 'backed up before the write');
  assert.equal(readMarker(t.dir).settings, 'existed');
  const text = t.read();
  const mtime = statSync(t.settingsPath).mtimeMs;
  const files = stamps(t.dir);
  const r2 = t.run();
  assert.equal(r2.status, 0, out(r2));
  assert.match(r2.stdout, /already loads it/);
  assert.match(r2.stdout, /Already installed and identical: .*nothing copied/);
  assert.equal(t.read(), text);
  assert.equal(statSync(t.settingsPath).mtimeMs, mtime);
  assert.deepEqual(stamps(t.dir), files, 'not one file of the install rewritten (hash and mtime)');
  assert.deepEqual(readdirSync(t.claude).sort(), ['perseveranza', 'settings.json', `settings.json${BAK}`]);
  // a different version (here: one file of the install changed back to what the marker says
  // after a marker of an older copy) is copied again
  const m = readMarker(t.dir);
  m.files = m.files.map((f) => (f[0] === 'packs/it.json' ? [f[0], 2, sha('{}')] : f));
  writeFileSync(join(t.dir, 'packs', 'it.json'), '{}');
  writeFileSync(join(t.dir, MARKER), JSON.stringify(m));
  const r3 = t.run();
  assert.equal(r3.status, 0, out(r3));
  assert.match(r3.stdout, /Plugin copied to/);
  assert.equal(readFileSync(join(t.dir, 'packs', 'it.json'), 'utf8'), readFileSync(join(ROOT, 'packs', 'it.json'), 'utf8'));
});

test('the backup is the original, taken once: an install then an uninstall leave it as the user had it', () => {
  const t = home();
  t.write({ mine: 1, hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `node "${t.ours}/src/shell/stop.mjs"` }] }] } });
  const original = t.read();
  assert.equal(t.run().status, 0);
  assert.equal(t.run('--uninstall').status, 0);
  assert.equal(t.run().status, 0);
  assert.equal(readFileSync(t.settingsPath + BAK, 'utf8'), original);
});

test('the backup is never written over or through anything at its name (a dangling link included); a settings.json the install created is never "backed up"', () => {
  const t = home();
  t.write({ mine: 1 });
  const nowhere = join(t.h, 'nowhere', 'stolen.json');
  symlinkSync(nowhere, t.settingsPath + BAK, 'file');
  const r = t.run();
  assert.equal(r.status, 0, out(r));
  assert.ok(lstatSync(t.settingsPath + BAK).isSymbolicLink(), 'the link is left as it was');
  assert.ok(!existsSync(join(t.h, 'nowhere')), 'nothing written where it points');
  // created by the install: no backup ever; the uninstall removes the file when only its entry was there
  const c = home();
  assert.equal(c.run().status, 0);
  assert.equal(c.run().status, 0);
  assert.equal(readMarker(c.dir).settings, 'created', 'a reinstall keeps what the first install saw');
  const u = c.run('--uninstall');
  assert.equal(u.status, 0, out(u));
  assert.match(u.stdout, /Removed .*settings\.json: the install created it/);
  assert.ok(!existsSync(c.settingsPath));
  assert.ok(!existsSync(c.settingsPath + BAK));
  assert.deepEqual(readdirSync(c.claude), []);
  // created by the install, then the user added a key: kept with that key, and still no backup
  const k = home();
  assert.equal(k.run().status, 0);
  k.write({ ...k.settings(), model: 'opus' });
  assert.equal(k.run('--uninstall').status, 0);
  assert.deepEqual(k.settings(), { model: 'opus' });
  assert.ok(!existsSync(k.settingsPath + BAK));
});

test('uninstall: the entry and the directory go, everything else stays; a run with nothing to remove changes nothing', () => {
  const t = home();
  t.write({ model: 'opus', env: { FOO: '1', [PLUGIN_DIRS_VAR]: '/opt/other-mod' } });
  assert.equal(t.run().status, 0);
  const u = t.run('--uninstall');
  assert.equal(u.status, 0, out(u));
  assert.deepEqual(t.settings(), { model: 'opus', env: { FOO: '1', [PLUGIN_DIRS_VAR]: '/opt/other-mod' } });
  assert.ok(!existsSync(t.dir));
  assert.deepEqual(readdirSync(t.claude).sort(), ['settings.json', `settings.json${BAK}`], 'no old copy left behind');
  const text = t.read();
  assert.equal(t.run('--uninstall').status, 0);
  assert.equal(t.read(), text);
  // a file that cannot be removed: said, with the exit code; the folder stays recognizable and
  // the next run finishes the removal
  const b = home();
  assert.equal(b.run().status, 0);
  const pre = join(temp('prs-install-pre-'), 'busy.mjs');
  writeFileSync(pre, "import fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\nconst unlink = fs.unlinkSync;\nfs.unlinkSync = (p, ...a) => { if (String(p).endsWith('machine.mjs')) throw Object.assign(new Error('EBUSY: injected'), { code: 'EBUSY' }); return unlink(p, ...a); };\nsyncBuiltinESMExports();\n");
  const stuck = spawnSync(process.execPath, ['--import', pathToFileURL(pre).href, INSTALL, '--uninstall'], { encoding: 'utf8', env: b.env, cwd: b.h });
  assert.equal(stuck.status, 1, out(stuck));
  assert.match(stuck.stderr, /could not be removed .*src\/core\/machine\.mjs.*run node install\.mjs --uninstall again/);
  const away = readdirSync(b.claude).filter((x) => x.startsWith('perseveranza.old-'));
  assert.equal(away.length, 1);
  assert.ok(readMarker(join(b.claude, away[0])), 'the marker stays with the file it could not remove');
  const again = b.run('--uninstall');
  assert.equal(again.status, 0, out(again));
  assert.deepEqual(readdirSync(b.claude), []);
  // a config dir that does not exist: nothing to do, and nothing made
  const n = home();
  const r = n.run('--uninstall');
  assert.equal(r.status, 0, out(r));
  assert.ok(!existsSync(n.claude));
});

// a git checkout with a commit and uncommitted work, in the place of the install
function checkoutAt(dir) {
  mkdirSync(dir, { recursive: true });
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(dir, 'mywork.txt'), 'committed');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'w');
  writeFileSync(join(dir, 'wip.txt'), 'not committed');
  assert.ok(existsSync(join(dir, '.git')));
}

test('a git checkout at <claude>/perseveranza: install and uninstall refuse and touch nothing', () => {
  const t = home();
  checkoutAt(t.dir);
  t.write({ keep: 1 });
  const before = snapshot(t.dir);
  for (const args of [[], ['--uninstall']]) {
    const r = t.run(...args);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stderr, /git repository/);
    assert.match(r.stderr, /Nothing was changed/);
    assert.deepEqual(snapshot(t.dir), before);
    assert.deepEqual(t.settings(), { keep: 1 });
  }
});

test('the checkout the installer runs from, placed at <claude>/perseveranza (even with no .git): uninstall from it refuses, nothing deleted', () => {
  const t = home();
  for (const f of [...ALL_FILES, 'install.mjs', 'manifest.mjs', 'scripts/legacy-hashes.mjs']) { mkdirSync(dirname(join(t.dir, f)), { recursive: true }); copyFileSync(join(ROOT, f), join(t.dir, f)); }
  writeFileSync(join(t.dir, 'wip.txt'), 'mine');
  const before = snapshot(t.dir);
  const env = t.env;
  for (const args of [['--uninstall'], []]) {
    const r = spawnSync(process.execPath, [join(t.dir, 'install.mjs'), ...args], { encoding: 'utf8', env, cwd: t.h });
    assert.equal(r.status, 1, out(r));
    assert.match(r.stderr, /the checkout this installer runs from/);
    assert.deepEqual(snapshot(t.dir), before);
  }
});

test('a symlink or junction at <claude>/perseveranza: refused, what it points at untouched', () => {
  const t = home();
  const elsewhere = join(t.h, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'precious.txt'), 'x');
  mkdirSync(t.claude, { recursive: true });
  symlinkSync(elsewhere, t.dir, 'junction');
  for (const args of [[], ['--uninstall']]) {
    const r = t.run(...args);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stderr, /symbolic link or a junction/);
    assert.deepEqual(readdirSync(elsewhere), ['precious.txt']);
    assert.ok(lstatSync(t.dir).isSymbolicLink());
  }
});

test('a folder that is not an install, an install with a corrupt marker, or the marker of another plugin: refused, nothing touched', () => {
  const t = home();
  mkdirSync(t.dir, { recursive: true });
  writeFileSync(join(t.dir, 'notes.txt'), 'mine');
  for (const args of [[], ['--uninstall']]) {
    const r = t.run(...args);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stderr, /not a perseveranza install/);
    assert.match(r.stderr, /no install marker .*notes\.txt/);
    assert.deepEqual(readdirSync(t.dir), ['notes.txt']);
  }
  // only what Claude Code would generate, and no file of a release: not recognizably an install
  const g = home();
  writeAt(join(g.dir, '.claude-plugin', 'types', 'x.d.ts'), '// mine?');
  const rg = g.run();
  assert.equal(rg.status, 1, out(rg));
  assert.match(rg.stderr, /holds no file of a release/);
  assert.ok(existsSync(join(g.dir, '.claude-plugin', 'types', 'x.d.ts')));
  for (const marker of ['{ broken', (m) => ({ ...m, plugin: 'other-plugin' }), (m) => ({ ...m, files: [] })]) {
    const c = home();
    assert.equal(c.run().status, 0);
    writeFileSync(join(c.dir, MARKER), typeof marker === 'string' ? marker : JSON.stringify(marker(readMarker(c.dir))));
    const before = snapshot(c.dir);
    const settings = c.read();
    for (const args of [[], ['--uninstall']]) {
      const r = c.run(...args);
      assert.equal(r.status, 1, out(r));
      assert.match(r.stderr, /not one this installer wrote \(unreadable, corrupt, or another plugin's\)/);
      assert.deepEqual(snapshot(c.dir), before);
      assert.equal(c.read(), settings);
    }
  }
  // a marker that parses but names a file outside the folder: not one this installer wrote
  const o = home();
  assert.equal(o.run().status, 0);
  writeFileSync(join(o.claude, 'outside.txt'), 'mine');
  const m = readMarker(o.dir);
  m.files.push(['../outside.txt', 4, sha('mine')]);
  writeFileSync(join(o.dir, MARKER), JSON.stringify(m));
  assert.equal(readMarker(o.dir), null);
  const ro = o.run('--uninstall');
  assert.equal(ro.status, 1, out(ro));
  assert.match(ro.stderr, /unreadable, corrupt/);
  assert.ok(existsSync(join(o.claude, 'outside.txt')) && o.complete());
});

test('the user\'s files inside our install: uninstall keeps them (and a changed file of ours); a later install refuses the folder, never deletes them', () => {
  const t = home();
  assert.equal(t.run().status, 0);
  mkdirSync(join(t.dir, 'notes'), { recursive: true });
  writeFileSync(join(t.dir, 'notes', 'mine.txt'), 'mine');
  writeFileSync(join(t.dir, 'packs', 'it.json'), '{"my": "edit"}');
  // a tsconfig.json of the user's (not the one Claude Code generates, which extends its types)
  writeFileSync(join(t.dir, 'tsconfig.json'), '{"compilerOptions": {"strict": true}}');
  // an edit that keeps the size: only the hash tells it
  const agent = join(t.dir, 'agents', 'pf-reviewer.md');
  const orig = readFileSync(agent, 'utf8');
  const edited = orig.replace(/a/, 'e');
  assert.ok(edited !== orig && edited.length === orig.length);
  writeFileSync(agent, edited);
  const r = t.run();
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /files this installer did not write/);
  assert.match(r.stderr, /notes\/mine\.txt/);
  assert.match(r.stderr, /agents\/pf-reviewer\.md/);
  const u = t.run('--uninstall');
  assert.equal(u.status, 0, out(u));
  assert.match(u.stdout, /kept the ones it did not write/);
  const kept = () => {
    assert.equal(readFileSync(join(t.dir, 'notes', 'mine.txt'), 'utf8'), 'mine');
    assert.equal(readFileSync(join(t.dir, 'packs', 'it.json'), 'utf8'), '{"my": "edit"}');
    assert.equal(readFileSync(join(t.dir, 'tsconfig.json'), 'utf8'), '{"compilerOptions": {"strict": true}}');
    assert.equal(readFileSync(agent, 'utf8'), edited, 'a file of ours changed in place (same size) is kept');
  };
  kept();
  assert.ok(!existsSync(join(t.dir, CLI_ENTRY)));
  assert.ok(!existsSync(join(t.dir, MARKER)));
  assert.ok(!existsSync(t.settingsPath), 'the settings.json it created, holding only its entry, is gone');
  // installing again: the folder has no marker now, and files that are no release's: refused
  const before = snapshot(t.dir);
  for (const args of [[], ['--uninstall']]) {
    const again = t.run(...args);
    assert.equal(again.status, 1, out(again));
    assert.match(again.stderr, /no install marker and holds files that are not an exact copy of a perseveranza release, so they may be yours: .*agents\/pf-reviewer\.md/);
    assert.deepEqual(snapshot(t.dir), before);
    kept();
  }
});

test('a 2.x install, as its installer made it (from git, with its old-named CLI): replaced, its CLI gone; changed, or with a file of the user\'s: refused, nothing touched', async () => {
  for (const lineEnds of [null, 'crlf']) {
    const t = home();
    const wrote = await oldInstall(REV.v2, t.claude, { lineEnds });
    assert.ok(wrote.includes(`perseveranza/${LEGACY_CLI_ENTRY}`), 'the 2.x CLI is among the files 2.x installed');
    // and what Claude Code generates in a plugin folder it loads
    writeAt(join(t.dir, '.claude-plugin', 'types', 'claude-code', 'index.d.ts'), '//');
    writeFileSync(join(t.dir, 'tsconfig.json'), JSON.stringify({ extends: './.claude-plugin/types/tsconfig.json' }));
    const r = t.run();
    assert.equal(r.status, 0, out(r));
    assert.ok(t.complete());
    assert.ok(readMarker(t.dir));
    assert.ok(!existsSync(join(t.dir, LEGACY_CLI_ENTRY)), 'the old CLI does not survive in the new copy');
    assert.ok(!existsSync(join(t.dir, '.claude-plugin', 'types')));
    for (const w of wrote.filter((x) => !x.startsWith('perseveranza/'))) assert.ok(!existsSync(join(t.claude, w)), `${lineEnds}: ${w}, a copy 2.x made, is removed`);
    assert.deepEqual(readdirSync(t.claude).filter((n) => n.startsWith('perseveranza')), ['perseveranza'], 'nothing beside it');
  }
  // an install of this release whose marker was deleted: every file is this release's, replaced
  const lost = home();
  assert.equal(lost.run().status, 0);
  unlinkSync(join(lost.dir, MARKER));
  const rl = lost.run();
  assert.equal(rl.status, 0, out(rl));
  assert.ok(lost.complete() && readMarker(lost.dir));
  // a file changed between the look and the removal is not removed (each is checked again)
  const v = home();
  await oldInstall(REV.v2, v.claude);
  const vi = inspectInstall(v.dir, ROOT);
  assert.equal(vi.kind, 'legacy');
  writeFileSync(join(v.dir, 'packs', 'it.json'), '{"changed": "meanwhile"}');
  assert.deepEqual(removeInstall(v.dir, vi), ['packs/it.json']);
  // one file of the 2.x install edited: no longer a release's, so the folder is refused
  const e = home();
  await oldInstall(REV.v2, e.claude);
  writeFileSync(join(e.dir, 'packs', 'it.json'), '{"edited": true}');
  const eb = snapshot(e.dir);
  const re = e.run();
  assert.equal(re.status, 1, out(re));
  assert.match(re.stderr, /not an exact copy of a perseveranza release.*packs\/it\.json/);
  assert.deepEqual(snapshot(e.dir), eb);
  // a file of the user's in it: refused, every file there
  const u = home();
  await oldInstall(REV.v2, u.claude);
  writeFileSync(join(u.dir, 'todo.txt'), 'mine');
  const ub = snapshot(u.dir);
  for (const args of [[], ['--uninstall']]) {
    const r2 = u.run(...args);
    assert.equal(r2.status, 1, out(r2));
    assert.match(r2.stderr, /todo\.txt/);
    assert.deepEqual(snapshot(u.dir), ub);
  }
});

// A copy of this checkout (the files the installer copies, and the installer itself) to run
// install.mjs from; broken: one of the files it copies cannot be read (a folder by its name).
function checkoutCopy({ broken = false } = {}) {
  const d = temp('prs-install-src-');
  for (const f of [...ALL_FILES, 'install.mjs', 'manifest.mjs']) { mkdirSync(dirname(join(d, f)), { recursive: true }); copyFileSync(join(ROOT, f), join(d, f)); }
  if (broken) { rmSync(join(d, 'packs', 'it.json')); mkdirSync(join(d, 'packs', 'it.json')); }
  return d;
}

test('a copy that fails: settings.json is not written, an interrupted install is put back, nothing is left beside it', () => {
  const t = home();
  assert.equal(t.run().status, 0);
  // a change is due in settings.json (an old hook to remove), and the last run was cut between
  // its two renames: the install is beside its place
  t.write({ ...t.settings(), hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `node "${t.ours}/src/shell/stop.mjs"` }] }] } });
  const settings = t.read();
  const away = leftover(t.dir, 'old', { from: t.dir });
  const src = checkoutCopy({ broken: true });
  const r = spawnSync(process.execPath, [join(src, 'install.mjs')], { encoding: 'utf8', env: t.env, cwd: t.h });
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /could not be copied .*settings\.json was not changed/);
  assert.equal(t.read(), settings, 'settings.json is written only once the copy is complete');
  assert.ok(r.stdout.includes(`Restored ${t.dir} from ${away.slice(t.claude.length + 1)}`), out(r));
  assert.ok(t.complete(), 'the interrupted install is back in place: settings.json lists a complete plugin');
  assert.ok(!existsSync(join(t.dir, SENTINEL)));
  assert.deepEqual(readdirSync(t.claude).sort(), ['perseveranza', 'settings.json']);
});

test('an install directory inside the checkout it is copied from: refused', () => {
  const src = checkoutCopy();
  const claude = join(src, 'inner', '.claude');
  const r = spawnSync(process.execPath, [join(src, 'install.mjs'), '--claude-dir', claude], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: '' } });
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /inside this checkout/);
  assert.ok(!existsSync(join(src, 'inner')), 'nothing made inside the checkout, not even the config dir or its lock');
});

// A path with a link in it (macOS reaches its temp folders through /var -> /private/var; a
// checkout or a config dir may be linked): Node loads the installer by its real path, so a run
// through the link must still be a run (it used to exit 0 having done nothing), and the guard
// against an install inside the checkout must compare real paths, the install directory's
// included before it exists.
test('install.mjs reached through a link: it runs, and an install directory inside the checkout is refused under either name', () => {
  const src = checkoutCopy();
  const via = join(temp('prs-install-link-'), 'via');
  symlinkSync(src, via, 'junction');
  const help = spawnSync(process.execPath, [join(via, 'install.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, out(help));
  assert.match(help.stdout, /Usage: node install\.mjs/, 'a run, not a silent exit');
  for (const [runFrom, claude, label] of [[via, join(src, 'inner', '.claude'), 'run through the link'], [src, join(via, 'inner', '.claude'), 'the config dir named through the link']]) {
    const r = spawnSync(process.execPath, [join(runFrom, 'install.mjs'), '--claude-dir', claude], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: '' } });
    assert.equal(r.status, 1, `${label}: ${out(r)}`);
    assert.match(r.stderr, /inside this checkout/, label);
    assert.ok(!existsSync(join(src, 'inner')), `${label}: nothing made inside the checkout`);
  }
});

test('the copy is checked file by file against the marker read back, a failed swap puts the old copy back, and a removal takes the marker last', () => {
  const d = temp('prs-install-unit-');
  // a copy that writes something else than the source: refused
  const short = (from, to) => { copyFileSync(from, to); if (to.endsWith('machine.mjs')) writeFileSync(to, readFileSync(from, 'utf8').replace(/a/, 'e')); };
  assert.throws(() => buildStaging(ROOT, join(d, 'staging'), { version: 'x' }, short), /does not match the checkout: src\/core\/machine\.mjs/);
  // the second rename refused: the old copy is renamed back
  const calls = [];
  const rename = (a, b) => { calls.push([a, b]); if (a === 'staging') throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  assert.throws(() => swapIn({ installDir: 'dir', staging: 'staging', oldAway: 'old', hadOld: true }, rename), /EPERM/);
  assert.deepEqual(calls, [['dir', 'old'], ['staging', 'dir'], ['old', 'dir']]);
  // nothing to put back when there was no old copy
  calls.length = 0;
  assert.throws(() => swapIn({ installDir: 'dir', staging: 'staging', oldAway: 'old', hadOld: false }, rename));
  assert.deepEqual(calls, [['staging', 'dir']]);
  // the marker is read back from the disk: one that does not list what was copied is refused
  const tamper = (from, to) => { copyFileSync(from, to); if (to.endsWith('machine.mjs')) { const m = JSON.parse(readFileSync(join(d, 'tampered', MARKER), 'utf8')); m.files.pop(); writeFileSync(join(d, 'tampered', MARKER), JSON.stringify(m)); } };
  assert.throws(() => buildStaging(ROOT, join(d, 'tampered'), { version: 'x' }, tamper), /marker written does not list/);
  // a build cut short is recognizably a leftover of its run: its sentinel is written first
  const claude = join(d, 'cfg');
  mkdirSync(claude);
  const installDir = join(claude, 'perseveranza');
  const nonce = 'a'.repeat(16);
  const at = Date.now();
  const sentinel = (kind) => ({ installer: 'perseveranza', kind, at, pid: process.pid, nonce });
  const tmpPath = `${installDir}.tmp-${at}-${process.pid}-${nonce}`;
  assert.throws(() => buildStaging(ROOT, tmpPath, { sentinel: sentinel('tmp') }, () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); }), /ENOSPC/);
  assert.equal(leftoverOf(claude, `perseveranza.tmp-${at}-${process.pid}-${nonce}`, () => false).kind, 'tmp');
  assert.match(leftoverOf(claude, `perseveranza.tmp-${at}-${process.pid}-${nonce}`).why, /still going/);
  // the old copy renamed away carries its sentinel too, even when it cannot be put back
  mkdirSync(installDir);
  writeFileSync(join(installDir, 'x'), 'x');
  const oldPath = `${installDir}.old-${at}-${process.pid}-${nonce}`;
  const failing = (a, b) => { if (a === tmpPath || a === oldPath) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); renameSync(a, b); };
  assert.throws(() => swapIn({ installDir, staging: tmpPath, oldAway: oldPath, hadOld: true, oldSentinel: sentinel('old') }, failing), /EBUSY/);
  assert.equal(leftoverOf(claude, basename(oldPath), () => false).kind, 'old');
  // a sentinel left inside an install is this installer's own file, never "the user's"
  const full = buildStaging(ROOT, join(d, 'full'), { version: 'x' });
  writeFileSync(join(full, SENTINEL), JSON.stringify(sentinel('tmp')));
  const info = inspectInstall(full, ROOT);
  assert.equal(info.kind, 'ours');
  assert.deepEqual(info.foreign, []);
  const order = [];
  const left = removeInstall(full, info, { unlink: (p) => { order.push(p.slice(full.length + 1).replaceAll('\\', '/')); unlinkSync(p); } });
  assert.deepEqual(left, []);
  assert.equal(order.length, ALL_FILES.length + 2);
  assert.deepEqual(order.slice(-2), [MARKER, SENTINEL], 'the marker, then the sentinel, last');
  // a file that cannot be removed: the marker and the sentinel stay, and a second pass finishes
  const stuck = buildStaging(ROOT, join(d, 'stuck'), { version: 'x', sentinel: sentinel('old') });
  const busy = (p) => { if (p.endsWith('machine.mjs')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); unlinkSync(p); };
  assert.deepEqual(removeInstall(stuck, inspectInstall(stuck, ROOT), { unlink: busy }).sort(), [MARKER, SENTINEL, 'src/core/machine.mjs'].sort());
  // the marker itself stuck: the sentinel stays with it
  const busyMarker = (p) => { if (p.endsWith(MARKER)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); unlinkSync(p); };
  assert.deepEqual(removeInstall(stuck, inspectInstall(stuck, ROOT), { unlink: busyMarker }).sort(), [MARKER, SENTINEL].sort());
  assert.deepEqual(removeInstall(stuck, inspectInstall(stuck, ROOT)), []);
  assert.ok(!existsSync(stuck));
  assert.ok(!existsSync(full));
});

test('a run killed half way: its own leftovers (name and sentinel agree, the process gone) are restored or removed; nothing else, whatever its name', () => {
  const t = home();
  assert.equal(t.run().status, 0);
  // killed between the two renames: the install is gone, the old copy is beside it, settings lists it
  const away = leftover(t.dir, 'old', { from: t.dir });
  // an earlier run killed while building, before and after the marker
  leftover(t.dir, 'tmp');
  const half = leftover(t.dir, 'tmp');
  copyFileSync(join(away, MARKER), join(half, MARKER));
  writeAt(join(half, 'src', 'core', 'machine.mjs'), 'half');
  // a settings.json being written when a run was killed (its pid gone), and one being written now
  const deadTmp = `${t.settingsPath}.tmp-perseveranza-${deadPid()}-${randomBytes(8).toString('hex')}`;
  const liveTmp = `${t.settingsPath}.tmp-perseveranza-${process.pid}-${randomBytes(8).toString('hex')}`;
  writeFileSync(deadTmp, '{"half');
  writeFileSync(liveTmp, '{"half');
  // a file of the user's with the same kind of name, for another file: not settings.json's
  const notMine = join(t.claude, `notes.txt.tmp-perseveranza-${deadPid()}-${randomBytes(8).toString('hex')}`);
  writeFileSync(notMine, 'mine');
  // and what is NOT a leftover of a run, though named like one: copies of the user's, with an
  // install inside (even its marker); a folder named the right way without the sentinel; one
  // whose sentinel names a process still running; one whose sentinel does not match its name
  cpSync(away, `${t.dir}.old-mybackup`, { recursive: true });
  rmSync(join(`${t.dir}.old-mybackup`, SENTINEL));
  mkdirSync(`${t.dir}.tmp-notes`);
  writeFileSync(join(`${t.dir}.tmp-notes`, 'plan.md'), 'mine');
  const noSentinel = `${t.dir}.old-${Date.now()}-${deadPid()}-${'0'.repeat(16)}`;
  cpSync(`${t.dir}.old-mybackup`, noSentinel, { recursive: true });
  const running = leftover(t.dir, 'tmp', { pid: process.pid });
  writeFileSync(join(running, 'mine.txt'), 'mine');
  const mismatch = leftover(t.dir, 'old');
  writeFileSync(join(mismatch, SENTINEL), JSON.stringify({ ...JSON.parse(readFileSync(join(mismatch, SENTINEL), 'utf8')), nonce: 'f'.repeat(16) }));
  // killed between making its folder and writing the sentinel: an empty folder, removed when its
  // pid is gone (an empty one of a live pid stays)
  const emptyDead = `${t.dir}.tmp-${Date.now()}-${deadPid()}-${randomBytes(8).toString('hex')}`;
  const emptyLive = `${t.dir}.tmp-${Date.now()}-${process.pid}-${randomBytes(8).toString('hex')}`;
  mkdirSync(join(emptyDead, 'src', 'core'), { recursive: true }); // or with only empty folders: a removal cut short
  mkdirSync(emptyLive);
  // or killed while writing its sentinel: that file, cut short, alone
  const cutSentinel = `${t.dir}.tmp-${Date.now()}-${deadPid()}-${randomBytes(8).toString('hex')}`;
  mkdirSync(cutSentinel);
  writeFileSync(join(cutSentinel, SENTINEL), '{"installer":"persev');
  const foreign = [`${t.dir}.old-mybackup`, `${t.dir}.tmp-notes`, noSentinel, running, mismatch, notMine, emptyLive];
  const look = (p) => (lstatSync(p).isDirectory() ? snapshot(p) : readFileSync(p, 'utf8'));
  const before = Object.fromEntries(foreign.map((p) => [p, look(p)]));
  const r = t.run('--uninstall');
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /Restored/);
  assert.match(r.stdout, /Left alone: .*perseveranza\.old-mybackup .*remove it yourself/);
  for (const p of foreign) assert.deepEqual(look(p), before[p], `${p} untouched`);
  assert.ok(!existsSync(deadTmp));
  assert.ok(!existsSync(emptyDead), 'the empty folder of a dead run is removed');
  assert.ok(!existsSync(cutSentinel), 'and one with only its sentinel cut short');
  assert.ok(existsSync(liveTmp), 'the temporary file of a run still going stays');
  rmSync(liveTmp);
  assert.deepEqual(readdirSync(t.claude).filter((n) => !foreign.some((p) => p.endsWith(n))).sort(), [], 'every leftover of its own removed, the restored install uninstalled (and the settings.json it created)');
  for (const p of foreign) rmSync(p, { recursive: true });
  // the same with an install: restored, then replaced, nothing beside it
  assert.equal(t.run().status, 0);
  leftover(t.dir, 'old', { from: t.dir });
  const r2 = t.run();
  assert.equal(r2.status, 0, out(r2));
  assert.ok(t.complete());
  assert.deepEqual(readdirSync(t.claude).sort(), ['perseveranza', 'settings.json']);
});

test('restoring after a kill: the newest complete old copy; an old copy with a file missing is never put in place', () => {
  const d = temp('prs-install-unit-');
  const installDir = join(d, 'perseveranza');
  const copy = (version) => { const s = join(d, `build-${version}`); buildStaging(ROOT, s, { version }); return s; };
  const older = leftover(installDir, 'old', { at: 1000, from: copy('older') });
  const newer = leftover(installDir, 'old', { at: 2000, from: copy('newer') });
  const notes = recoverLeftovers(d, installDir, ROOT);
  assert.equal(readMarker(installDir).version, 'newer', notes.join('\n'));
  assert.ok(!existsSync(join(installDir, SENTINEL)));
  assert.ok(!existsSync(older) && !existsSync(newer));
  rmSync(installDir, { recursive: true });
  // the newest is missing a file: the complete older one goes back, the half one is removed
  const whole = leftover(installDir, 'old', { at: 1000, from: copy('whole') });
  const partial = leftover(installDir, 'old', { at: 2000, from: copy('partial') });
  rmSync(join(partial, 'packs', 'it.json'));
  recoverLeftovers(d, installDir, ROOT);
  assert.equal(readMarker(installDir).version, 'whole');
  assert.ok(!existsSync(whole) && !existsSync(partial));
  rmSync(installDir, { recursive: true });
  // the newest holds a file of the user's: never put in place (nor that file deleted)
  const plain = leftover(installDir, 'old', { at: 1000, from: copy('plain') });
  const withMine = leftover(installDir, 'old', { at: 2000, from: copy('with-mine') });
  writeFileSync(join(withMine, 'notes.txt'), 'mine');
  recoverLeftovers(d, installDir, ROOT);
  assert.equal(readMarker(installDir).version, 'plain');
  assert.ok(!existsSync(plain));
  assert.deepEqual(readdirSync(withMine), ['notes.txt']);
  rmSync(withMine, { recursive: true });
  rmSync(installDir, { recursive: true });
  // only a half one: nothing restored
  const lone = leftover(installDir, 'old', { from: copy('lone') });
  rmSync(join(lone, 'packs', 'it.json'));
  recoverLeftovers(d, installDir, ROOT);
  assert.ok(!existsSync(installDir));
  // an old copy with a file changed since it was written: that file stays (only a copy being
  // built may hold half-written files of its own)
  mkdirSync(installDir);
  const edited = leftover(installDir, 'old', { from: copy('edited') });
  writeFileSync(join(edited, 'packs', 'it.json'), '{"edited": 1}');
  const notes2 = recoverLeftovers(d, installDir, ROOT);
  assert.deepEqual(readdirSync(edited, { recursive: true }).map((x) => x.replaceAll('\\', '/')).sort(), ['packs', 'packs/it.json'], notes2.join('\n'));
  assert.match(notes2.join('\n'), /changed since \(packs\/it\.json\); remove it yourself/);
  rmSync(edited, { recursive: true });
  rmSync(installDir, { recursive: true });
});

test('restoring after a kill during a 2.x migration: the 2.x folder renamed away goes back', async () => {
  const t = home();
  await oldInstall(REV.v2, t.claude);
  const away = leftover(t.dir, 'old', { from: t.dir });
  const notes = recoverLeftovers(t.claude, t.dir, ROOT);
  assert.match(notes.join('\n'), /Restored/);
  assert.ok(!existsSync(away));
  assert.equal(inspectInstall(t.dir, ROOT).kind, 'legacy');
});

test('settings.json: its mode kept (0600 stays 0600), a symlink followed and kept, a BOM kept', () => {
  const t = home();
  t.write({ env: { ANTHROPIC_API_KEY: 'secret' } });
  chmodSync(t.settingsPath, 0o600);
  const mode = statSync(t.settingsPath).mode & 0o777;
  assert.equal(t.run().status, 0);
  assert.equal(statSync(t.settingsPath).mode & 0o777, mode);
  // the write itself: the temporary file gets the mode before it replaces the file
  const calls = [];
  const fake = { writeFileSync: (p, x, o) => calls.push(['write', o && o.mode, o && o.flag]), chmodSync: (p, m) => calls.push(['chmod', m]), renameSync: () => calls.push(['rename']), unlinkSync: () => {} };
  writeAtomic('/x/settings.json', '{}', 0o600, fake);
  assert.deepEqual(calls, [['write', 0o600, 'wx'], ['chmod', 0o600], ['rename']]);
  // dotfiles: settings.json a symlink to the real file
  const s = home();
  const dot = join(s.h, 'dotfiles');
  mkdirSync(dot, { recursive: true });
  writeFileSync(join(dot, 'settings.json'), '{"mine": true}');
  mkdirSync(s.claude, { recursive: true });
  symlinkSync(join(dot, 'settings.json'), s.settingsPath, 'file');
  assert.equal(s.run().status, 0);
  assert.ok(lstatSync(s.settingsPath).isSymbolicLink(), 'the link is still a link');
  assert.deepEqual(JSON.parse(readFileSync(join(dot, 'settings.json'), 'utf8')), { mine: true, env: { [PLUGIN_DIRS_VAR]: s.ours } });
  assert.equal(readFileSync(s.settingsPath + BAK, 'utf8'), '{"mine": true}');
  assert.equal(s.run('--uninstall').status, 0);
  assert.ok(lstatSync(s.settingsPath).isSymbolicLink());
  assert.deepEqual(JSON.parse(readFileSync(join(dot, 'settings.json'), 'utf8')), { mine: true });
  // a link to a file that does not exist: refused, nothing written (neither there nor here)
  const n = home();
  mkdirSync(n.claude, { recursive: true });
  symlinkSync(join(n.h, 'dotfiles', 'missing.json'), n.settingsPath, 'file');
  for (const args of [[], ['--uninstall']]) {
    const r = n.run(...args);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stderr, /symbolic link to .*which does not exist/);
    assert.ok(lstatSync(n.settingsPath).isSymbolicLink());
    assert.ok(!existsSync(join(n.h, 'dotfiles')));
    assert.ok(!existsSync(n.dir));
  }
  // a BOM (a Windows editor): read, and kept
  const b = home();
  b.write('\uFEFF{"mine": 1}');
  assert.equal(b.run().status, 0);
  assert.ok(b.read().startsWith('\uFEFF{'));
  assert.equal(JSON.parse(b.read().slice(1)).mine, 1);
});

test('settings.json keeps its layout: indentation (tabs, 4 spaces, one line) and line ends; install then uninstall give back the same bytes', () => {
  const t = home();
  const cases = [
    ['{\n\t"a": 1,\n\t"b": [\n\t\t1\n\t]\n}\n', (o) => `{\n\t"a": 1,\n\t"b": [\n\t\t1\n\t],\n\t"env": {\n\t\t"${PLUGIN_DIRS_VAR}": "${o}"\n\t}\n}\n`],
    ['{\r\n    "a": 1\r\n}\r\n', (o) => `{\r\n    "a": 1,\r\n    "env": {\r\n        "${PLUGIN_DIRS_VAR}": "${o}"\r\n    }\r\n}\r\n`],
    ['{"a":1}', (o) => `{"a":1,"env":{"${PLUGIN_DIRS_VAR}":"${o}"}}`],
    ['{\n  "a": "line\\nbreak"\n}', (o) => `{\n  "a": "line\\nbreak",\n  "env": {\n    "${PLUGIN_DIRS_VAR}": "${o}"\n  }\n}`],
  ];
  for (const [text, expected] of cases) {
    t.write(text);
    rmSync(t.settingsPath + BAK, { force: true });
    const r = t.run();
    assert.equal(r.status, 0, out(r));
    assert.equal(t.read(), expected(t.ours), JSON.stringify(text));
    assert.equal(t.run('--uninstall').status, 0);
    assert.equal(t.read(), text, `${JSON.stringify(text)}: the same bytes back`);
  }
  // the pure parts
  assert.deepEqual(settingsFormat(''), { indent: '  ', eol: '\n', trailing: true });
  assert.deepEqual(settingsFormat('{}'), { indent: '  ', eol: '\n', trailing: false });
  assert.deepEqual(settingsFormat('{\r\n\t"a": 1}'), { indent: '\t', eol: '\r\n', trailing: false });
});

test('settings.json is edited as text: every byte outside its entry stays (numbers, inline arrays, spacing, escapes, keys twice); install then uninstall give back the same bytes', () => {
  const cases = [
    '{\n  "permissions": { "allow": ["Bash(ls)", "Read"] },\n  "a": 1\n}\n',
    '{\n  "a":1\n}\n',
    '{\n  "x": -0,\n  "y": 1.0,\n  "z": 1E5,\n  "w": 0.1000000000000000000001\n}\n',
    '{\n  "big": 1e20,\n  "dec": 12345678901234567890.5,\n  "int": 12345678901234567890,\n  "tiny": 1e-400,\n  "huge": 1e400\n}\n',
    '{\n  "a": 1,\n  "a": 2\n}\n',
    '{\n  "__proto__": {"x":1},\n  "env": {"__proto__": "y"}\n}\n',
    '{\n  "env": {"A":"1"},\n  "env": {"B":"2"}\n}\n',
    '{\n  "città": "\\u00e9\\u2028\\/x",\n  "a\\"b": "c\\\\"\n}\n',
    `{\n  "env": {\n    "${PLUGIN_DIRS_VAR}": "C:/a/p1 ; ;D:/p2"\n  }\n}\n`,
    '{\n  "env": {"A": "1"},\n  "a": [ ]\n}\n',
    '{}',
    '{ "a" : 1 }',
  ];
  for (const text of cases) {
    const t = home();
    t.write(text);
    const r = t.run();
    assert.equal(r.status, 0, `${JSON.stringify(text)}: ${out(r)}`);
    const mid = t.read();
    assert.equal(JSON.parse(mid).env[PLUGIN_DIRS_VAR].split(delimiter).pop(), t.ours, JSON.stringify(text));
    const u = t.run('--uninstall');
    assert.equal(u.status, 0, `${JSON.stringify(text)}: ${out(u)}`);
    assert.equal(t.read(), text, `${JSON.stringify(text)}: the same bytes back`);
    assert.equal(readFileSync(t.settingsPath + BAK, 'utf8'), text, 'the copy is the original, byte for byte');
  }
  // what the entry looks like where there was none: written like the members around it
  const s = home();
  s.write('{\n  "a": 1\n}\n');
  assert.equal(s.run().status, 0);
  assert.equal(s.read(), `{\n  "a": 1,\n  "env": {\n    "${PLUGIN_DIRS_VAR}": "${s.ours}"\n  }\n}\n`);
  // an empty file: the install writes the entry; after the uninstall it is "{}"
  const e = home();
  e.write('');
  assert.equal(e.run().status, 0);
  assert.equal(e.read(), `{\n  "env": {\n    "${PLUGIN_DIRS_VAR}": "${e.ours}"\n  }\n}\n`);
  assert.equal(e.run('--uninstall').status, 0);
  assert.equal(e.read(), '{}\n');
});

test('settings.json the edit cannot change alone (the key it must remove written twice): refused, nothing touched; a file the install wrote is always uninstalled', () => {
  const t = home();
  t.write({ model: 'opus' });
  assert.equal(t.run().status, 0);
  const twice = `{\n  "env": {\n    "OTHER": "1",\n    "${PLUGIN_DIRS_VAR}": "C:/mine",\n    "${PLUGIN_DIRS_VAR}": "${t.ours}"\n  }\n}\n`;
  t.write(twice);
  const r = t.run('--uninstall');
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /cannot be edited without changing something else in it/);
  assert.equal(t.read(), twice);
  assert.ok(t.complete());
  // the unit: the expected settings decide; a text that would not parse to them is refused
  assert.deepEqual(patchSettings('{"a": 1}', { dirs: 'x', expected: { a: 2, env: { [PLUGIN_DIRS_VAR]: 'x' } } }), { error: 'it cannot be edited without changing something else in it (a key it must change is written twice?)' });
});

test('the legacy hooks are taken out as text: the rest of the hooks, their layout and the other keys stay byte for byte', () => {
  const t = home();
  const c = t.claude.replaceAll('\\', '/');
  const legacy = (s) => `{ "type": "command", "command": ${JSON.stringify(`node "${c}/perseveranza/src/shell/${s}.mjs"`)} }`;
  const text = [
    '{',
    '  "model": "opus",',
    '  "hooks": {',
    `    "Stop": [ { "matcher": "", "hooks": [ ${legacy('stop')}, { "type": "command", "command": "mine" } ] } ],`,
    `    "SessionStart": [ { "hooks": [ ${legacy('session-start')} ] } ],`,
    `    "PreToolUse": [ { "hooks": [ ${legacy('activity-hook')} ] }, { "matcher": "Bash", "hooks": [ { "type": "command", "command": "x" } ] } ]`,
    '  },',
    '  "n": 1.0',
    '}',
    '',
  ].join('\n');
  t.write(text);
  assert.equal(t.run().status, 0);
  const expected = [
    '{',
    '  "model": "opus",',
    '  "hooks": {',
    '    "Stop": [ { "matcher": "", "hooks": [ { "type": "command", "command": "mine" } ] } ],',
    '    "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "x" } ] } ]',
    '  },',
    '  "n": 1.0,',
    `  "env": {\n    "${PLUGIN_DIRS_VAR}": "${t.ours}"\n  }`,
    '}',
    '',
  ].join('\n');
  assert.equal(t.read(), expected);
  // only legacy hooks, and an entry to add: "hooks" goes, the entry takes its place
  const o = home();
  o.write(`{\n  "hooks": { "Stop": [ { "hooks": [ ${legacy('stop').replace(c, o.claude.replaceAll('\\', '/'))} ] } ] }\n}\n`);
  assert.equal(o.run().status, 0);
  assert.equal(o.read(), `{\n  "env": {\n    "${PLUGIN_DIRS_VAR}": "${o.ours}"\n  }\n}\n`);
});

test('the files 1.x, 2.x and the first installers copied, rebuilt from git by those installers: exact copies removed (CRLF too) by install and by --uninstall; the 2.x install folder replaced or removed', async () => {
  for (const args of [[], ['--uninstall']]) {
    for (const [name, rev] of Object.entries(REV)) {
      for (const lineEnds of name === 'v2' || name === 'v1' ? [null, 'crlf'] : [null]) {
        const t = home();
        const wrote = await oldInstall(rev, t.claude, { lineEnds });
        mkdirSync(join(t.claude, 'hooks'), { recursive: true });
        writeFileSync(join(t.claude, 'hooks', 'mine.mjs'), '// the user\'s');
        const r = t.run(...args);
        const label = `${name} ${lineEnds || 'lf'} ${args}`;
        assert.equal(r.status, 0, `${label}: ${out(r)}`);
        for (const w of wrote.filter((x) => !x.startsWith('perseveranza/'))) {
          assert.ok(!existsSync(join(t.claude, w)), `${label}: ${w}`);
          assert.ok(r.stdout.includes(`Removed a file of an earlier install (an exact copy of a release): ${join(t.claude, ...w.split('/'))}`), `${label}: ${w} said`);
        }
        assert.ok(existsSync(join(t.claude, 'hooks', 'mine.mjs')));
        assert.doesNotMatch(r.stdout, /Left alone/, label);
        if (name === 'v2') assert.equal(existsSync(t.dir), !args.length, `${label}: the 2.x folder ${args.length ? 'removed' : 'replaced'}`);
        if (name === 'v2' && !args.length) assert.ok(t.complete() && !existsSync(join(t.dir, LEGACY_CLI_ENTRY)));
      }
    }
  }
});

test('files with the names earlier installs used, but not exactly their content (the user\'s, a 3.0 agent of the user\'s, an edited old copy): never removed, named', async () => {
  for (const args of [[], ['--uninstall']]) {
    const t = home();
    // a file of the user's under every name an earlier install used in hooks/ and agents/
    const names = Object.keys(LEGACY_HASHES.files).filter((k) => /^(hooks|agents)\//.test(k));
    for (const k of names) writeAt(join(t.claude, ...k.split('/')), `mine: ${k}\n`);
    // agents of the user's that write in the 3.0 loop folder, as a customized copy would
    for (const a of AGENT_FILES) writeAt(join(t.claude, 'agents', a.split('/').pop()), `---\nname: ${a.split('/').pop().replace('.md', '')}\n---\nWrite the verdict to .perseveranza/review.json\n`);
    // a 2.x copy of the command, edited by the user
    const c = t.claude.replaceAll('\\', '/');
    const cmd = gitShow(REV.v2, 'commands/perseveranza.md').toString('utf8').replaceAll('${CLAUDE_PLUGIN_ROOT}', `${c}/perseveranza`) + '\nmy note\n';
    writeAt(join(t.claude, 'commands', 'perseveranza.md'), cmd);
    const before = snapshot(t.claude);
    const r = t.run(...args);
    assert.equal(r.status, 0, out(r));
    for (const k of names.filter((x) => x.startsWith('hooks/'))) assert.equal(readFileSync(join(t.claude, ...k.split('/')), 'utf8'), `mine: ${k}\n`, `${args}: ${k}`);
    for (const k of [...names.filter((x) => x.startsWith('agents/')), 'commands/perseveranza.md']) {
      const p = join(t.claude, ...k.split('/'));
      assert.equal(readFileSync(p, 'latin1'), before[p.slice(t.claude.length)], `${args}: ${k}`);
    }
    assert.match(r.stdout, /Left alone: these have the name of a file an earlier perseveranza install copied, but not exactly its content/);
    for (const k of [...names, 'commands/perseveranza.md']) assert.ok(r.stdout.includes(`  ${join(t.claude, ...k.split('/'))}`), `${args}: ${k} named`);
  }
});

test('the settings hooks of 1.x and 2.x: exactly theirs removed, the user\'s kept; only theirs: "hooks" goes altogether', () => {
  for (const args of [[], ['--uninstall']]) {
    const t = home();
    const c = t.claude.replaceAll('\\', '/');
    t.write({
      hooks: {
        Stop: [
          { matcher: '', hooks: [{ type: 'command', command: `node "${t.ours}/src/shell/stop.mjs"`, timeout: 120 }, { type: 'command', command: 'my-own-stop' }] },
          { matcher: '', hooks: [{ type: 'command', command: `node "${t.claude}\\hooks\\loop-drive.mjs"` }] },
        ],
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: `node "${t.ours}/src/shell/session-start.mjs"` }] }],
        PreToolUse: [{ matcher: 'Agent|Task|Bash', hooks: [{ type: 'command', command: `node "${t.ours}/src/shell/activity-hook.mjs"` }] }],
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `pwsh -NoProfile -File ${c}/hooks/loop-drive.ps1` }] }],
        SubagentStop: [{ matcher: '', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/src/shell/activity-hook.mjs"' }] }],
        Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'notify-me' }] }],
      },
    });
    const r = t.run(...args);
    assert.equal(r.status, 0, out(r));
    assert.match(r.stdout, /Removed 6 settings hook\(s\)/);
    assert.deepEqual(t.settings().hooks, { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'my-own-stop' }] }], Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'notify-me' }] }] });
  }
  const t2 = home();
  t2.write({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `node "${t2.ours}/src/shell/stop.mjs"` }] }] } });
  assert.equal(t2.run().status, 0);
  assert.deepEqual(t2.settings(), { env: { [PLUGIN_DIRS_VAR]: t2.ours } });
});

test('the user\'s own hooks with similar names are never removed; the old copies are recognized only byte for byte', () => {
  const t = home();
  const keep = [
    'node ~/projects/acme/scripts/loop-drive.mjs --my-own',
    'bash ~/bin/notify-loop-drive.mjs.sh',
    'node /home/me/my-perseveranza/src/shell/stop.mjs',
    'python ~/perseveranza//src//shell//activity-hook.mjs.py',
    'node /home/me/loop-drive.mjs.bak/check.sh',
    `node "${t.ours}/src/shell/stop.mjs" --extra`,
    `node "${t.h}/my-wrapper.mjs" "${t.ours}/src/shell/stop.mjs"`,
    `node "${t.ours}/src/shell/stop.mjs.bak"`,
    `node "${t.ours}/other/src/shell/stop.mjs"`,
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/stop.mjs"',
    `cat "${t.ours}/src/shell/stop.mjs"`,
  ];
  const hooks = { Stop: [{ matcher: '', hooks: keep.map((command) => ({ type: 'command', command })) }] };
  t.write({ hooks });
  mkdirSync(join(t.claude, 'commands'), { recursive: true });
  // the plugin's command, with ${CLAUDE_PLUGIN_ROOT}, even when it also names the install path
  const pluginCmd = `${readFileSync(join(ROOT, 'commands', 'perseveranza.md'), 'utf8')}\n<!-- manual install: ${t.ours}/src/cli/perseveranza.mjs -->\n`;
  writeFileSync(join(t.claude, 'commands', 'perseveranza.md'), pluginCmd);
  for (const args of [[], ['--uninstall']]) {
    const r = t.run(...args);
    assert.equal(r.status, 0, out(r));
    assert.deepEqual(t.settings().hooks, hooks);
    assert.equal(readFileSync(join(t.claude, 'commands', 'perseveranza.md'), 'utf8'), pluginCmd);
  }
  for (const c of keep) assert.equal(isLegacyHookCommand(c, t.claude), false, c);
  for (const c of [`node "${t.ours}/src/shell/stop.mjs"`, `node ${t.ours}/src/shell/session-start.mjs`, `"C:/Program Files/nodejs/node.exe" "${t.ours}//src/shell/activity-hook.mjs"`, 'node "${CLAUDE_PLUGIN_ROOT}/src/shell/stop.mjs"']) assert.equal(isLegacyHookCommand(c, t.claude), true, c);
  // the copies: the bytes of a release (either line ends), nothing near them
  const agent = gitShow(REV.v2, 'agents/pf-verifier.md');
  assert.equal(isLegacyCopy('agents/pf-verifier.md', agent), true);
  assert.equal(isLegacyCopy('agents/pf-verifier.md', crlf(agent)), true);
  assert.equal(isLegacyCopy('agents/pf-verifier.md', Buffer.concat([agent, Buffer.from('\n')])), false);
  assert.equal(isLegacyCopy('agents/pf-reviewer.md', agent), false, 'the content of another file');
  assert.equal(isLegacyCopy('agents/pf-verifier.md', readFileSync(join(ROOT, 'agents', 'pf-verifier.md'))), false, 'the 3.0 agent is no old copy');
  // the command: as each installer wrote it, for this config dir only (case-blind on Windows)
  const v2cmd = gitShow(REV.v2, 'commands/perseveranza.md').toString('utf8');
  const v1cmd = gitShow(REV.v1, 'commands/perseveranza.md').toString('utf8');
  const c = t.claude.replaceAll('\\', '/');
  assert.equal(isOldCommand(v2cmd.replaceAll('${CLAUDE_PLUGIN_ROOT}', `${c}/perseveranza`), t.claude), true);
  assert.equal(isOldCommand(v2cmd.replaceAll('${CLAUDE_PLUGIN_ROOT}', `${c}/perseveranza`).toUpperCase(), t.claude), false);
  assert.equal(isOldCommand(v2cmd.replaceAll('${CLAUDE_PLUGIN_ROOT}', `${c.toUpperCase()}/perseveranza`), t.claude, 'win32'), true);
  assert.equal(isOldCommand(v2cmd.replaceAll('${CLAUDE_PLUGIN_ROOT}', `${c.toUpperCase()}/perseveranza`), t.claude, 'linux'), false);
  assert.equal(isOldCommand(v2cmd.replaceAll('${CLAUDE_PLUGIN_ROOT}', '/elsewhere/perseveranza'), t.claude), false);
  assert.equal(isOldCommand(v1cmd.replaceAll(`\${CLAUDE_PLUGIN_ROOT}/scripts/${LEGACY_V1_CLI_FILE}`, `${c}/hooks/${LEGACY_V1_CLI_FILE}`), t.claude), true);
  assert.equal(isOldCommand(gitShow(REV.ps1, 'commands/perseveranza.md').toString('utf8'), t.claude), true);
  assert.equal(isOldCommand(pluginCmd, t.claude), false);
  assert.equal(isOldCommand(readFileSync(join(ROOT, 'commands', 'perseveranza.md'), 'utf8'), t.claude), false, 'the 3.0 command is no old copy');
});

test('a settings.json that is not what it should be: refused, nothing touched (no copy, the file byte for byte)', () => {
  const hostile = ['{ "env": { ', '[1, 2]', 'null', '"text"', '{"env": [1]}', '{"env": "x"}', `{"env": {"${PLUGIN_DIRS_VAR}": ["a"]}}`, '{"a": 1,}', '{"a": 1} // comment'];
  for (const text of hostile) {
    for (const args of [[], ['--uninstall']]) {
      const t = home();
      t.write(text);
      const r = t.run(...args);
      assert.equal(r.status, 1, `${text} ${args}: ${out(r)}`);
      assert.match(r.stderr, /Nothing was changed/);
      assert.equal(t.read(), text);
      assert.ok(!existsSync(t.dir), text);
      assert.ok(!existsSync(t.settingsPath + BAK));
    }
  }
  const t = home();
  mkdirSync(t.settingsPath, { recursive: true });
  const r = t.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is a directory/);
  assert.ok(!existsSync(t.dir));
  const e = home();
  e.write('');
  assert.equal(e.run().status, 0);
  assert.deepEqual(e.settings(), { env: { [PLUGIN_DIRS_VAR]: e.ours } });
});

// As root a file's mode refuses nothing (CAP_DAC_OVERRIDE: the open for writing succeeds and the
// install rightly goes ahead), so there the installer runs as an unprivileged user (nobody) that
// owns the throw-away home: the read-only settings.json is then refused for real.
const NOBODY = 65534;
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
function runUnprivileged(t) {
  const own = spawnSync('chown', ['-R', `${NOBODY}:${NOBODY}`, t.h], { encoding: 'utf8' });
  assert.equal(own.status, 0, own.stderr);
  return spawnSync(process.execPath, [INSTALL], { encoding: 'utf8', env: t.env, cwd: t.h, uid: NOBODY, gid: NOBODY });
}

test('a settings.json that cannot be written: refused before the copy, nothing touched', () => {
  const t = home();
  t.write({ keep: true });
  chmodSync(t.settingsPath, 0o444);
  try {
    const r = asRoot ? runUnprivileged(t) : t.run();
    assert.equal(r.status, 1, out(r));
    assert.match(r.stderr, /cannot be written/);
    assert.ok(!existsSync(t.dir));
    assert.deepEqual(t.settings(), { keep: true });
  } finally { chmodSync(t.settingsPath, 0o644); }
});

test('the arguments: --claude-dir, else CLAUDE_CONFIG_DIR (--claude-dir wins over it); an unknown one refused', () => {
  const t = home();
  const cdir = join(t.h, 'cfg');
  const r = t.run('--claude-dir', cdir);
  assert.equal(r.status, 0, out(r));
  assert.ok(existsSync(join(cdir, 'perseveranza', CLI_ENTRY)));
  assert.equal(JSON.parse(readFileSync(join(cdir, 'settings.json'), 'utf8')).env[PLUGIN_DIRS_VAR], join(cdir, 'perseveranza').replaceAll('\\', '/'));
  assert.ok(!existsSync(t.claude), 'the default dir untouched');
  const viaEnv = spawnSync(process.execPath, [INSTALL], { encoding: 'utf8', env: { ...t.env, CLAUDE_CONFIG_DIR: join(t.h, 'cfg2') }, cwd: t.h });
  assert.equal(viaEnv.status, 0, out(viaEnv));
  assert.ok(existsSync(join(t.h, 'cfg2', 'perseveranza', CLI_ENTRY)));
  const both = spawnSync(process.execPath, [INSTALL, '--claude-dir', join(t.h, 'cfg3')], { encoding: 'utf8', env: { ...t.env, CLAUDE_CONFIG_DIR: join(t.h, 'cfg4') }, cwd: t.h });
  assert.equal(both.status, 0, out(both));
  assert.ok(existsSync(join(t.h, 'cfg3', 'perseveranza', CLI_ENTRY)));
  assert.ok(!existsSync(join(t.h, 'cfg4')), 'CLAUDE_CONFIG_DIR is not used when --claude-dir is given');
  const bad = t.run('--force');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown argument "--force"/);
  assert.equal(t.run('--claude-dir').status, 2);
});

test('the marketplace copy enabled too: installed, with the warning (two mods would drive the loop)', () => {
  const t = home();
  t.write({ enabledPlugins: { 'perseveranza@perseveranza': true, 'other@x': true } });
  const r = t.run();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /WARNING: perseveranza@perseveranza is enabled too/);
  assert.deepEqual(marketplaceCopies({ enabledPlugins: { 'perseveranza@perseveranza': false } }), []);
});

test('the lock: two installers started together on one config dir (real processes) run one after the other; a held lock is waited for', async () => {
  const t = home();
  mkdirSync(t.claude, { recursive: true });
  const release = acquireLock(t.claude);
  const go = () => new Promise((res) => {
    const p = spawn(process.execPath, [INSTALL], { env: t.env, cwd: t.h });
    let o = '';
    p.stdout.on('data', (d) => (o += d));
    p.stderr.on('data', (d) => (o += d));
    p.on('exit', (code) => res([code, o]));
  });
  const runs = [go(), go()];
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(!existsSync(t.dir), 'nothing done while the lock is held');
  release();
  const res = await Promise.all(runs);
  for (const [code, o] of res) assert.equal(code, 0, o);
  assert.equal(res.filter(([, o]) => /Plugin copied to/.test(o)).length, 1, 'one copies');
  assert.equal(res.filter(([, o]) => /Already installed and identical/.test(o)).length, 1, 'the other finds it done');
  assert.ok(t.complete() && readMarker(t.dir));
  assert.deepEqual(readdirSync(t.claude).sort(), ['perseveranza', 'settings.json']);
  // a run killed while it held the lock: the next one takes it over at once
  const lockMod = pathToFileURL(INSTALL).href;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', `import { acquireLock } from ${JSON.stringify(lockMod)}; acquireLock(${JSON.stringify(t.claude)}); process.kill(process.pid, 'SIGKILL');`], { encoding: 'utf8' });
  assert.notEqual(killed.status, 0);
  assert.ok(existsSync(join(t.claude, LOCK_NAME)), 'the killed run left its lock');
  const t0 = Date.now();
  const r = t.run('--uninstall');
  assert.equal(r.status, 0, out(r));
  assert.ok(Date.now() - t0 < 8000, 'not waited for');
  assert.ok(!existsSync(join(t.claude, LOCK_NAME)));
});

test('the lock, by itself: held (by a live process) -> waited for, then a clear error; stale (owner gone, too old, never written) -> taken over; released only by its owner', () => {
  const d = temp('prs-install-lock-');
  const lock = join(d, LOCK_NAME);
  const owner = (o) => { mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ host: hostname(), nonce: randomBytes(8).toString('hex'), ...o })); };
  const r1 = acquireLock(d);
  const t0 = Date.now();
  assert.throws(() => acquireLock(d, { waitMs: 300, pollMs: 50 }), (e) => e.code === 'ELOCKED' && /another install\.mjs is running/.test(e.message) && e.message.includes(`pid ${process.pid}`) && e.message.includes(lock));
  assert.ok(Date.now() - t0 >= 300, 'it waited');
  r1();
  assert.ok(!existsSync(lock));
  // its owner gone: taken over without waiting
  owner({ pid: deadPid(), at: Date.now() });
  const r2 = acquireLock(d, { waitMs: 0 });
  const mine = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
  assert.equal(mine.pid, process.pid);
  // a release when the lock is no longer this run's: left alone
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ ...mine, nonce: 'b'.repeat(16) }));
  r2();
  assert.ok(existsSync(lock), 'another run\'s lock is not released');
  rmSync(lock, { recursive: true });
  // a live owner on another machine (a shared config dir): waited for
  owner({ pid: deadPid(), host: `${hostname()}-other`, at: Date.now() });
  assert.throws(() => acquireLock(d, { waitMs: 100, pollMs: 50 }), /another install\.mjs/);
  rmSync(lock, { recursive: true });
  // a live owner that has held it far too long (its pid reused): stale
  owner({ pid: process.pid, at: Date.now() - 10 * 60 * 1000 });
  acquireLock(d, { waitMs: 0 })();
  // no owner file: a run between its two steps, waited for; a few seconds old, stale
  mkdirSync(lock);
  assert.throws(() => acquireLock(d, { waitMs: 100, pollMs: 50 }), /has not written its owner/);
  const old = new Date(Date.now() - 10000);
  utimesSync(lock, old, old);
  acquireLock(d, { waitMs: 0 })();
  assert.deepEqual(readdirSync(d), []);
  // a stale lock renamed away by a run killed before removing it: swept by the next lock taken;
  // a folder with that kind of name but anything else in it stays
  const strayLock = join(d, `${LOCK_NAME}.stale-${'c'.repeat(16)}`);
  mkdirSync(strayLock);
  writeFileSync(join(strayLock, 'owner.json'), '{}');
  const notLock = join(d, `${LOCK_NAME}.stale-${'d'.repeat(16)}`);
  mkdirSync(notLock);
  writeFileSync(join(notLock, 'mine.txt'), 'mine');
  acquireLock(d, { waitMs: 0 })();
  assert.deepEqual(readdirSync(d), [basename(notLock)]);
  assert.equal(readFileSync(join(notLock, 'mine.txt'), 'utf8'), 'mine');
});

test('a lock with a corrupt owner (pid or time not a number, not JSON, empty, too large): waited for, said clearly, then taken over once it is a few seconds old', () => {
  const d = temp('prs-install-lock-');
  const lock = join(d, LOCK_NAME);
  const forms = [
    JSON.stringify({ pid: process.pid, host: hostname(), at: 'x', nonce: 'e'.repeat(16) }),
    JSON.stringify({ pid: 'x', host: hostname(), at: Date.now(), nonce: 'e'.repeat(16) }),
    JSON.stringify({ pid: process.pid, host: hostname(), at: 1e300, nonce: 'e'.repeat(16) }),
    '{ not json',
    '',
    JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now(), nonce: 'e'.repeat(16), pad: 'x'.repeat(100000) }),
  ];
  for (const form of forms) {
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), form);
    assert.throws(() => acquireLock(d, { waitMs: 100, pollMs: 50 }), (e) => e.code === 'ELOCKED' && e.message.includes(`remove ${lock} yourself`) && /owner file that is not valid/.test(e.message), form.slice(0, 40));
    const old = new Date(Date.now() - 10000);
    utimesSync(lock, old, old);
    acquireLock(d, { waitMs: 0 })();
    assert.deepEqual(readdirSync(d), [], form.slice(0, 40));
  }
});

test('the same folder written another way (a junction, an 8.3 name) is one entry: not added twice, and the uninstall takes out every spelling', () => {
  const t = home();
  mkdirSync(t.claude, { recursive: true });
  const alias = join(t.h, 'alias');
  symlinkSync(t.claude, alias, 'junction');
  assert.equal(t.run('--claude-dir', t.claude).status, 0);
  const r = t.run('--claude-dir', alias);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /already loads it/);
  assert.equal(t.settings().env[PLUGIN_DIRS_VAR], t.ours, 'one entry');
  assert.equal(samePlace(join(alias, 'perseveranza'), t.dir), true);
  assert.equal(samePlace(join(t.h, 'none-a'), join(t.h, 'none-b')), false);
  // a second spelling already in the list (added by hand): the uninstall takes both out
  t.write({ env: { [PLUGIN_DIRS_VAR]: [t.ours, join(alias, 'perseveranza').replaceAll('\\', '/'), '/opt/other'].join(delimiter) } });
  assert.equal(t.run('--uninstall').status, 0);
  assert.deepEqual(t.settings(), { env: { [PLUGIN_DIRS_VAR]: '/opt/other' } });
  // an 8.3 short name, where the volume has them
  if (process.platform === 'win32') {
    const long = join(t.h, 'long config dir');
    mkdirSync(long);
    const q = spawnSync('cmd', ['/d', '/s', '/c', `"for %I in ("${long}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true });
    const short = (q.stdout || '').trim();
    if (short && short.toLowerCase() !== long.toLowerCase() && existsSync(short)) {
      assert.equal(t.run('--claude-dir', long).status, 0);
      const r2 = t.run('--claude-dir', short);
      assert.equal(r2.status, 0, out(r2));
      const s = JSON.parse(readFileSync(join(long, 'settings.json'), 'utf8'));
      assert.equal(s.env[PLUGIN_DIRS_VAR].split(delimiter).length, 1, `${short}: one entry`);
    }
  }
});

test('a settings hook of 1.x that runs a script the user changed stays (and is named); one that runs the release copy, or a script already gone, goes', async () => {
  const t = home();
  const c = t.claude.replaceAll('\\', '/');
  writeAt(join(t.claude, 'hooks', 'loop-drive.mjs'), '// my own edited loop driver\n');
  const mine = `node "${c}/hooks/loop-drive.mjs"`;
  t.write({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: mine }] }] } });
  for (const args of [[], ['--uninstall']]) {
    const r = t.run(...args);
    assert.equal(r.status, 0, out(r));
    assert.deepEqual(t.settings().hooks, { Stop: [{ matcher: '', hooks: [{ type: 'command', command: mine }] }] });
    assert.match(r.stdout, /Left alone: these settings hooks run a script of perseveranza 1\.x\/2\.x that is not exactly the one it installed/);
    assert.ok(r.stdout.includes(`  ${mine}`));
    assert.equal(readFileSync(join(t.claude, 'hooks', 'loop-drive.mjs'), 'utf8'), '// my own edited loop driver\n');
  }
  // the 1.x copy as its installer wrote it: the hook and the file go
  const v = home();
  await oldInstall(REV.v1, v.claude);
  assert.ok(existsSync(join(v.claude, 'hooks', 'loop-drive.mjs')));
  v.write({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `node "${v.claude.replaceAll('\\', '/')}/hooks/loop-drive.mjs"` }] }] } });
  const rv = v.run();
  assert.equal(rv.status, 0, out(rv));
  assert.match(rv.stdout, /Removed 1 settings hook/);
  assert.equal(v.settings().hooks, undefined);
  assert.ok(!existsSync(join(v.claude, 'hooks', 'loop-drive.mjs')));
  // a 2.x hook into the install folder: it goes while that file is the install's (a 2.x copy, or
  // ours), and stays when the user changed it
  const two = home();
  await oldInstall(REV.v2, two.claude);
  const stopHook = (x) => ({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "${x.ours}/src/shell/stop.mjs"` }] }] } });
  two.write(stopHook(two));
  assert.equal(two.run().status, 0);
  assert.equal(two.settings().hooks, undefined, 'the 2.x hook into a 2.x install goes');
  two.write({ ...two.settings(), ...stopHook(two) });
  const again = two.run();
  assert.match(again.stdout, /Removed 1 settings hook/, 'and into our install');
  two.write({ ...two.settings(), ...stopHook(two) });
  writeFileSync(join(two.dir, 'src', 'shell', 'stop.mjs'), '// changed by the user\n');
  const un = two.run('--uninstall');
  assert.equal(un.status, 0, out(un));
  assert.deepEqual(two.settings().hooks, stopHook(two).hooks, 'a hook running a file of the install the user changed stays');
  assert.match(un.stdout, /Left alone: these settings hooks run a script/);
  // the unit: removable decides for a script under the config dir, never for the plugin's own
  const plan = legacyHookPlan({ hooks: { Stop: [{ hooks: [{ command: mine }, { command: 'node "${CLAUDE_PLUGIN_ROOT}/src/shell/stop.mjs"' }] }] } }, t.claude, { removable: () => false });
  assert.equal(plan.removed, 1);
  assert.deepEqual(plan.kept, [mine]);
  // an install folder without a marker whose script is a copy of this source (not of a release):
  // a file of the install this run recognizes, so its hook goes
  const s = home();
  const rel = ['src', 'shell', 'stop.mjs'];
  const ownStop = readFileSync(join(ROOT, ...rel));
  assert.ok(!isLegacyCopy(`${INSTALL_DIRNAME}/${rel.join('/')}`, ownStop), 'the premise: this source\'s stop.mjs is no release copy');
  writeAt(join(s.dir, ...rel), ownStop);
  s.write(stopHook(s));
  const rs = s.run();
  assert.equal(rs.status, 0, out(rs));
  assert.match(rs.stdout, /Removed 1 settings hook/);
  assert.equal(s.settings().hooks, undefined, 'the hook into a file of the recognized install goes');
});

test('hooks/, agents/ or commands/ that is a link or a junction (a dotfiles repository): nothing removed in it, said', async () => {
  for (const type of process.platform === 'win32' ? ['junction', 'dir'] : ['dir']) {
    const t = home();
    const dotfiles = join(t.h, 'dotfiles-agents');
    writeAt(join(dotfiles, 'pf-verifier.md'), gitShow(REV.v2, 'agents/pf-verifier.md'));
    mkdirSync(t.claude, { recursive: true });
    symlinkSync(dotfiles, join(t.claude, 'agents'), type);
    const r = t.run();
    assert.equal(r.status, 0, out(r));
    assert.ok(existsSync(join(dotfiles, 'pf-verifier.md')), `${type}: the release copy in the link target stays`);
    assert.match(r.stdout, /Left alone: .*agents is a link to .*dotfiles-agents: nothing in it is removed/);
    assert.doesNotMatch(r.stdout, /Removed a file of an earlier install/);
  }
});

test('the identical reinstall also needs the same origin of settings.json: deleted since, it is the install\'s now, and the uninstall removes it', () => {
  const t = home();
  t.write({ model: 'opus' });
  assert.equal(t.run().status, 0);
  assert.equal(readMarker(t.dir).settings, 'existed');
  rmSync(t.settingsPath);
  const r = t.run();
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, /Plugin copied to/);
  assert.equal(readMarker(t.dir).settings, 'created');
  assert.equal(t.run('--uninstall').status, 0);
  assert.ok(!existsSync(t.settingsPath), 'created by the reinstall, holding only its entry: removed');
  // a settings.json that existed and ends as "{}": it stays
  const e = home();
  e.write('{}');
  assert.equal(e.run().status, 0);
  assert.equal(e.run('--uninstall').status, 0);
  assert.equal(e.read(), '{}');
});

test('the copy of the original settings.json is taken by 3.0 even when 2.x left its own: settings.json.bak-perseveranza untouched, a new .bak-perseveranza-3.0', () => {
  const t = home();
  t.write({ mine: 2 });
  writeFileSync(`${t.settingsPath}.bak-perseveranza`, '{"from": "2.x"}');
  const before = t.read();
  const r = t.run();
  assert.equal(r.status, 0, out(r));
  assert.equal(readFileSync(`${t.settingsPath}.bak-perseveranza`, 'utf8'), '{"from": "2.x"}');
  assert.equal(readFileSync(t.settingsPath + BAK, 'utf8'), before);
  assert.equal(BAK, '.bak-perseveranza-3.0');
});

test('the pure parts: the list in the platform\'s separator, compared as paths, spaces around the separator; the checks of parseSettings', () => {
  const s = { env: { [PLUGIN_DIRS_VAR]: 'C:/A;c:\\x\\perseveranza\\;D:/b' } };
  assert.deepEqual(setPluginDir(s, 'C:/X/perseveranza', { add: true, sep: ';', platform: 'win32' }), { changed: false, entries: ['C:/A', 'c:\\x\\perseveranza\\', 'D:/b'], value: 'C:/A;c:\\x\\perseveranza\\;D:/b' });
  assert.equal(s.env[PLUGIN_DIRS_VAR], 'C:/A;c:\\x\\perseveranza\\;D:/b', 'already there: left exactly as it was');
  assert.equal(setPluginDir(s, 'C:/X/perseveranza', { add: false, sep: ';', platform: 'win32' }).changed, true);
  assert.equal(s.env[PLUGIN_DIRS_VAR], 'C:/A;D:/b');
  // spaces around the separator: the same entries, ours not added twice
  const sp = { env: { [PLUGIN_DIRS_VAR]: ' /opt/a : /home/u/.claude/perseveranza ' } };
  assert.equal(setPluginDir(sp, '/home/u/.claude/perseveranza', { add: true, sep: ':', platform: 'linux' }).changed, false);
  setPluginDir(sp, '/home/u/.claude/perseveranza', { add: false, sep: ':', platform: 'linux' });
  assert.equal(sp.env[PLUGIN_DIRS_VAR], ' /opt/a ', 'the rest of the value kept as written');
  const p = { env: { [PLUGIN_DIRS_VAR]: '/a:/b' } };
  setPluginDir(p, '/home/u/.claude/perseveranza', { add: true, sep: ':', platform: 'linux' });
  assert.equal(p.env[PLUGIN_DIRS_VAR], '/a:/b:/home/u/.claude/perseveranza');
  assert.equal(sameDir('/a/B', '/a/b', 'linux'), false);
  assert.equal(sameDir('C:/a/B/', 'c:\\a\\b', 'win32'), true);
  assert.ok(parseSettings('{}').settings);
  assert.equal(parseSettings('\uFEFF{}').bom, true);
  assert.match(parseSettings('[]').error, /not a JSON object/);
  assert.match(parseSettings('{"env": null}').error, /"env" is not an object/);
  const h = { hooks: { Stop: 'weird', X: [null, { hooks: 'no' }] } };
  assert.equal(stripLegacyHooks(h, '/c'), 0);
  assert.deepEqual(h, { hooks: { Stop: 'weird', X: [null, { hooks: 'no' }] } }, 'what it does not recognize, it leaves');
  const empty = { hooks: {} };
  assert.equal(stripLegacyHooks(empty, '/c'), 0);
  assert.deepEqual(empty, { hooks: {} }, 'the user\'s empty "hooks" stays');
});

test('npm run test:mod without claude on the PATH: every step says SKIPPED, nothing runs', () => {
  const empty = temp('prs-nopath-');
  const env = { ...process.env, PATH: empty, Path: empty };
  const r = spawnSync(process.execPath, [join(ROOT, 'test', 'mod', 'run.mjs')], { encoding: 'utf8', env, cwd: ROOT });
  assert.equal(r.status, 0, out(r));
  for (const step of ['claude plugin validate', 'claude plugin test', 'e2e-claude']) assert.ok(r.stdout.includes(`test:mod: ${step}: SKIPPED - claude is not on the PATH`), step);
  assert.ok(!/: ok$|FAILED/m.test(r.stdout));
});
