import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../../src/shell/paths.mjs';
import * as manifest from '../../manifest.mjs';
import { RUNTIME_FILES, AGENT_FILES, COMMAND_FILES, PLUGIN_FILES, ALL_FILES, CLI_ENTRY, MOD_ENTRY, MOD_FILES } from '../../manifest.mjs';
import { toMarkdown } from '../../src/core/transitions.mjs';
import { validatePack, missingKeys, PROMPT_KEYS, PROMPT_EXPECTED, DEFAULT_PROMPTS } from '../../src/core/prompts.mjs';
import { VERBS } from '../../src/cli/perseveranza.mjs';
import { cmpSemver } from '../../src/update.mjs';

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const rel = (p) => p.slice(ROOT.length + 1).replaceAll('\\', '/');
// tolerate CRLF checkouts (Windows runners with autocrlf): compare on LF
const readLf = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

test('every manifest file exists', () => {
  for (const f of ALL_FILES) assert.ok(existsSync(join(ROOT, f)), `missing ${f}`);
});

test('every runtime file under src/ and packs/ is in the manifest', () => {
  const onDisk = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'packs'))].map(rel);
  for (const f of onDisk) assert.ok(RUNTIME_FILES.includes(f), `${f} is not in manifest.mjs`);
});

test('hooks.json names the mod and nothing else: no settings hook is registered by the plugin (never two drivers)', () => {
  const h = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(h).sort(), ['description', 'modules']);
  assert.deepEqual(h.modules, ['./register.js']);
  assert.equal(`hooks/${h.modules[0].slice(2)}`, MOD_ENTRY);
  assert.ok(!('hooks' in h), 'no classic hook (Stop, SessionStart, PreToolUse, PostToolUse, SubagentStop)');
  for (const event of ['Stop', 'SessionStart', 'PreToolUse', 'PostToolUse', 'SubagentStop']) assert.ok(!readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8').includes(`"${event}"`), event);
});

test('no classic hook is declared anywhere: not by the manifest, not by install.mjs (the mod alone drives the loop)', () => {
  for (const name of ['HOOK_SPECS', 'HOOK_ENTRY', 'SESSION_HOOK_ENTRY', 'ACTIVITY_HOOK_ENTRY']) assert.ok(!(name in manifest), `manifest exports ${name}`);
  const install = readLf(join(ROOT, 'install.mjs')).replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/HOOK_SPECS|hooks\[[^\]]*\]\.push|\.hooks\s*\?\?=|type:\s*'command'/.test(install), 'install.mjs writes no settings hook');
  assert.ok(install.includes("'CLAUDE_CODE_PLUGIN_DIRS'"));
  // what it writes, for real: test/packaging/install.test.mjs (a settings.json with no "hooks")
});

// The relative imports of a module file (static import declarations; a hooks module may have no other).
const importsOf = (text) => [...text.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm), ...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

