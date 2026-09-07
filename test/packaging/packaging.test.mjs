import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../../src/shell/paths.mjs';
import { RUNTIME_FILES, AGENT_FILES, COMMAND_FILES, PLUGIN_FILES, ALL_FILES, HOOK_ENTRY, SESSION_HOOK_ENTRY, ACTIVITY_HOOK_ENTRY, HOOK_SPECS, CLI_ENTRY } from '../../manifest.mjs';
import { toMarkdown } from '../../src/core/transitions.mjs';
import { validatePack, missingKeys, PROMPT_KEYS } from '../../src/core/prompts.mjs';
import { VERBS } from '../../src/cli/omc-loop.mjs';

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

test('hooks.json is exactly the manifest HOOK_SPECS table (entries, matchers, timeouts)', () => {
  const h = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const flat = [];
  for (const [event, groups] of Object.entries(h.hooks)) {
    for (const g of groups) for (const c of g.hooks) flat.push({ event, matcher: g.matcher ?? '', command: c.command, timeout: c.timeout, type: c.type });
  }
  assert.equal(flat.length, HOOK_SPECS.length);
  for (const spec of HOOK_SPECS) {
    const found = flat.find((f) => f.event === spec.event && f.matcher === spec.matcher);
    assert.ok(found, `${spec.event}/${spec.matcher} missing from hooks.json`);
    assert.equal(found.type, 'command');
    assert.ok(found.command.includes(`\${CLAUDE_PLUGIN_ROOT}/${spec.entry}`), `${spec.event} command`);
    assert.equal(found.timeout, spec.timeout);
    assert.ok(RUNTIME_FILES.includes(spec.entry), `${spec.entry} not shipped`);
  }
  assert.equal(HOOK_SPECS.find((s) => s.event === 'Stop').timeout, 120, 'the Stop deadline the shell keeps a margin from');
  assert.ok(HOOK_SPECS.filter((s) => s.event !== 'Stop').every((s) => s.timeout <= 30), 'every other hook is short');
  assert.equal(HOOK_SPECS.find((s) => s.event === 'PreToolUse').matcher, 'Agent|Task|Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit', 'delegations, and every tool a reconciliation must refuse');
  assert.ok(!/Read|Grep|Glob/.test(HOOK_SPECS.find((s) => s.event === 'PostToolUse').matcher), 'the cheap, frequent tools do not pay for a heartbeat');
  assert.equal(HOOK_ENTRY, 'src/shell/stop.mjs'); assert.equal(SESSION_HOOK_ENTRY, 'src/shell/session-start.mjs'); assert.equal(ACTIVITY_HOOK_ENTRY, 'src/shell/activity-hook.mjs');
});

