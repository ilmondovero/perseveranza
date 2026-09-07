// Kill and restore: the one lever that unblocks a hung turn from outside Claude Code.
// There is no interface to interrupt a running tool; the only interrupt is the user's Esc.
// So the watchdog does what Esc does, harder: it terminates the Claude Code process tree
// that drives the loop, then reopens the same session (`claude -r <id> "<prompt>"`, same
// id, so it keeps owning the loop) in a new console. Verified by hand before being written
// (see docs/REVIEW-NOTES.md): the transcript stays valid after the kill, Claude Code closes
// the interrupted turn itself, and the initial prompt runs.
//
// Three facts learned from that test, all encoded here:
//   - a process launched from inside Claude Code inherits CLAUDE_CODE_CHILD_SESSION and the
//     child then does NOT save its transcript: the marker (and the dead session's messaging
//     socket and token) must be stripped from the environment;
//   - the prompt must reach claude as ONE argument, not through a shell's quoting;
//   - launch from the project directory, where the session belongs.
//
// Everything here is best-effort and platform-bound: Windows gets the full path (process
// tree via CIM, taskkill /T, a new console via `start`); macOS/Linux get the kill and a
// terminal when one can be found. OMC_LOOP_CLAUDE_BIN overrides the binary (tests).
import { spawn, spawnSync } from 'node:child_process';

const WIN = process.platform === 'win32';
const PS = (script, timeout = 15000) => {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout, windowsHide: true });
    return r.status === 0 ? (r.stdout || '').trim() : '';
  } catch { return ''; }
};
// What Claude Code looks like in a process table: the native binary, or node running the
// npm package's cli.js. Deliberately NOT "anything with claude in it": the shipped plugin
// lives under ~/.claude/plugins/..., so the hooks themselves, the watchdog, MCP servers and
// other plugins' hooks all carry that word in their command line.
export function looksLikeClaude(name = '', cmd = '') {
  if (/^claude(\.exe)?$/i.test(name)) return true;
  if (!/^node(\.exe)?$/i.test(name)) return false;
  if (/[\\/]src[\\/]shell[\\/](stop|watchdog|activity-hook|session-start)\.mjs/i.test(cmd)) return false;
  return /@anthropic-ai[\\/]claude-code[\\/]|[\\/]claude-code[\\/]cli\.js|[\\/]claude[\\/]cli\.js/i.test(cmd);
}

const PS_LOOKS = `($p.Name -match '^claude(\\.exe)?$') -or (($p.Name -match '^node(\\.exe)?$') -and -not ($p.CommandLine -match '[\\\\/]src[\\\\/]shell[\\\\/](stop|watchdog|activity-hook|session-start)\\.mjs') -and ($p.CommandLine -match '@anthropic-ai[\\\\/]claude-code[\\\\/]|[\\\\/]claude-code[\\\\/]cli\\.js|[\\\\/]claude[\\\\/]cli\\.js'))`;