test('the mod: every file under hooks/ is in the manifest, and every file it imports is shipped', () => {
  const onDisk = walk(join(ROOT, 'hooks')).map(rel).filter((f) => f !== 'hooks/hooks.json');
  assert.deepEqual(onDisk.sort(), [...MOD_FILES].sort());
  for (const f of MOD_FILES) assert.ok(PLUGIN_FILES.includes(f), f);
  const shipped = new Set([...RUNTIME_FILES, ...PLUGIN_FILES]);
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    assert.ok(shipped.has(file), `${file} is reached by the mod but not shipped`);
    for (const spec of importsOf(readFileSync(join(ROOT, file), 'utf8'))) {
      if (spec === 'claude-code') continue;
      assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${file}: a hooks module imports only relative paths (${spec})`);
      visit(join(dirname(file), spec).replaceAll('\\', '/'));
    }
  };
  visit(MOD_ENTRY);
  assert.ok(seen.has('src/core/subagents.mjs'), 'the mod reuses the pure core');
  // what the mod reaches runs with no Node API and no timer globals
  for (const file of seen) {
    const text = readFileSync(join(ROOT, file), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/from\s+['"]node:/.test(text), `${file} imports node:`);
    assert.ok(!/process\.(env|cwd|exit|argv|platform)|require\(|setTimeout\(|setInterval\(|import\(/.test(text), `${file} uses a Node API, a timer global or a dynamic import`);
  }
});

test('plugin.json, package.json and the README badge agree on the version', () => {
  const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(plugin.version, pkg.version);
  // the 3.0 names and the mod: the bench refuses an engine below 3.0.0
  assert.ok(cmpSemver(plugin.version, '3.0.0') >= 0, plugin.version);
  for (const readme of ['README.md', 'README.en.md']) {
    const text = readFileSync(join(ROOT, readme), 'utf8');
    assert.ok(text.includes(`versione-${plugin.version}-`) || text.includes(`version-${plugin.version}-`), `${readme} badge != ${plugin.version}`);
  }
});

test('the command references the CLI entry and every verb it documents exists', () => {
  const text = readLf(join(ROOT, COMMAND_FILES[0]));
  assert.ok(text.includes(`\${CLAUDE_PLUGIN_ROOT}/${CLI_ENTRY}`));
  for (const v of ['arm', 'test', 'report', 'complexity', 'claim-done', 'ask', 'pause', 'resume', 'disarm', 'status']) {
    assert.ok(text.includes(v), `command does not mention verb ${v}`);
  }
  for (const m of text.matchAll(/perseveranza.mjs"? (\w[\w-]*)/g)) {
    if (m[1] === 'and') continue;
    assert.ok(VERBS.includes(m[1]) || m[1] === '<verb>', `command mentions unknown verb ${m[1]}`);
  }
});

test('the agents exist with the expected front matter', () => {
  for (const a of AGENT_FILES) {
    const text = readLf(join(ROOT, a));
    assert.ok(text.startsWith('---\nname: pf-'), a);
    assert.ok(/^tools: /m.test(text), a);
    const fm = text.slice(4, text.indexOf('\n---\n', 4));
    // ignored for plugin subagents: writing them here would promise something that never happens
    assert.ok(!/^(hooks|mcpServers|permissionMode):/m.test(fm), `${a}: field ignored for plugin subagents`);
    // the judges are bounded, and loosely: a judge cut short writes no verdict, which the
    // machine reads as a missing outcome
    if (!a.endsWith('pf-executor.md')) {
      const turns = Number((fm.match(/^maxTurns: (\d+)$/m) || [])[1]);
      assert.ok(turns >= 120, `${a}: maxTurns missing or too tight`);
    }
  }
  assert.ok(/^effort: high$/m.test(readLf(join(ROOT, AGENT_FILES.find((a) => a.endsWith('pf-verifier.md'))))));
});

test('the advisor agent ships: consultative, read-only, one free-text file, no verdict', () => {
  const a = AGENT_FILES.find((f) => f.endsWith('pf-advisor.md'));
  assert.ok(a, 'pf-advisor.md in the manifest (install copies it, uninstall removes it)');
  const text = readLf(join(ROOT, a));
  const fm = text.slice(4, text.indexOf('\n---\n', 4));
  assert.ok(/^name: pf-advisor$/m.test(fm));
  assert.ok(/^tools: Read, Grep, Glob, Bash, Write$/m.test(fm));
  assert.ok(/^model: inherit$/m.test(fm));
  assert.ok(/^effort: high$/m.test(fm));
  assert.ok(text.includes('.perseveranza/advisor-<slot>-<n>.md'));
  assert.ok(text.includes('No JSON, no request id, no verdict'));
  assert.ok(text.includes('NOT allowed to modify'));
  for (const section of ['Diagnosis / critique', 'The 3 main risks', 'What I would change', 'What I could not verify']) assert.ok(text.includes(section), section);
  // the command and both READMEs tell about it
  assert.ok(readLf(join(ROOT, COMMAND_FILES[0])).includes('pf-advisor'));
  for (const readme of ['README.md', 'README.en.md']) assert.ok(readLf(join(ROOT, readme)).includes('pf-advisor'), readme);
});

test('the README transition tables are generated from the code (both languages)', () => {
  const md = toMarkdown();
  for (const readme of ['README.md', 'README.en.md']) {
    const text = readLf(join(ROOT, readme));
    const m = text.match(/<!-- transitions:start -->\n([\s\S]*?)\n<!-- transitions:end -->/);
    assert.ok(m, `${readme}: transitions block missing`);
    assert.equal(m[1].trim(), md.trim(), `${readme}: run \`npm run explain -- --markdown\` and paste between the markers`);
  }
});

