// Git closure and work-tree facts. Every call is bounded by a deadline the hook owns.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { GATE_DIRNAME } from './paths.mjs';

export const PUSH_CAP_MS = 45000;
const MIN_CALL_MS = 2000;

function makeGit(cwd, deadline) {
  return (args, cap = 30000) => {
    const left = deadline ? deadline - Date.now() : cap;
    if (deadline && left < MIN_CALL_MS) return { status: null, stdout: '', stderr: 'deadline exceeded', timedOut: true };
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: Math.max(MIN_CALL_MS, Math.min(cap, left)) });
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

// A fingerprint of the work tree (tracked diff + untracked file list), used to detect
// code changes between a green test run and the claim-done. null outside a git repo.
export function workTreeFingerprint(cwd) {
  try {
    if (!isGitRepo(cwd)) return null;
    const diff = spawnSync('git', ['diff', 'HEAD', '--', '.', `:(exclude)${GATE_DIRNAME}`], { cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
    if (diff.status !== 0 && status.status !== 0) return null;
    const untracked = porcelainPaths(status.stdout).sort().join('\n');
    return createHash('sha1').update(String(diff.stdout || '')).update('\n--\n').update(untracked).digest('hex');
  } catch { return null; }
}

// Commit + push at the end of the project, verified on FACTS (clean tree, HEAD not ahead
// of upstream), never on exit codes. .omc-loop/ is never committed.
// -> { ran:false } | { ran:true, confirmed, committed, pushed, pushSkipped?, hasUpstream, ahead?, pushErr? }
export function gitFinish(cwd, { task = '', push = true, baselineDirty: base = [], externalNote = '', deadline = null } = {}) {
  const git = makeGit(cwd, deadline);
  const inside = git(['rev-parse', '--is-inside-work-tree'], 10000);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return { ran: false };
  git(['add', '-A']);
  git(['reset', '-q', '--', GATE_DIRNAME]);
  const baseNote = (Array.isArray(base) && base.length)
    ? `\n\nperseveranza note: this commit may include ${base.length} file(s) already modified before the task (git add -A): `
      + `${base.slice(0, 10).join(', ')}${base.length > 10 ? ` (+${base.length - 10} more)` : ''}.`
    : '';
  const extNote = externalNote ? `\n\nperseveranza note: ${externalNote}.` : '';
  git(['commit', '-m', `perseveranza: ${task || 'project completed'}${baseNote}${extNote}`]);
  const committed = !dirtyBeyondLoop(git(['status', '--porcelain'], 15000).stdout);
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], 10000);
  const hasUpstream = upstream.status === 0;
  const aheadCount = () => (hasUpstream ? Number(git(['rev-list', '--count', '@{u}..HEAD'], 10000).stdout.trim()) || 0 : null);
  if (!push) return { ran: true, confirmed: committed, committed, pushed: false, pushSkipped: true, hasUpstream, ahead: aheadCount() || 0 };
  const pushRes = git(['push'], PUSH_CAP_MS);
  const pushErr = pushRes.status === 0 ? '' : (pushRes.timedOut ? `push timed out (${Math.round(PUSH_CAP_MS / 1000)}s cap)` : (pushRes.stderr.trim().split('\n').pop() || 'push failed').slice(0, 100));
  const pushed = hasUpstream && aheadCount() === 0;
  return { ran: true, confirmed: committed && pushed, committed, pushed, hasUpstream, pushErr };
}
