// Where things live. The only module that knows about the user profile layout.
//   PERSEVERANZA_HOME  overrides ~/.perseveranza (config, runs archive, update cache) — used by tests.
//   CLAUDE_CONFIG_DIR  overrides ~/.claude (Claude Code's own convention).
import { homedir } from 'node:os';
import { realpathSync, statSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The loop's folder in a project (state, plan, notes, journal, verdicts). Not to be confused
// with home(): ~/.perseveranza is the user's (config, runs archive), and `arm` refuses a
// project whose loop folder would be that one (a project rooted in the home directory).
export const GATE_DIRNAME = '.perseveranza';
// The loop folder's name inside an archived run: <runs>/<project>/<stamp>/loop/.
export const ARCHIVE_GATE_DIRNAME = 'loop';

export function home(env = process.env) {
  return env.PERSEVERANZA_HOME || join(homedir(), '.perseveranza');
}
export function configPath(env = process.env) { return join(home(env), 'config.json'); }
export function runsDir(env = process.env) { return join(home(env), 'runs'); }
export function claudeDir(env = process.env) { return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'); }

// The real path of p, its symlinks resolved (macOS: tmpdir() is under /var, a link to
// /private/var; a home or a checkout reached through a link). A path that does not exist yet
// keeps its missing tail as written under the real path of its deepest existing ancestor, so
// it still compares with the real path of one that exists.
export function realPathOr(p) {
  let head = resolve(p);
  const tail = [];
  for (;;) {
    try { return join(realpathSync(head), ...tail); } catch { /* not there (yet): one level up */ }
    const up = dirname(head);
    if (up === head) return resolve(p);
    tail.unshift(basename(head));
    head = up;
  }
}

// One directory under two names? As written first (resolve() normalises separators and drops a
// trailing one; Windows ignores case), then as the file system sees them: two that exist are
// the same when device and inode agree (a symlink in either path, a case-insensitive volume,
// the default on macOS); otherwise (one missing, a file system with no inode numbers) their
// real paths are compared.
export function samePath(a, b, platform = process.platform) {
  const fold = (s) => (platform === 'win32' ? s.toLowerCase() : s);
  const [x, y] = [resolve(a), resolve(b)];
  if (fold(x) === fold(y)) return true;
  try {
    const [s, t] = [statSync(x, { bigint: true }), statSync(y, { bigint: true })];
    if (s.ino !== 0n && t.ino !== 0n) return s.dev === t.dev && s.ino === t.ino;
  } catch { /* one of them is not there */ }
  return fold(realPathOr(x)) === fold(realPathOr(y));
}

export function gatePaths(cwd) {
  const gateDir = join(cwd, GATE_DIRNAME);
  return {
    cwd,
    gateDir,
    statePath: join(gateDir, 'state.json'),
    planPath: join(gateDir, 'plan.md'),
    notesPath: join(gateDir, 'notes.md'),
    journalPath: join(gateDir, 'journal.jsonl'),
    escalationPath: join(gateDir, 'ESCALATION.md'),
    stopFile: join(gateDir, 'STOP'),
    promptsPath: join(gateDir, 'prompts.json'),
    projectName: basename(cwd),
  };
}

// The command Claude runs for the verbs (used inside injected instructions).
export function loopCommand(root = ROOT) {
  return `node "${join(root, 'src', 'cli', 'perseveranza.mjs')}"`;
}
