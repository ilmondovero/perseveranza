#!/usr/bin/env node
// The files earlier manual installs (1.x, 2.x) wrote under the Claude Code config dir, as exact
// sha256 hashes, computed from git: for every commit of the releases (LEGACY_ANCHORS), the installer of that
// commit (install.ps1 or install.mjs) tells which files it copied where, and how it changed
// them; the files themselves are read from the same commit. install.mjs removes a leftover only
// when its hash is in this table (src/shell/legacy-hashes.mjs); every other file is only named.
//
//   node scripts/legacy-hashes.mjs           prints the table as the module it belongs in
//   node scripts/legacy-hashes.mjs --write   writes src/shell/legacy-hashes.mjs
//
// test/packaging/legacy-hashes.test.mjs recomputes it from git (when the repository is there)
// and checks it equals the committed table, hash for hash.
//
// The table: { files: { '<path under the config dir>': [sha256...] }, commands: { <form>: [sha256...] } }
//   files     copied verbatim: hooks/<1.x script>, agents/pf-*.md, perseveranza/<2.x plugin file>
//   commands  commands/perseveranza.md, by the form its installer wrote (see commandForms in
//             install.mjs): 'verbatim'; 'v1-cli' (the 1.x CLI path written in place of
//             ${CLAUDE_PLUGIN_ROOT}/scripts/<the 1.x CLI file>); 'v2-root' (the 2.x install folder
//             written in place of ${CLAUDE_PLUGIN_ROOT}). The hash is of the text with that path
//             put back, so the table does not depend on where the config dir was.
// Each text file is hashed as committed and with the other line ends (a Windows checkout
// without the .gitattributes of later versions wrote CRLF).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_V1_CLI_FILE } from '../src/shell/legacy.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const TABLE_MODULE = join(ROOT, 'src', 'shell', 'legacy-hashes.mjs');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
// the hashes of a text as committed and with the other line ends
export function variants(buf) {
  const out = new Set([sha(buf)]);
  const text = buf.toString('latin1');
  if (text.includes('\r\n')) out.add(sha(Buffer.from(text.replaceAll('\r\n', '\n'), 'latin1')));
  else if (text.includes('\n')) out.add(sha(Buffer.from(text.replaceAll('\n', '\r\n'), 'latin1')));
  return [...out];
}

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

// The contents of many blobs in one git call: -> Map<blob id, Buffer>
function readBlobs(repo, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const r = spawnSync('git', ['cat-file', '--batch'], { cwd: repo, input: `${ids.join('\n')}\n`, maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) return out;
  const buf = r.stdout;
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    if (nl < 0) break;
    const [id, type, size] = buf.subarray(at, nl).toString('utf8').split(' ');
    if (type === 'missing') { at = nl + 1; continue; }
    const n = Number(size);
    out.set(id, buf.subarray(nl + 1, nl + 1 + n));
    at = nl + 1 + n + 1;
  }
  return out;
}

