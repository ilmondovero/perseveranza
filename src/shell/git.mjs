// Git closure and work-tree facts. Every call is bounded by a deadline the hook owns.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { GATE_DIRNAME } from './paths.mjs';
import { LEGACY_GATE_DIRNAME } from './legacy.mjs';
import { VOLATILE_PATHS } from './tool-state.mjs';

// The loop folder, and the one a 2.x run may have left in the project: never committed, and
// never part of the work tree's fingerprint (a 2.x leftover still written, by a 2.x watchdog
// say, would otherwise read as a code change and void the green test on record). One list for
// every place that leaves the loop out: underLoop, the fingerprint, the git finish.
export const LOOP_DIRS = [GATE_DIRNAME, LEGACY_GATE_DIRNAME];

// Other tools' local state (tool-state.mjs VOLATILE_PATHS), rewritten by THEIR hooks at every
// tool call of a session: an untracked file there is never the task's work, and counting it
// voided the green test of a real run (oh-my-claudecode's state changed between the green suite
// and the verifier's pass: pass-stale, until the iteration budget ran out). The rule: UNTRACKED
// and under one of these paths does not count; a TRACKED file there still does (a project that
// commits that state made it part of the work), and the git finish commits its changes.
// Extended by PERSEVERANZA_FINGERPRINT_IGNORE (comma-separated) and by `arm --ignore` (saved in
// the state): relative paths or folder prefixes inside the repository, validated (ignorePath).
export { VOLATILE_PATHS };
export const FINGERPRINT_IGNORE_ENV = 'PERSEVERANZA_FINGERPRINT_IGNORE';
export const MAX_IGNORE = 50;

// One path to leave out, normalized ('a/b': no leading './', no trailing '/'), or null when it
// is not acceptable: empty, absolute, a drive, a '..' or '.' segment (outside the repository,
// or the whole of it), a glob or a pathspec magic (could match everything), a control character.
export function ignorePath(raw) {
  if (typeof raw !== 'string') return null;
  let p = raw.trim().replace(/\\/g, '/');
  if (!p || p.length > 200 || /[\u0000-\u001f*?[\]:!]/.test(p)) return null;
  if (p.startsWith('/')) return null;
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/+/g, '/').replace(/\/$/, '');
  if (!p || p.split('/').some((x) => x === '' || x === '.' || x === '..')) return null;
  return p;
}

// The paths whose untracked files do not count: the known ones, the environment's, the run's
// (state.options.fingerprintIgnore). -> { paths, rejected: the environment's entries refused }
export function volatilePaths({ env = process.env, extra = [] } = {}) {
  const fromEnv = String((env && env[FINGERPRINT_IGNORE_ENV]) || '').split(',').map((x) => x.trim()).filter(Boolean);
  const rejected = fromEnv.filter((x) => !ignorePath(x));
  const more = [...fromEnv, ...(Array.isArray(extra) ? extra : [])].map(ignorePath).filter(Boolean).slice(0, MAX_IGNORE);
  return { paths: [...new Set([...VOLATILE_PATHS, ...more])], rejected };
}

const literal = (p) => `:(exclude,literal)${p}`;
const unquote = (p) => String(p).trim().replace(/^"|"$/g, '');
const under = (p, list) => list.some((d) => p === d || p.startsWith(`${d}/`));
// an untracked entry of `git status --porcelain` under a volatile path (a folder ends with '/')
const untrackedVolatile = (line, list) => line.startsWith('?? ') && under(unquote(line.slice(3)).replace(/\/$/, ''), list);

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
  return LOOP_DIRS.some((d) => q === d || q.startsWith(`${d}/`));
}

// volatile: VOLATILE_PATHS and the like (an untracked file there is not dirt; a tracked one is)
export function dirtyBeyondLoop(porcelainStdout, volatile = []) {
  return String(porcelainStdout)
    .split('\n').filter((l) => l.trim())
    .some((l) => {
      if (untrackedVolatile(l, volatile)) return false;
      const body = l.slice(3);
      const paths = body.includes(' -> ') ? body.split(' -> ') : [body];
      return paths.some((p) => !underLoop(p));
    });
}

export function porcelainPaths(porcelainStdout, volatile = []) {
  return String(porcelainStdout).split('\n').filter((l) => !untrackedVolatile(l, volatile)).map((l) => l.slice(3).trim())
    .map((p) => (p.includes(' -> ') ? p.split(' -> ').pop().trim() : p))
    .map((p) => p.replace(/^"|"$/g, ''))
    .filter((p) => p && !underLoop(p));
}