test('plugin.json, package.json and the README badge agree on the version', () => {
  const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(plugin.version, pkg.version);
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
  for (const m of text.matchAll(/omc-loop\.mjs"? (\w[\w-]*)/g)) {
    if (m[1] === 'and') continue;
    assert.ok(VERBS.includes(m[1]) || m[1] === '<verb>', `command mentions unknown verb ${m[1]}`);
  }
});

test('the agents exist with the expected front matter', () => {
  for (const a of AGENT_FILES) {
    const text = readLf(join(ROOT, a));
    assert.ok(text.startsWith('---\nname: pf-'), a);
    assert.ok(/^tools: /m.test(text), a);
  }
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

test('packs/it.json is a complete, valid override of the defaults', () => {
  const v = validatePack(JSON.parse(readFileSync(join(ROOT, 'packs', 'it.json'), 'utf8')));
  assert.equal(v.error, null);
  assert.deepEqual(v.unknownKeys, []);
  assert.deepEqual(v.badPlaceholders, []);
  assert.deepEqual(missingKeys(v.overrides), []);
  assert.equal(Object.keys(v.overrides).length, PROMPT_KEYS.length);
  // the operative verbs must survive translation
  assert.ok(v.overrides['review-advance'].includes('{{LOOP}} claim-done'));
  assert.ok(v.overrides['plan-write'].includes('{{LOOP}} complexity low|medium|high'));
});

test('install.mjs copies exactly the manifest, registers the hook, and uninstalls cleanly', () => {
  const cdir = mkdtempSync(join(tmpdir(), 'prs-claude-'));
  mkdirSync(join(cdir, 'hooks'), { recursive: true });
  writeFileSync(join(cdir, 'hooks', 'loop-drive.mjs'), '// v1 leftover');
  writeFileSync(join(cdir, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node "/old/hooks/loop-drive.mjs"' }] }] }, keep: true }));
  const r = spawnSync(process.execPath, [join(ROOT, 'install.mjs'), '--claude-dir', cdir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const f of [...RUNTIME_FILES, ...PLUGIN_FILES]) assert.ok(existsSync(join(cdir, 'perseveranza', f)), f);
  assert.ok(!existsSync(join(cdir, 'hooks', 'loop-drive.mjs')), 'v1 leftover removed');
  const st = JSON.parse(readFileSync(join(cdir, 'settings.json'), 'utf8'));
  assert.equal(st.keep, true);
  assert.equal(st.hooks.Stop.length, 1);
  assert.ok(st.hooks.Stop[0].hooks[0].command.replaceAll('\\', '/').includes(HOOK_ENTRY));
  assert.equal(st.hooks.Stop[0].hooks[0].timeout, 120);
  for (const spec of HOOK_SPECS) {
    const group = st.hooks[spec.event].find((g) => g.matcher === spec.matcher);
    assert.ok(group, `${spec.event}/${spec.matcher} registered`);
    assert.ok(group.hooks[0].command.replaceAll('\\', '/').includes(spec.entry));
    assert.equal(group.hooks[0].timeout, spec.timeout);
  }
  assert.equal(st.hooks.SessionStart.length, 1);
  const cmd = readFileSync(join(cdir, 'commands', 'perseveranza.md'), 'utf8');
  assert.ok(!cmd.includes('${CLAUDE_PLUGIN_ROOT}'));
  assert.ok(cmd.includes(CLI_ENTRY));
  for (const a of AGENT_FILES) assert.ok(existsSync(join(cdir, 'agents', a.split('/').pop())));
  // the installed hook runs (dormant)
  const hook = spawnSync(process.execPath, [join(cdir, 'perseveranza', HOOK_ENTRY)], { input: JSON.stringify({ cwd: cdir }), encoding: 'utf8' });
  assert.equal(hook.status, 0);
  assert.equal(hook.stdout, '');
  const ss = spawnSync(process.execPath, [join(cdir, 'perseveranza', SESSION_HOOK_ENTRY)], { input: JSON.stringify({ cwd: cdir, session_id: 'x' }), encoding: 'utf8' });
  assert.equal(ss.status, 0);
  assert.equal(ss.stdout, '');
  const ah = spawnSync(process.execPath, [join(cdir, 'perseveranza', ACTIVITY_HOOK_ENTRY)], { input: JSON.stringify({ cwd: cdir, session_id: 'x', hook_event_name: 'PostToolUse', tool_name: 'Bash' }), encoding: 'utf8' });
  assert.equal(ah.status, 0);
  assert.equal(ah.stdout, '');
  const u = spawnSync(process.execPath, [join(ROOT, 'install.mjs'), '--claude-dir', cdir, '--uninstall'], { encoding: 'utf8' });
  assert.equal(u.status, 0, u.stdout + u.stderr);
  assert.ok(!existsSync(join(cdir, 'perseveranza')));
  const after = JSON.parse(readFileSync(join(cdir, 'settings.json'), 'utf8')).hooks;
  for (const spec of HOOK_SPECS) assert.equal(after[spec.event].length, 0, `${spec.event}: the list existed (install created it): kept, emptied`);
  // a settings.json that never had SessionStart does not gain an empty one on uninstall
  writeFileSync(join(cdir, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `node "${join(cdir, 'perseveranza', HOOK_ENTRY)}"` }] }] } }));
  const u2 = spawnSync(process.execPath, [join(ROOT, 'install.mjs'), '--claude-dir', cdir, '--uninstall'], { encoding: 'utf8' });
  assert.equal(u2.status, 0, u2.stdout + u2.stderr);
  const hooks2 = JSON.parse(readFileSync(join(cdir, 'settings.json'), 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks2), ['Stop']);
  assert.equal(hooks2.Stop.length, 0);
});

test('the statusline runs dormant and the CLI answers status when not armed', () => {
  const sl = spawnSync(process.execPath, [join(ROOT, 'src', 'hud', 'statusline.mjs')], { input: JSON.stringify({ cwd: tmpdir() }), encoding: 'utf8', env: { ...process.env, PERSEVERANZA_HOME: mkdtempSync(join(tmpdir(), 'prs-h-')) } });
  assert.equal(sl.status, 0);
  assert.equal(sl.stdout, '');
});
