// Git closure and work-tree facts. Every call is bounded by a deadline the hook owns.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { GATE_DIRNAME } from './paths.mjs';

export const PUSH_CAP_MS = 45000;
const MIN_CALL_MS = 2000;

function makeGit(cwd, deadline, spawn = spawnSync) {
  return (args, cap = 30000) => {
    const left = deadline ? deadline - Date.now() : cap;
    if (deadline && left < MIN_CALL_MS) return { status: null, stdout: '', stderr: 'deadline exceeded', timedOut: true };
    const r = spawn('git', args, { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: Math.max(MIN_CALL_MS, Math.min(cap, left)), maxBuffer: 64 * 1024 * 1024 });
    if (r.error) return { status: null, stdout: '', stderr: r.error.message, timedOut: r.error.code === 'ETIMEDOUT' };
    return { ...r, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), timedOut: r.signal === 'SIGTERM' };
  };
}

// --- pure helpers on `git status --porcelain` output ---
export function underLoop(p) {
  const q = String(p).trim().replace(/^"|"$/g, '');
  return q === GATE_DIRNAME || q.startsWith(`${GATE_DIRNAME}/`);
}

export function dirtyBeyondLoop(porcelainStdout) {
  return String(porcelainStdout)
    .split('\n').filter((l) => l.trim())
    .some((l) => {
      const body = l.slice(3);
      const paths = body.includes(' -> ') ? body.split(' -> ') : [body];
      return paths.some((p) => !underLoop(p));
    });
}

export function porcelainPaths(porcelainStdout) {
  return String(porcelainStdout).split('\n').map((l) => l.slice(3).trim())
    .map((p) => (p.includes(' -> ') ? p.split(' -> ').pop().trim() : p))
    .map((p) => p.replace(/^"|"$/g, ''))
    .filter((p) => p && !underLoop(p));
}

// --- facts ---
export function isGitRepo(cwd) {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8', timeout: 10000 });
  return r.status === 0 && String(r.stdout).trim() === 'true';
}

// Paths already modified before the task (recorded at arm, reported at closure).
export function baselineDirty(cwd) {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0) return [];
  return porcelainPaths(r.stdout);
}

// Files whose content never reaches an interpreter, compiler or test runner: documentation,
// licences, changelogs. Not *.txt: requirements.txt and CMakeLists.txt are code. A change
// confined to these keeps the CODE fingerprint stable, so the loop can say "only
// documentation changed since the last green suite" instead of demanding another full run.
// Git pathspec globs: `*.md` matches at any depth.
export const DOC_PATHSPECS = ['*.md', '*.markdown', '*.rst', '*.adoc', 'docs/', 'doc/', 'LICENSE*', 'LICENCE*', 'CHANGELOG*', 'AUTHORS*', 'CONTRIBUTORS*', 'NOTICE*'];

// Hash the index, binary-safe working diff, and the contents of untracked files.
// The index covers clean commits and unborn branches; NUL-delimited paths preserve
// Unicode, whitespace and newlines. null means the snapshot could not be verified.
// `exclude`: extra pathspecs left out of the snapshot (see DOC_PATHSPECS).
export function workTreeFingerprint(cwd, { deadline = Date.now() + 60000, exclude = [] } = {}) {
  try {
    const git = makeGit(cwd, deadline);
    const paths = ['--', '.', `:(exclude)${GATE_DIRNAME}`, ...exclude.map((e) => `:(exclude)${e}`)];
    const index = git(['ls-files', '--stage', '-z', ...paths], 20000);
    if (index.status !== 0) return null;
    const diff = git(['diff', '--binary', '--no-ext-diff', '--no-textconv', ...paths], 20000);
    if (diff.status !== 0) return null;
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', ...paths], 20000);
    if (untracked.status !== 0) return null;
    const hash = createHash('sha256').update(index.stdout).update('\0').update(diff.stdout).update('\0');
    const buffer = Buffer.alloc(64 * 1024);
    for (const name of untracked.stdout.split('\0').filter(Boolean).sort()) {
      if (Date.now() >= deadline) return null;
      const path = join(cwd, name);
      const stat = lstatSync(path);
      const content = createHash('sha256');
      if (stat.isSymbolicLink()) content.update(readlinkSync(path));
      else {
        if (!stat.isFile()) return null;
        const fd = openSync(path, 'r');
        try {
          let size;
          while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            if (Date.now() >= deadline) return null;
            content.update(buffer.subarray(0, size));
          }
        } finally { closeSync(fd); }
      }
      hash.update(name).update('\0').update(stat.isSymbolicLink() ? 'link' : 'file').update('\0').update(content.digest());
    }
    return hash.digest('hex');
  } catch { return null; }
}

