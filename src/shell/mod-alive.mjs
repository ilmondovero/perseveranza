// The mod's sign of life, for `arm`: is the perseveranza mod loaded in THIS Claude Code session?
//
// `arm` runs as a plain Node process (a Bash call of the session, or a terminal) and cannot ask
// Claude Code which mods it loaded. The mod tells it with a small file of its own, written at
// every session start (session.start, classic.SessionStart: a /clear or a resume brings a new
// session id), before `/pf arm`, and again at the session's tool calls (at most every 10 min,
// hooks/lib/verbs.js refreshAlive: a long-lived session keeps a young file):
//
//   <perseveranza home>/mod-alive/<session id>.json   { session, at, claudeCode, plugin, cwd }
//
// (home: PERSEVERANZA_HOME, else ~/.perseveranza, as everywhere). Claude Code gives the Bash
// tool the same id as CLAUDE_CODE_SESSION_ID (verified on 2.1.289: the variable in Bash equals
// the mod's $.session.id()), so `arm` looks for its own session's file and nothing else.
//
// An ephemeral fact, not loop state: nothing else reads it, a missing one only makes `arm`
// refuse (with the causes and the way out). The old files go (pruneAlive) at every `arm` and
// when the mod, at a session start, finds too many or an old one (the bridge's op 'alive' with
// facts.prune: the mod cannot delete, $.fs has no unlink). A file younger than ALIVE_PROTECT_MS
// is never pruned: its session called a tool in the last day, or just started.
import { readFileSync, readdirSync, statSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { home } from './paths.mjs';
import { writeDurable } from './state-file.mjs';

export const ALIVE_DIR = 'mod-alive';
// a session's file older than this is removed (it is rewritten at every start of its session)
export const ALIVE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
// and past this many files, the oldest go (claude -p children each leave one), but never one
// younger than ALIVE_PROTECT_MS (a session alive in the last day keeps its file: it is rewritten
// at its tool calls)
export const ALIVE_KEEP = 100;
export const ALIVE_PROTECT_MS = 24 * 3600 * 1000;
// what a session id may look like before it becomes a file name (a UUID in practice)
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const aliveDir = (env = process.env) => join(home(env), ALIVE_DIR);

// -> the path of a session's file, or null for an id that is not one
export function alivePath(sessionId, env = process.env) {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId) ? join(aliveDir(env), `${sessionId}.json`) : null;
}

// The session `arm` runs in, from Claude Code's environment: { id } | { id: null, bad? }
export function currentSession(env = process.env) {
  const raw = typeof env.CLAUDE_CODE_SESSION_ID === 'string' ? env.CLAUDE_CODE_SESSION_ID.trim() : '';
  if (!raw) return { id: null };
  return SESSION_ID_RE.test(raw) ? { id: raw } : { id: null, bad: raw.slice(0, 40) };
}

// -> { alive: true, info } | { alive: false, path }. The file is written by the mod with $.fs.write,
// which is not atomic: its presence is the fact, its content is only shown.
export function readAlive(sessionId, env = process.env) {
  const p = alivePath(sessionId, env);
  if (!p || !existsSync(p)) return { alive: false, path: p };
  let info = null;
  try { info = JSON.parse(readFileSync(p, 'utf8')); } catch { /* half written: still a sign of life */ }
  return { alive: true, path: p, info: info && typeof info === 'object' && !Array.isArray(info) ? info : null };
}

// The bridge's fallback when the mod's own $.fs.write is refused: the same file, written durably.
// -> { ok: true, path } | { ok: false, error }
export function writeAlive(sessionId, info, env = process.env) {
  const p = alivePath(sessionId, env);
  if (!p) return { ok: false, error: 'not a session id' };
  try {
    mkdirSync(aliveDir(env), { recursive: true });
    const w = writeDurable(p, JSON.stringify({ ...(info && typeof info === 'object' ? info : {}), session: sessionId }));
    return w.ok ? { ok: true, path: p } : { ok: false, error: String(w.error || 'not written') };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// Removes the files of sessions not seen for maxAgeMs, then the oldest past maxFiles among those
// older than protectMs; only its own files (<session id>.json), never `keep`'s. Never throws.
// -> how many were removed
export function pruneAlive(env = process.env, { now = Date.now(), keep = null, maxAgeMs = ALIVE_MAX_AGE_MS, maxFiles = ALIVE_KEEP, protectMs = ALIVE_PROTECT_MS } = {}) {
  let removed = 0;
  let names = [];
  try { names = readdirSync(aliveDir(env)); } catch { return 0; }
  const files = [];
  for (const n of names) {
    if (!/\.json$/.test(n) || !SESSION_ID_RE.test(n.slice(0, -5)) || (keep && n === `${keep}.json`)) continue;
    const p = join(aliveDir(env), n);
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs > maxAgeMs) { unlinkSync(p); removed += 1; } else files.push({ p, at: st.mtimeMs });
    } catch { /* held open, gone already: the next prune retries */ }
  }
  // the newest first; `keep` is not in the list and does not count
  files.sort((a, b) => b.at - a.at);
  for (const f of files.slice(Math.max(0, maxFiles)).filter((x) => now - x.at > protectMs)) {
    try { unlinkSync(f.p); removed += 1; } catch { /* the next prune retries */ }
  }
  return removed;
}

// Why the mod may be off in a session, said by `arm` when it refuses.
export const MOD_OFF_CAUSES = [
  'Claude Code older than 2.1.287 (mods need 2.1.287 or later: `claude --version`)',
  'the plugin not loaded in this session (not installed or disabled: /plugin; for a checkout, --plugin-dir)',
  'mods switched off: --bare, --safe-mode, "disableAllHooks": true in the settings, or a managed policy',
  'a workspace not trusted yet (accept the trust dialog)',
  'the remote rollout switch saved off (`claude plugin test` says "rollout switch saved off": one `claude -p "ok"` with the network refreshes it)',
  'the Desktop app or the VS Code extension: the mod needs $.process.run, which only the CLI (`claude`, `claude -p`) has, so it leaves no sign of life there',
  'a session idle for over 30 days (its sign of life was pruned): any tool call of the session writes it again, or restart the session',
  'PERSEVERANZA_HOME set differently for Claude Code and for its Bash (in a shell profile only, say): the mod writes its sign of life under the environment Claude Code itself was started with',
];
