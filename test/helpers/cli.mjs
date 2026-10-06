// Helpers for verb/e2e tests: a temporary project, a private PERSEVERANZA_HOME, the real
// CLI and the real hook driven with fake Stop events.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { after } from 'node:test';
import { ROOT, GATE_DIRNAME } from '../../src/shell/paths.mjs';
import { LEGACY_ENV } from '../../src/shell/legacy.mjs';

export const HOOK = join(ROOT, 'src', 'shell', 'stop.mjs');
export const SESSION_HOOK = join(ROOT, 'src', 'shell', 'session-start.mjs');
export const ACTIVITY_HOOK = join(ROOT, 'src', 'shell', 'activity-hook.mjs');
export const WATCHDOG = join(ROOT, 'src', 'shell', 'watchdog.mjs');
export const CLI = join(ROOT, 'src', 'cli', 'perseveranza.mjs');
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
  // every PERSEVERANZA_* the tool reads and the 2.x name it replaced (one still set would only
  // add a notice to arm/status, but the output should not depend on the developer's shell)
  ...LEGACY_ENV.flat(),
  'PERSEVERANZA_HOME', 'PERSEVERANZA_LANG', 'CLAUDE_CONFIG_DIR',
  // set in the Bash of a Claude Code session: `arm` would look for the mod's sign of life of
  // the developer's session; the tests of the mod check set it themselves
  'CLAUDE_CODE_SESSION_ID',
];

// A project with its own perseveranza home (config, runs archive) so tests never touch ~/.perseveranza.
export function project({ git = false } = {}) {
  const dir = freshDir();
  const home = freshDir('prs-home-');
  const env = { ...process.env };
  for (const k of OWN_ENV_VARS) delete env[k];
  // English by default in the tests (assertions read the shipped templates); PERSEVERANZA_LANG
  // is deleted by the tests that check the Italian default
  // no detached watchdogs from the tests: the watchdog is exercised synchronously by its own test;
  // no real-time wait for a running subagent (a stop would sleep 30 s): its own test sets it
  Object.assign(env, { PERSEVERANZA_NO_NOTIFY: '1', PERSEVERANZA_HOME: home, PERSEVERANZA_NO_UPDATE_CHECK: '1', PERSEVERANZA_LANG: 'en', PERSEVERANZA_NO_WATCHDOG: '1', PERSEVERANZA_SUBAGENT_WAIT_MS: '0' });
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

export function gate(p, name) { return join(p.dir, GATE_DIRNAME, name); }
export function readState(p) {
  const f = gate(p, 'state.json');
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return 'CORRUPT'; }
}
export function writeState(p, state) { mkdirSync(gate(p, ''), { recursive: true }); writeFileSync(gate(p, 'state.json'), JSON.stringify(state, null, 2)); }
export function patchState(p, fn) { const s = readState(p); fn(s); writeState(p, s); return s; }
export function writePlan(p, text) { writeFileSync(gate(p, 'plan.md'), text); }
// Written as given: a verdict without a requestId exercises the clock fallback; the tests
// that exercise the id take it from the rendered prompt (requestIdFrom).
export function writeArtifact(p, name, obj) { writeFileSync(gate(p, name), typeof obj === 'string' ? obj : JSON.stringify(obj)); }
// The request id exactly as the block reason hands it to the delegated agent.
export function requestIdFrom(reason) { const m = String(reason).match(/"requestId": "([^"]+)"/); return m ? m[1] : null; }

// How a child ended, for an assertion message: an empty output alone says nothing.
export function howItEnded(r) {
  return `pid ${r.pid} exit ${r.status} signal ${r.signal}${r.error ? ` error ${r.error.code || r.error.message}` : ''}; stdout ${JSON.stringify(String(r.stdout || '').slice(0, 300))}; stderr ${JSON.stringify(String(r.stderr || '').slice(0, 300))}`;
}

// A node child of the suite. One that failed without writing a single byte (no stdout, no
// stderr) is started again, at most twice: every script of perseveranza says why it fails (the
// CLI, the hooks and the bridge always write, or exit 0), so a silent non-zero exit is a node
// that never reached our code. Seen only on a starved machine (suites in parallel with a dozen
// busy loops): exit 1 and nothing written, from `arm`, the Stop hook and the bridge alike.
export function runNode(args, opts) {
  let r;
  for (let i = 0; i < 3; i++) {
    if (i > 0) spawnSync(NODE, ['-e', 'setTimeout(() => {}, 200)']);
    r = spawnSync(NODE, args, opts);
    if (r.status === 0 || r.stdout || r.stderr) break;
  }
  return r;
}

