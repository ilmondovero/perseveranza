// Helpers for verb/e2e tests: a temporary project, a private PERSEVERANZA_HOME, the real
// CLI and the real hook driven with fake Stop events.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { after } from 'node:test';
import { ROOT } from '../../src/shell/paths.mjs';

export const HOOK = join(ROOT, 'src', 'shell', 'stop.mjs');
export const CLI = join(ROOT, 'src', 'cli', 'omc-loop.mjs');
export const NODE = process.execPath;

const tmps = [];
after(() => { for (const d of tmps) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

export function freshDir(prefix = 'prs-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}

// Every variable the tool itself reads. The developer's shell is not the test fixture: whoever
// runs the suite may well have OLLAMA_API_KEY or CLAUDE_CONFIG_DIR exported, and inheriting them
// made assertions pass in CI and fail on a real machine. They are stripped here and set back
// only by the test that wants them; everything else (PATH, HOME, SystemRoot...) is inherited so
// node and git still work.
export const OWN_ENV_VARS = [
  'OLLAMA_API_KEY', 'OLLAMA_HOST', 'OLLAMA_MODEL',
  'OMC_ASK_TIMEOUT_MS', 'OMC_HOOK_TIMEOUT_MS', 'OMC_LOOP_KILL', 'OMC_LOOP_NO_NOTIFY',
  'OMC_NO_UPDATE_CHECK', 'OMC_PROMPT_PACK', 'OMC_SESSION_TAKEOVER_MS',
  'OMC_STATUSLINE_BASE_TIMEOUT_MS', 'OMC_TEST_TIMEOUT_MS',
  'PERSEVERANZA_HOME', 'PERSEVERANZA_LANG', 'CLAUDE_CONFIG_DIR',
];

// A project with its own perseveranza home (config, runs archive) so tests never touch ~/.perseveranza.
export function project({ git = false } = {}) {
  const dir = freshDir();
  const home = freshDir('prs-home-');
  const env = { ...process.env };
  for (const k of OWN_ENV_VARS) delete env[k];
  // English by default in the tests (assertions read the shipped templates); PERSEVERANZA_LANG
  // is deleted by the tests that check the Italian default
  Object.assign(env, { OMC_LOOP_NO_NOTIFY: '1', PERSEVERANZA_HOME: home, OMC_NO_UPDATE_CHECK: '1', PERSEVERANZA_LANG: 'en' });
  if (git) {
    const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    g('init', '-q');
    g('config', 'user.email', 'test@example.invalid');
    g('config', 'user.name', 'test');
    g('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'README.md'), 'hello\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'init');
  }
  return { dir, home, env };
}

export function gate(p, name) { return join(p.dir, '.omc-loop', name); }
export function readState(p) {
  const f = gate(p, 'state.json');
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return 'CORRUPT'; }
}
export function writeState(p, state) { mkdirSync(gate(p, ''), { recursive: true }); writeFileSync(gate(p, 'state.json'), JSON.stringify(state, null, 2)); }
export function patchState(p, fn) { const s = readState(p); fn(s); writeState(p, s); return s; }
export function writePlan(p, text) { writeFileSync(gate(p, 'plan.md'), text); }
export function writeArtifact(p, name, obj) { writeFileSync(gate(p, name), typeof obj === 'string' ? obj : JSON.stringify(obj)); }

export function cli(p, ...args) {
  const r = spawnSync(NODE, [CLI, ...args], { cwd: p.dir, encoding: 'utf8', env: p.env });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

export function arm(p, task = 'test task', extra = []) {
  const r = cli(p, 'arm', task, '--external', 'off', '--no-git-finish', ...extra);
  if (r.code !== 0) throw new Error(`arm failed: ${r.out}`);
  return r;
}

// Fire a Stop event at the hook -> { blocked, reason, state, raw }
export function fire(p, evt = {}, envExtra = {}) {
  const payload = JSON.stringify({ cwd: p.dir, session_id: 't-sess', hook_event_name: 'Stop', ...evt });
  const r = spawnSync(NODE, [HOOK], { input: payload, encoding: 'utf8', env: { ...p.env, ...envExtra } });
  let out = null;
  const trimmed = (r.stdout || '').trim();
  if (trimmed) { try { out = JSON.parse(trimmed); } catch { /* non-JSON */ } }
  return { blocked: !!(out && out.decision === 'block'), reason: (out && out.reason) || '', state: readState(p), raw: r.stdout || '', stderr: r.stderr || '' };
}

export function journal(p) {
  const f = gate(p, 'journal.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// A bare remote + upstream for the project, so push can be verified locally.
export function addRemote(p) {
  const remote = freshDir('prs-remote-');
  const g = (...a) => spawnSync('git', a, { cwd: p.dir, encoding: 'utf8' });
  spawnSync('git', ['init', '-q', '--bare', remote], { encoding: 'utf8' });
  g('remote', 'add', 'origin', remote);
  g('push', '-q', '-u', 'origin', 'HEAD');
  return remote;
}

export const gitOut = (p, ...a) => spawnSync('git', a, { cwd: p.dir, encoding: 'utf8' }).stdout.trim();
export { spawnSync, join, writeFileSync, readFileSync, existsSync };