// Walk up from the PARENT of this process to the Claude Code process that (indirectly)
// spawned it. The hook itself is never a candidate. -> { pid, startedAt, name } or null.
export function findClaudeProcess(fromPid = process.pid) {
  if (!(Number(fromPid) > 0)) return null;
  if (WIN) {
    const out = PS(`$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${Math.trunc(fromPid)}"
if ($p) { $p = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ParentProcessId)" }
for ($i = 0; $i -lt 12 -and $p; $i++) {
  if (${PS_LOOKS}) { '{0}|{1}|{2}' -f $p.ProcessId, $p.CreationDate.ToUniversalTime().ToString('o'), $p.Name; break }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ParentProcessId)"
}`);
    const [pid, startedAt, name] = out.split('|');
    return Number(pid) > 0 ? { pid: Number(pid), startedAt: startedAt || null, name: name || '' } : null;
  }
  let pid = fromPid;
  for (let i = 0; i < 13 && pid > 1; i++) {
    let line = '';
    try { line = spawnSync('ps', ['-o', 'ppid=,lstart=,comm=,args=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).stdout.trim(); } catch { return null; }
    if (!line) return null;
    const m = line.match(/^\s*(\d+)\s+(.{24})\s+(\S+)\s+(.*)$/);
    if (!m) return null;
    if (i > 0 && looksLikeClaude(m[3], m[4])) return { pid, startedAt: m[2].trim(), name: m[3] };
    pid = Number(m[1]);
  }
  return null;
}

// -> { alive, startedAt, name } for the pid-reuse guard.
export function processInfo(pid) {
  if (!(pid > 0)) return { alive: false };
  if (WIN) {
    const out = PS(`$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { '{0}|{1}|{2}' -f $p.CreationDate.ToUniversalTime().ToString('o'), $p.Name, $p.CommandLine }`, 10000);
    if (!out) return { alive: false };
    const [startedAt, name, cmd] = out.split('|');
    return { alive: true, startedAt: startedAt || null, name: name || '', cmd: cmd || '' };
  }
  try {
    const line = spawnSync('ps', ['-o', 'lstart=,comm=,args=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).stdout.trim();
    if (!line) return { alive: false };
    const m = line.match(/^(.{24})\s+(\S+)\s+(.*)$/);
    return m ? { alive: true, startedAt: m[1].trim(), name: m[2], cmd: m[3] } : { alive: true, startedAt: null, name: '', cmd: '' };
  } catch { return { alive: false }; }
}

// The process recorded at the last Stop is still that process (not a reused pid)? A kill
// primitive fails closed: no start time on either side means "not proven", not "fine".
export function sameProcess(info, recordedStartedAt) {
  if (!info || !info.alive) return false;
  if (!looksLikeClaude(info.name, info.cmd || '')) return false;
  if (!recordedStartedAt || !info.startedAt) return false;
  return Math.abs(Date.parse(info.startedAt) - Date.parse(recordedStartedAt)) < 2000;
}

// Terminate the process and everything under it. -> true when it is gone.
export function killTree(pid) {
  if (!(pid > 0)) return false;
  try {
    if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000, windowsHide: true });
    else {
      try { spawnSync('pkill', ['-TERM', '-P', String(pid)], { stdio: 'ignore', timeout: 5000 }); } catch { /* no pkill */ }
      try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    }
  } catch { /* best-effort */ }
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (!processInfo(pid).alive) return true;
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); } catch { /* no wait */ }
  }
  return !processInfo(pid).alive;
}

// The environment a restored session must NOT inherit from the hook that spawned the
// watchdog: everything Claude Code sets about ITS session (the child marker that turns
// transcript saving off, the messaging socket and token, the bridge and session ids, the
// entrypoint). Claude Code sets its own on start; nothing of the dead session may leak.
export function cleanEnv(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete out[k];
  }
  return out;
}

// Reopen the session with an initial prompt, in a new console, from the project directory.
// -> { ok, how, error? }
export function launchRestore({ cwd, sessionId, prompt, env = process.env }) {
  const e = cleanEnv(env);
  const bin = e.OMC_LOOP_CLAUDE_BIN || 'claude';
  const args = ['-r', sessionId, prompt];
  try {
    if (e.OMC_LOOP_CLAUDE_BIN) {
      // a test double: run it directly, no console
      spawn(process.execPath, [bin, ...args], { cwd, env: e, detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return { ok: true, how: 'direct' };
    }
    if (WIN) {
      // cmd.exe expands %VAR% even inside quotes and a newline ends the command line:
      // neither may survive in the prompt. The command line is capped at 8191 chars.
      const q = (s) => `"${String(s).replace(/[\r\n]+/g, ' ').replace(/%/g, ' percent').replace(/"/g, "'").slice(0, 4000)}"`;
      spawn('cmd.exe', ['/c', 'start', '"perseveranza restore"', bin, '-r', sessionId, q(prompt)], { cwd, env: e, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
      return { ok: true, how: 'start' };
    }
    if (process.platform === 'darwin') {
      const sh = `cd ${JSON.stringify(cwd)} && ${bin} -r ${sessionId} ${JSON.stringify(prompt)}`;
      spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(sh)}`], { env: e, detached: true, stdio: 'ignore' }).unref();
      return { ok: true, how: 'osascript' };
    }
    for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
      const found = spawnSync('which', [term], { stdio: 'ignore' }).status === 0;
      if (!found) continue;
      const tail = term === 'gnome-terminal' ? ['--', bin, ...args] : ['-e', bin, ...args];
      spawn(term, tail, { cwd, env: e, detached: true, stdio: 'ignore' }).unref();
      return { ok: true, how: term };
    }
    return { ok: false, how: 'none', error: 'no terminal emulator found' };
  } catch (err) {
    return { ok: false, how: 'error', error: err && err.message };
  }
}
