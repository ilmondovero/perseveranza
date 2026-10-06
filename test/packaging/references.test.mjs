// What the documentation names must exist. The READMEs, the command, the agents and the prompts
// (the defaults and packs/it.json) cite repository paths, CLI verbs, /pf verbs, the tool's
// verbs, environment variables, npm scripts, agents and anchors; a rename that misses one of them
// leaves a user (or Claude) with an instruction that fails. These tests read every citation and
// check it against the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT } from '../../src/shell/paths.mjs';
import { AGENT_FILES, COMMAND_FILES } from '../../manifest.mjs';
import { VERBS } from '../../src/cli/perseveranza.mjs';
import { TOOL_VERBS, COMMAND_VERBS } from '../../hooks/lib/verbs.js';
import { DEFAULT_PROMPTS } from '../../src/core/prompts.mjs';

const readLf = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const READMES = ['README.md', 'README.en.md'];
const DOCS = [...READMES, ...COMMAND_FILES, ...AGENT_FILES];
const PACK = JSON.parse(readLf('packs/it.json')).prompts;
// every prompt text, with where it comes from
const PROMPTS = [
  ...Object.entries(DEFAULT_PROMPTS).map(([k, v]) => [`default:${k}`, k, String(v)]),
  ...Object.entries(PACK).map(([k, v]) => [`it:${k}`, k, String(v)]),
];
const ALL = [...DOCS.map((f) => [f, readLf(f)]), ...PROMPTS.map(([where, , text]) => [where, text])];

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.git') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