// What the installer of one commit copied: -> { copies: [[target, source]], command: [form, source] | null }
export async function planOf(ps1, mjs, manifest) {
  const copies = [];
  let command = null;
  if (ps1) {
    // install.ps1: Copy-Item of hooks\*.ps1 into <dir>/hooks, and of the command, verbatim
    for (const m of ps1.toString('utf8').matchAll(/Copy-Item \(Join-Path \$src '([^']+)'\)\s+\(Join-Path \$ClaudeDir '(hooks|commands)'\)/g)) {
      const from = m[1].replaceAll('\\', '/');
      if (m[2] === 'commands') command = ['verbatim', from];
      else copies.push([`hooks/${from.split('/').pop()}`, from]);
    }
  }
  if (mjs) {
    const text = mjs.toString('utf8');
    // 3.0 and later: every install carries its marker, which lists its files with their hashes
    if (text.includes("'.perseveranza-install.json'")) return { copies, command };
    if (text.includes('RUNTIME_FILES')) {
      // 2.x: the manifest's runtime and plugin files into <dir>/perseveranza, the agents into
      // <dir>/agents, the command with ${CLAUDE_PLUGIN_ROOT} -> the install folder
      if (manifest) {
        const m = await import(`data:text/javascript;base64,${manifest.toString('base64')}`);
        for (const rel of [...(m.RUNTIME_FILES || []), ...(m.PLUGIN_FILES || [])]) copies.push([`perseveranza/${rel}`, rel]);
        for (const a of m.AGENT_FILES || []) copies.push([`agents/${a.split('/').pop()}`, a]);
        for (const c of m.COMMAND_FILES || []) command = ['v2-root', c];
      }
    } else {
      // 1.x: copyFileSync(join(src, '<dir>', '<name>'), ...) into <dir>/hooks; the agents of
      // its AGENTS list; the command with the CLI path written in, or verbatim
      for (const m of text.matchAll(/copyFileSync\(join\(src, '(scripts|hooks)', '([^']+)'\)/g)) copies.push([`hooks/${m[2]}`, `${m[1]}/${m[2]}`]);
      const agents = /const AGENTS = \[([^\]]*)\]/.exec(text);
      if (agents) for (const a of agents[1].matchAll(/'([^']+)'/g)) copies.push([`agents/${a[1]}`, `agents/${a[1]}`]);
      if (text.includes(`replaceAll('${'${CLAUDE_PLUGIN_ROOT}'}/scripts/${LEGACY_V1_CLI_FILE}'`)) command = ['v1-cli', 'commands/perseveranza.md'];
      else if (text.includes("copyFileSync(join(src, 'commands', 'perseveranza.md')")) command = ['verbatim', 'commands/perseveranza.md'];
    }
  }
  return { copies, command };
}

// The releases the table covers: every commit reachable from these, and nothing else (not the
// other branches, stashes or remotes of the clone that runs it, so every clone computes the same
// table). a263a0c is 2.6.0, the last version whose manual install had no marker: from 3.0 on an
// install lists its own files with their hashes, and nothing needs adding here. Only if a future
// installer ever copied files outside its marker again would its release commit go in this list,
// followed by `node scripts/legacy-hashes.mjs --write` (a step of the release checklist in
// docs/PIANO-MOD.md).
export const LEGACY_ANCHORS = ['a263a0c2eb696f2d886a65ec731bdad33fd423b8'];

// -> the table, or null when repo is not a git repository with this project's history
export async function computeLegacyHashes(repo = ROOT, anchors = LEGACY_ANCHORS) {
  const revs = git(repo, ['rev-list', ...anchors]);
  if (!revs || !revs.trim()) return null;
  // every tree once (path -> blob id), every blob read once
  const trees = new Map();
  for (const rev of revs.trim().split('\n')) {
    const ls = git(repo, ['ls-tree', '-r', rev]) || '';
    trees.set(rev, new Map(ls.split('\n').filter(Boolean).map((l) => { const [meta, path] = l.split('\t'); return [path, meta.split(' ')[2]]; })));
  }
  const blobs = new Map();
  const fetch = (ids) => { for (const [k, v] of readBlobs(repo, [...new Set(ids)].filter((x) => x && !blobs.has(x)))) blobs.set(k, v); };
  const show = (rev, path) => { const id = trees.get(rev).get(path); return id ? blobs.get(id) || null : null; };
  fetch([...trees.values()].flatMap((t) => ['install.ps1', 'install.mjs', 'manifest.mjs'].map((p) => t.get(p))));
  const plans = [];
  for (const rev of trees.keys()) plans.push([rev, await planOf(show(rev, 'install.ps1'), show(rev, 'install.mjs'), show(rev, 'manifest.mjs'))]);
  fetch(plans.flatMap(([rev, p]) => [...p.copies.map(([, from]) => trees.get(rev).get(from)), p.command && trees.get(rev).get(p.command[1])]));
  const files = new Map();
  const commands = { verbatim: new Set(), 'v1-cli': new Set(), 'v2-root': new Set() };
  for (const [rev, { copies, command }] of plans) {
    for (const [target, from] of copies) {
      const buf = show(rev, from);
      if (!buf) continue;
      if (!files.has(target)) files.set(target, new Set());
      for (const h of variants(buf)) files.get(target).add(h);
    }
    if (command) {
      const buf = show(rev, command[1]);
      if (buf) for (const h of variants(buf)) commands[command[0]].add(h);
    }
  }
  const sorted = (set) => [...set].sort();
  return {
    files: Object.fromEntries([...files.keys()].sort().map((k) => [k, sorted(files.get(k))])),
    commands: Object.fromEntries(Object.keys(commands).map((k) => [k, sorted(commands[k])])),
  };
}

export function tableModule(table) {
  return `// GENERATED by scripts/legacy-hashes.mjs from the git history: do not edit by hand.
// The exact sha256 of every file an earlier manual install (1.x, 2.x) wrote under the Claude
// Code config dir; install.mjs removes a leftover only when its hash is here (the script says
// how each installer copied and changed its files). test/packaging/legacy-hashes.test.mjs
// checks it against git.
export const LEGACY_HASHES = ${JSON.stringify(table, null, 1)};
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const table = await computeLegacyHashes();
  if (!table) { console.error('not a git repository with the history of perseveranza'); process.exit(1); }
  const text = tableModule(table);
  if (process.argv.includes('--write')) { writeFileSync(TABLE_MODULE, text); console.log(`written: ${TABLE_MODULE}`); }
  else process.stdout.write(text);
}