// Both snapshots at once: `full` is the whole tree, `code` leaves DOC_PATHSPECS out.
// -> { full, code } (each null when it could not be computed within the deadline)
export function treeFingerprints(cwd, { deadline = Date.now() + 60000 } = {}) {
  const full = workTreeFingerprint(cwd, { deadline });
  const code = full == null ? null : workTreeFingerprint(cwd, { deadline, exclude: DOC_PATHSPECS });
  return { full, code };
}

// Commit + push at the end of the project, verified on FACTS (clean tree, HEAD not ahead
// of upstream), never on exit codes. .omc-loop/ is never committed.
// -> { ran:false } | { ran:true, confirmed, committed, pushed, pushSkipped?, hasUpstream, ahead?, pushErr? }
export function gitFinish(cwd, { task = '', push = true, baselineDirty: base = [], externalNote = '', deadline = null, spawn = spawnSync } = {}) {
  const git = makeGit(cwd, deadline, spawn);
  const failed = (error) => ({ ran: true, confirmed: false, committed: false, pushed: false, error });
  const inside = git(['rev-parse', '--is-inside-work-tree'], 10000);
  if (inside.status !== 0) {
    if (inside.status !== null && /not a git repository/i.test(inside.stderr)) return { ran: false };
    return failed(`cannot verify git repository: ${inside.stderr.trim() || 'git failed'}`);
  }
  if (inside.stdout.trim() !== 'true') return { ran: false };
  const added = git(['add', '-A', '--', '.', `:(exclude)${GATE_DIRNAME}`]);
  if (added.status !== 0) return failed('git add failed; closure not verified');
  const reset = git(['reset', '-q', '--', GATE_DIRNAME]);
  if (reset.status !== 0) return failed('cannot exclude .omc-loop from the commit');
  const baseNote = (Array.isArray(base) && base.length)
    ? `\n\nperseveranza note: this commit may include ${base.length} file(s) already modified before the task (git add -A): `
      + `${base.slice(0, 10).join(', ')}${base.length > 10 ? ` (+${base.length - 10} more)` : ''}.`
    : '';
  const extNote = externalNote ? `\n\nperseveranza note: ${externalNote}.` : '';
  const commit = git(['commit', '-m', `perseveranza: ${task || 'project completed'}${baseNote}${extNote}`]);
  const status = git(['status', '--porcelain'], 15000);
  if (status.status !== 0) return failed('cannot read git status; closure not verified');
  const head = git(['rev-parse', '--verify', 'HEAD'], 10000);
  const committed = head.status === 0 && !dirtyBeyondLoop(status.stdout);
  // The facts decide, but when they say "not committed" the human needs git's own reason
  // (identity unknown, hooks, locked index...): keep its last line.
  const commitWhy = () => {
    if (commit.status === 0) return 'commit did not happen (uncommitted changes remain)';
    const last = `${commit.stderr}\n${commit.stdout}`.trim().split('\n').filter((l) => l.trim()).pop() || 'git commit failed';
    return `commit failed: ${last.trim().slice(0, 160)}`;
  };
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], 10000);
  const hasUpstream = upstream.status === 0;
  const aheadCount = () => {
    if (!hasUpstream) return null;
    const result = git(['rev-list', '--count', '@{u}..HEAD'], 10000);
    const value = result.stdout.trim();
    return result.status === 0 && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  };
  if (!push) return { ran: true, confirmed: committed, committed, pushed: false, pushSkipped: true, hasUpstream, ahead: aheadCount(), ...(committed ? {} : { error: commitWhy() }) };
  if (!committed) return failed(`${commitWhy()}; push skipped`);
  const pushRes = git(['push'], PUSH_CAP_MS);
  const pushErr = pushRes.status === 0 ? '' : (pushRes.timedOut ? `push timed out (${Math.round(PUSH_CAP_MS / 1000)}s cap)` : (pushRes.stderr.trim().split('\n').pop() || 'push failed').slice(0, 100));
  const pushed = pushRes.status === 0 && hasUpstream && aheadCount() === 0;
  return { ran: true, confirmed: committed && pushed, committed, pushed, hasUpstream, pushErr };
}