test('the default prompts that delegate a verdict hand out its request id; a pack without it is warned about', () => {
  for (const [key, names] of Object.entries(PROMPT_EXPECTED)) {
    for (const name of names) assert.ok(DEFAULT_PROMPTS[key].includes(`{{${name}}}`), `${key} lacks {{${name}}}`);
  }
  const old = validatePack({ prompts: { 'review-delegate': 'Delegate to {{reviewerRef}}.', 'final-verify': 'Verify with {{verifierRef}} and {{verdictRequestId}}.' } });
  assert.deepEqual(old.badPlaceholders, []);
  assert.deepEqual(old.missingPlaceholders, [{ key: 'review-delegate', placeholder: 'verdictRequestId' }]);
});

test('packs/it.json is a complete, valid override of the defaults', () => {
  const v = validatePack(JSON.parse(readFileSync(join(ROOT, 'packs', 'it.json'), 'utf8')));
  assert.equal(v.error, null);
  assert.deepEqual(v.unknownKeys, []);
  assert.deepEqual(v.badPlaceholders, []);
  assert.deepEqual(v.missingPlaceholders, [], 'the prompts that delegate a verdict hand out its request id');
  assert.deepEqual(missingKeys(v.overrides), []);
  assert.equal(Object.keys(v.overrides).length, PROMPT_KEYS.length);
  // the operative verbs must survive translation
  assert.ok(v.overrides['review-advance'].includes('{{LOOP}} claim-done'));
  assert.ok(v.overrides['plan-write'].includes('{{LOOP}} complexity low|medium|high'));
});

test('the final verification by lenses: prompts in both languages hand out the lens list and the id', () => {
  assert.deepEqual(PROMPT_EXPECTED['final-verify-lenses'], ['verdictRequestId', 'lensList']);
  assert.ok(PROMPT_EXPECTED['verify-missing-lenses'].includes('lensList'));
  const it = validatePack(JSON.parse(readFileSync(join(ROOT, 'packs', 'it.json'), 'utf8'))).overrides;
  for (const key of ['final-verify-lenses', 'verify-missing-lenses', 'hint-lens', 'hint-verify-recheck', 'lens-general', 'lens-correctness', 'lens-security', 'lens-tests']) {
    assert.equal(typeof DEFAULT_PROMPTS[key], 'string', `default ${key}`);
    assert.equal(typeof it[key], 'string', `it ${key}`);
  }
  for (const prompts of [DEFAULT_PROMPTS, it]) {
    assert.ok(prompts['final-verify-lenses'].includes('{{lensList}}') && prompts['final-verify-lenses'].includes('{{priorVerifyHint}}'));
    assert.ok(prompts['final-verify'].includes('{{priorVerifyHint}}'), 'the single verifier rechecks the rejected rounds too');
    assert.ok(prompts['verify-missing-lenses'].includes('{{missingLenses}}') && prompts['verify-missing-lenses'].includes('{{LOOP}} report fail') && !prompts['verify-missing-lenses'].includes('{{LOOP}} report pass'), 'a pass is never self-declared with lenses missing');
    assert.ok(prompts['hint-lens'].includes('{{lensFile}}') && prompts['hint-lens'].includes('{{verdictRequestId}}'));
  }
  // a pack written before the lenses is warned about nothing it could not know
  const old = validatePack({ prompts: { 'final-verify': 'Verify with {{verdictRequestId}}.' } });
  assert.deepEqual(old.missingPlaceholders, []);
  const lensless = validatePack({ prompts: { 'final-verify-lenses': 'Verify {{verdictRequestId}}.' } });
  assert.deepEqual(lensless.missingPlaceholders, [{ key: 'final-verify-lenses', placeholder: 'lensList' }]);
  // the verifier agent knows the lens files
  const verifier = readLf(join(ROOT, AGENT_FILES.find((a) => a.endsWith('pf-verifier.md'))));
  assert.ok(verifier.includes('## Lenses') && verifier.includes('.perseveranza/verify-<lens>.json') && verifier.includes('"lens": "<your lens>"'));
});

test('the statusline runs dormant and the CLI answers status when not armed', () => {
  const home = mkdtempSync(join(tmpdir(), 'prs-h-'));
  try {
    const sl = spawnSync(process.execPath, [join(ROOT, 'src', 'hud', 'statusline.mjs')], { input: JSON.stringify({ cwd: tmpdir() }), encoding: 'utf8', env: { ...process.env, PERSEVERANZA_HOME: home } });
    assert.equal(sl.status, 0);
    assert.equal(sl.stdout, '');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