// A repository path: under one of these folders, not inside another path (~/.claude/hooks/,
// .perseveranza/...), but after a placeholder root (<root>/src/..., ${CLAUDE_PLUGIN_ROOT}/src/...);
// one that goes on with a placeholder or a glob (agents/pf-*.md, verify-<lens>.json) is a pattern.
const REPO_PATH = /(?:(?<=[>}]\/)|(?<![A-Za-z0-9_.~\/-]))((?:src|hooks|packs|commands|agents|docs|bench|test)\/[A-Za-z0-9_.\/-]*[A-Za-z0-9_])(?![A-Za-z0-9_.\/<*{-])/g;

test('every repository path the docs and the prompts cite exists', () => {
  const missing = [];
  let seen = 0;
  for (const [where, text] of ALL) {
    for (const m of text.matchAll(REPO_PATH)) {
      seen += 1;
      if (!existsSync(join(ROOT, m[1]))) missing.push(`${where}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
  assert.ok(seen > 40, `the pattern finds the paths (${seen})`);
});

test('every relative link of the READMEs points at a file, every anchor at a heading of the same file', () => {
  // GitHub's slug: lower case, punctuation out (backticks, apostrophes, slashes...), spaces to '-';
  // a repeated heading gets -1, -2...
  const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  for (const readme of READMES) {
    const text = readLf(readme).replace(/```[\s\S]*?```/g, '');
    const anchors = new Set();
    const count = {};
    for (const m of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
      const s = slug(m[1]);
      anchors.add(count[s] ? `${s}-${count[s]}` : s);
      count[s] = (count[s] || 0) + 1;
    }
    let links = 0;
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      links += 1;
      if (target.startsWith('#')) { assert.ok(anchors.has(target.slice(1)), `${readme}: no heading for ${target}`); continue; }
      const [file, anchor] = target.split('#');
      assert.ok(existsSync(join(ROOT, dirname(readme), file)), `${readme}: ${target} does not exist`);
      if (anchor) assert.ok(readLf(file).length > 0, `${readme}: ${target}`);
    }
    assert.ok(links >= 10, `${readme}: ${links} links checked`);
    // the mod's section and its parts, in both languages
    for (const a of readme === 'README.md' ? ['la-mod', 'requisiti', 'usare-la-mod', 'sicurezza', 'risoluzione-dei-problemi', 'limiti-noti', 'migrazione-dalla-2x-alla-30'] : ['the-mod', 'requirements', 'using-the-mod', 'security', 'troubleshooting', 'known-limits', 'migrating-from-2x-to-30']) {
      assert.ok(anchors.has(a), `${readme}: section #${a}`);
    }
  }
});

test('every CLI verb, /pf verb and tool verb the docs and the prompts cite exists, in the door that runs it', () => {
  const bad = [];
  const n = { cli: 0, pf: 0, tool: 0 };
  for (const [where, text] of ALL) {
    // the CLI: node "<...>/src/cli/perseveranza.mjs" <verb>
    for (const m of text.matchAll(/perseveranza\.mjs"? ([a-z][a-z-]*)/g)) {
      n.cli += 1;
      if (!VERBS.includes(m[1]) && m[1] !== 'and') bad.push(`${where}: CLI verb ${m[1]}`);
    }
    // the user's command
    for (const m of text.matchAll(/(?<![\w/])\/pf ([a-z][a-z-]*)/g)) {
      n.pf += 1;
      if (!COMMAND_VERBS.includes(m[1]) && m[1] !== 'help') bad.push(`${where}: /pf ${m[1]}`);
    }
    // the tool's call, as the docs write it (a placeholder such as "<the first word>" names none)
    for (const m of text.matchAll(/\{"verb": "([^"<]+)"/g)) {
      n.tool += 1;
      if (!TOOL_VERBS.includes(m[1].split(' ')[0])) bad.push(`${where}: tool verb ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(n.cli >= 5 && n.pf > 20 && n.tool > 3, JSON.stringify(n));
});

test('the prompts: {{LOOP}} names only the tool\'s verbs (the tool in tool mode), {{USER}} only /pf\'s, {{BASH}} the CLI\'s', () => {
  const bad = [];
  for (const [where, key, text] of PROMPTS) {
    for (const m of text.matchAll(/\{\{(LOOP|USER|BASH)\}\}\s+([a-z][a-z-]*)/g)) {
      const [, v, verb] = m;
      // hint-ask is rendered with the CLI's LOOP in both modes (machine.mjs askHint): a shell
      // command, prefixed by the words of loop-bash in tool mode
      const allowed = v === 'LOOP' ? (key === 'hint-ask' ? VERBS : TOOL_VERBS) : v === 'USER' ? COMMAND_VERBS : VERBS;
      if (!allowed.includes(verb)) bad.push(`${where}: {{${v}}} ${verb}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('every environment variable the docs and the prompts cite is read by the code', () => {
  const code = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'hooks')), ...walk(join(ROOT, 'bench')), ...walk(join(ROOT, 'test', 'mod')), join(ROOT, 'install.mjs')]
    .filter((p) => /\.(mjs|js|ts|py)$/.test(p) && !p.replaceAll('\\', '/').endsWith('src/shell/legacy.mjs'))
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n');
  // Claude Code's own variables the docs name: read by Claude Code, cited for the user
  const CLAUDE_CODE_OWN = ['CLAUDE_PLUGIN_ROOT'];
  const bad = [];
  let seen = 0;
  for (const [where, text] of ALL) {
    for (const m of text.matchAll(/\b((?:PERSEVERANZA|CLAUDE_CODE|CLAUDE|ENABLE_CLAUDEAI)_[A-Z0-9_]*[A-Z0-9])\b/g)) {
      seen += 1;
      if (CLAUDE_CODE_OWN.includes(m[1])) continue;
      if (!new RegExp(`\\b${m[1]}\\b`).test(code)) bad.push(`${where}: ${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(bad)], []);
  assert.ok(seen > 40, `the pattern finds the variables (${seen})`);
});

test('every npm script and agent the docs cite exists', () => {
  const scripts = Object.keys(JSON.parse(readLf('package.json')).scripts);
  const agents = AGENT_FILES.map((a) => a.split('/').pop().replace(/\.md$/, ''));
  const bad = [];
  for (const [where, text] of ALL) {
    for (const m of text.matchAll(/npm run ([a-z][\w:-]*)/g)) if (!scripts.includes(m[1])) bad.push(`${where}: npm run ${m[1]}`);
    for (const m of text.matchAll(/(?<![\w-])pf-([a-z]+)(?![\w*-])/g)) if (!agents.includes(`pf-${m[1]}`)) bad.push(`${where}: pf-${m[1]}`);
  }
  assert.deepEqual(bad, []);
});