// --- facts ---
// Paths already modified before the task (recorded at arm, reported at closure).
export function baselineDirty(cwd, { volatile = VOLATILE_PATHS } = {}) {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0) return [];
  return porcelainPaths(r.stdout, volatile);
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
// `volatile`: paths whose UNTRACKED files are left out (VOLATILE_PATHS, volatilePaths()); the
// tracked files there stay in the index and in the diff.
export function workTreeFingerprint(cwd, { deadline = Date.now() + 60000, exclude = [], volatile = VOLATILE_PATHS } = {}) {
  try {
    const git = makeGit(cwd, deadline);
    const paths = ['--', '.', ...LOOP_DIRS.map((d) => `:(exclude)${d}`), ...exclude.map((e) => `:(exclude)${e}`)];
    const index = git(['ls-files', '--stage', '-z', ...paths], 20000);
    if (index.status !== 0) return null;
    const diff = git(['diff', '--binary', '--no-ext-diff', '--no-textconv', ...paths], 20000);
    if (diff.status !== 0) return null;
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', ...paths, ...volatile.map(literal)], 20000);
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
export function treeFingerprints(cwd, { deadline = Date.now() + 60000, volatile = VOLATILE_PATHS } = {}) {
  const full = workTreeFingerprint(cwd, { deadline, volatile });
  const code = full == null ? null : workTreeFingerprint(cwd, { deadline, exclude: DOC_PATHSPECS, volatile });
  return { full, code };
}

// Commit + push at the end of the project, verified on FACTS (clean tree, HEAD not ahead
// of upstream), never on exit codes. The loop folder (LOOP_DIRS) is never committed; the
// untracked files under `volatile` (other tools' state) are neither committed nor dirt, while
// the changes of TRACKED files there are committed (the fingerprint counts them too).
// -> { ran:false } | { ran:true, confirmed, committed, pushed, pushSkipped?, hasUpstream, ahead?, pushErr? }
export function gitFinish(cwd, { task = '', push = true, baselineDirty: base = [], externalNote = '', deadline = null, spawn = spawnSync, volatile = VOLATILE_PATHS } = {}) {
  const git = makeGit(cwd, deadline, spawn);
  const failed = (error) => ({ ran: true, confirmed: false, committed: false, pushed: false, error });
  const inside = git(['rev-parse', '--is-inside-work-tree'], 10000);
  if (inside.status !== 0) {
    if (inside.status !== null && /not a git repository/i.test(inside.stderr)) return { ran: false };
    return failed(`cannot verify git repository: ${inside.stderr.trim() || 'git failed'}`);
  }
  if (inside.stdout.trim() !== 'true') return { ran: false };
  // What to keep out of `git add -A`, by what is there: git refuses (exit 1, "The following
  // paths are ignored") an exclude pathspec that names a path the project's or the user's
  // global gitignore already ignores, as the README advises for .perseveranza/ (3.0.1 failed
  // its own closure there), and `git add -u` fails on a pathspec that matches no tracked file.
  // So a loop folder or a volatile path is excluded only where an untracked, not ignored file
  // is (an ignored one is never added anyway), and a volatile path is updated only where a
  // tracked file is. (A volatile path whose first untracked file appears in the instant
  // between this listing and the add would be committed.)
  const outside = [...LOOP_DIRS, ...volatile];
  const spec = outside.map((p) => `:(literal)${p}`);
  const loose = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...spec], 15000);
  const tracked = volatile.length ? git(['ls-files', '-z', '--', ...volatile.map((p) => `:(literal)${p}`)], 15000) : { status: 0, stdout: '' };
  if (loose.status !== 0 || tracked.status !== 0) return failed('cannot list the files of the loop and tool-state folders; closure not verified');
  const names = (r) => r.stdout.split('\0').filter(Boolean);
  const excluded = outside.filter((p) => names(loose).some((n) => under(n, [p])));
  const withTracked = volatile.filter((p) => names(tracked).some((n) => under(n, [p])));
  const added = git(['add', '-A', '--', '.', ...excluded.map(literal)]);
  if (added.status !== 0) return failed('git add failed; closure not verified');
  // the tracked files under the volatile paths: their changes (and deletions) are staged too
  if (withTracked.length) {
    const updated = git(['add', '-u', '--', ...withTracked.map((p) => `:(literal)${p}`)]);
    if (updated.status !== 0) return failed('git add failed; closure not verified');
  }
  const reset = git(['reset', '-q', '--', ...LOOP_DIRS]);
  if (reset.status !== 0) return failed(`cannot exclude ${GATE_DIRNAME} from the commit`);
  const baseNote = (Array.isArray(base) && base.length)
    ? `\n\nperseveranza note: this commit may include ${base.length} file(s) already modified before the task (git add -A): `
      + `${base.slice(0, 10).join(', ')}${base.length > 10 ? ` (+${base.length - 10} more)` : ''}.`
    : '';
  const extNote = externalNote ? `\n\nperseveranza note: ${externalNote}.` : '';
  const commit = git(['commit', '-m', `perseveranza: ${task || 'project completed'}${baseNote}${extNote}`]);
  // every untracked file by name: an untracked folder is not reported whole (`.claude/` may hold
  // a volatile file beside the project's own commands)
  const status = git(['status', '--porcelain', '--untracked-files=all'], 15000);
  if (status.status !== 0) return failed('cannot read git status; closure not verified');
  const head = git(['rev-parse', '--verify', 'HEAD'], 10000);
  const committed = head.status === 0 && !dirtyBeyondLoop(status.stdout, volatile);
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