export function cli(p, ...args) {
  const r = runNode([CLI, ...args], { cwd: p.dir, encoding: 'utf8', env: p.env });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, ended: howItEnded(r) };
}

export function arm(p, task = 'test task', extra = []) {
  const r = cli(p, 'arm', task, '--external', 'off', '--no-git-finish', ...extra);
  if (r.code !== 0) throw new Error(`arm failed: ${r.ended}`);
  return r;
}

// The mod's sign of life of a Claude Code session, as the mod writes it (src/shell/mod-alive.mjs)
export const MOD_SESSION = 'mod-sess-0001';
export function modAlive(p, session = MOD_SESSION, info = { claudeCode: '2.1.289' }) {
  mkdirSync(join(p.home, 'mod-alive'), { recursive: true });
  writeFileSync(join(p.home, 'mod-alive', `${session}.json`), JSON.stringify({ session, at: Date.now(), ...info }));
}
// arm from inside a session whose mod is alive: the instructions name the tool (loopMode 'tool')
export function armWithMod(p, task = 'test task', extra = [], session = MOD_SESSION) {
  modAlive(p, session);
  const r = runNode([CLI, 'arm', task, '--external', 'off', '--no-git-finish', ...extra], { cwd: p.dir, encoding: 'utf8', env: { ...p.env, CLAUDE_CODE_SESSION_ID: session } });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0) throw new Error(`arm failed: ${howItEnded(r)}`);
  return { code: r.status, out };
}

// Fire a Stop event at the hook -> { blocked, reason, state, raw }
export function fire(p, evt = {}, envExtra = {}) {
  const payload = JSON.stringify({ cwd: p.dir, session_id: 't-sess', hook_event_name: 'Stop', ...evt });
  const r = runNode([HOOK], { input: payload, encoding: 'utf8', env: { ...p.env, ...envExtra } });
  let out = null;
  const trimmed = (r.stdout || '').trim();
  if (trimmed) { try { out = JSON.parse(trimmed); } catch { /* non-JSON */ } }
  return { blocked: !!(out && out.decision === 'block'), reason: (out && out.reason) || '', state: readState(p), raw: r.stdout || '', stderr: r.stderr || '', ended: howItEnded(r) };
}

// Fire a SessionStart event at the hook -> { text (additionalContext or null), out, raw }
export function sessionStart(p, evt = {}, envExtra = {}) {
  const payload = JSON.stringify({ cwd: p.dir, session_id: 't-sess', hook_event_name: 'SessionStart', source: 'startup', ...evt });
  const r = runNode([SESSION_HOOK], { input: payload, encoding: 'utf8', env: { ...p.env, ...envExtra } });
  let out = null;
  const trimmed = (r.stdout || '').trim();
  if (trimmed) { try { out = JSON.parse(trimmed); } catch { /* non-JSON */ } }
  return { text: out ? out.hookSpecificOutput.additionalContext : null, out, raw: r.stdout || '', stderr: r.stderr || '', code: r.status };
}

// Fire a PreToolUse/PostToolUse/SubagentStop event at the activity hook -> { code, raw }
export function activity(p, evt = {}, rawInput = null) {
  const payload = rawInput != null ? rawInput : JSON.stringify({ cwd: p.dir, session_id: 't-sess', hook_event_name: 'PostToolUse', tool_name: 'Bash', ...evt });
  const r = runNode([ACTIVITY_HOOK], { input: payload, encoding: 'utf8', env: p.env });
  return { code: r.status, raw: r.stdout || '', stderr: r.stderr || '' };
}
export function readActivity(p) {
  try { return JSON.parse(readFileSync(gate(p, 'activity.json'), 'utf8')); } catch { return null; }
}
// Run the watchdog synchronously on the gate (it exits by itself) -> { code, stderr }
export function watchdog(p, envExtra = {}) {
  const r = spawnSync(NODE, [WATCHDOG, gate(p, '')], { encoding: 'utf8', env: { ...p.env, ...envExtra }, timeout: 30000 });
  return { code: r.status, stderr: r.stderr || '' };
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
