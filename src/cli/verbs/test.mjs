import { spawn } from 'node:child_process';
import { gate, requireState, saveState, argsAfterDoubleDash, VerbError } from '../shared.mjs';
import { appendJournal } from '../../shell/journal.mjs';
import { treeFingerprints } from '../../shell/git.mjs';
import { parseTimeoutMs } from '../../shell/util.mjs';

// Runs the suite ITSELF and records the real exit code: the proof is not self-declared.
// Also records a fingerprint of the work tree AFTER the run, so a claim-done after further
// edits is refused as stale.
//
//   test [--if-needed] -- <command>
//
// --if-needed: when a green run is already recorded for THIS work tree (same fingerprint,
// or the same code with only documentation changed since), the suite is not rerun: the
// recorded proof is refreshed to the current iteration and the reason is printed and
// journaled. A 27-minute suite run four times for the same diff was the single biggest
// cost of a real run; this is how a phase avoids paying it.
//
// The runner's output is echoed live and its tail is parsed for the names of failed tests
// (pytest, TAP, node:test/jest/vitest spec, go test, cargo). Two red runs on the same tree
// with different failures, or a green run right after a red one on the same tree, are
// journaled as a non-reproducible red: the loop cannot fix a flaky test, but it can say
// it was one instead of letting Claude chase it.

const OUTPUT_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_FAILED = 50;

const FAILED_PATTERNS = [
  /^(?:FAILED|ERROR) (\S+::\S+?)(?: - .*)?$/gm, // pytest short summary
  /^not ok \d+ - (.+?)(?: # .*)?$/gm, // TAP (node --test default on a pipe, others)
  /^\s*[✖×✕] (.+?)(?: \(\d+(?:\.\d+)?ms\))?$/gm, // node:test spec, jest, vitest
  /^--- FAIL: (\S+)/gm, // go test
  /^test (\S+) \.\.\. FAILED$/gm, // cargo test
];

export function parseFailedTests(output) {
  const found = [];
  const seen = new Set();
  for (const re of FAILED_PATTERNS) {
    re.lastIndex = 0;
    for (const m of String(output || '').matchAll(re)) {
      const name = m[1].trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      found.push(name);
      if (found.length >= MAX_FAILED) return found;
    }
  }
  return found;
}

// Same tree as the recorded green? -> { same: true, docsOnly } | { same: false }
export function greenStillValid(lastTest, fp) {
  if (!lastTest || Number(lastTest.exitCode) !== 0 || !fp || !fp.full) return { same: false };
  if (lastTest.fingerprint && lastTest.fingerprint === fp.full) return { same: true, docsOnly: false };
  if (lastTest.codeFingerprint && fp.code && lastTest.codeFingerprint === fp.code) return { same: true, docsOnly: true };
  return { same: false };
}

// Compare a run with the previous one on the SAME tree. -> note string or ''
export function flakinessNote(previous, current, sameTree) {
  if (!previous || !sameTree || Number(previous.exitCode) === 0) return '';
  const before = Array.isArray(previous.failed) ? previous.failed : [];
  if (current.exitCode === 0) {
    return `red not reproducible: the previous run on this same tree failed${before.length ? ` (${before.join(', ')})` : ''} and this one is green with no code change`;
  }
  const now = current.failed || [];
  if (!before.length || !now.length) return '';
  const disappeared = before.filter((n) => !now.includes(n));
  if (!disappeared.length) return '';
  return `red not reproducible: ${disappeared.join(', ')} failed in the previous run on this same tree and passed now; failing now: ${now.join(', ')}`;
}

function runSuite(cmd, { timeout, env }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, { shell: true, stdio: ['inherit', 'pipe', 'pipe'], timeout, env });
    } catch (e) {
      resolve({ status: 127, output: e.message });
      return;
    }
    let tail = '';
    const keep = (chunk, stream) => {
      stream.write(chunk);
      tail += chunk.toString('utf8');
      if (tail.length > OUTPUT_TAIL_BYTES) tail = tail.slice(-OUTPUT_TAIL_BYTES);
    };
    child.stdout.on('data', (c) => keep(c, process.stdout));
    child.stderr.on('data', (c) => keep(c, process.stderr));
    child.on('error', (e) => resolve({ status: 127, output: `${tail}\n${e.message}` }));
    // null status = killed (timeout or signal): 124, the conventional "timed out" code
    child.on('close', (status) => resolve({ status: status === null ? 124 : status, output: tail }));
  });
}

export async function run({ argv, rawArgv, cwd, env }) {
  const paths = gate(cwd);
  const s = requireState(paths);
  const ifNeeded = argv.includes('--if-needed');
  const cmd = argsAfterDoubleDash(rawArgv) || s.options.testCmd || '';
  if (!cmd) throw new VerbError('Usage: test [--if-needed] -- <command> (or configure --test at arm)');
  const it = s.counters.iterations;

  if (ifNeeded) {
    const fp = treeFingerprints(cwd);
    const v = greenStillValid(s.lastTest, fp);
    if (v.same) {
      const prev = s.lastTest;
      s.lastTest = { ...prev, iteration: it, at: new Date().toISOString(), fingerprint: fp.full, codeFingerprint: fp.code };
      saveState(paths, s);
      appendJournal(paths.gateDir, { type: 'test', cmd: prev.cmd, exitCode: 0, iteration: it, fingerprint: fp.full, reused: true, docsOnly: v.docsOnly, from: prev.at });
      console.log(v.docsOnly
        ? `TEST GREEN already recorded for this code (${prev.at}, iteration ${prev.iteration}); only documentation changed since: suite NOT rerun, proof refreshed.`
        : `TEST GREEN already recorded for this exact tree (${prev.at}, iteration ${prev.iteration}): suite NOT rerun, proof refreshed.`);
      return 0;
    }
    console.log(fp.full ? 'No green run recorded for this tree: running the suite.' : 'Cannot fingerprint the tree (not a git repo?): running the suite.');
  }

  console.log(`Running: ${cmd}`);
  const timeout = parseTimeoutMs(env.OMC_TEST_TIMEOUT_MS, 1800000); // heavy suites: 30 min default
  const r = await runSuite(cmd, { timeout, env });
  const exitCode = r.status;
  const fp = treeFingerprints(cwd);
  const failed = exitCode === 0 ? [] : parseFailedTests(r.output);
  const prev = s.lastTest;
  const sameTree = !!(prev && prev.fingerprint && fp.full && prev.fingerprint === fp.full);
  const flaky = flakinessNote(prev, { exitCode, failed }, sameTree);
  s.lastTest = { cmd, exitCode, iteration: it, at: new Date().toISOString(), fingerprint: fp.full, codeFingerprint: fp.code, failed };
  if (!s.options.testCmd) s.options.testCmd = cmd;
  saveState(paths, s);
  appendJournal(paths.gateDir, { type: 'test', cmd, exitCode, iteration: it, fingerprint: fp.full, failed, ...(flaky ? { flaky } : {}) });
  console.log(exitCode === 0 ? 'TEST GREEN (exit 0): recorded.' : `TEST RED (exit ${exitCode}${exitCode === 124 ? ', timeout' : ''}): recorded.${failed.length ? ` Failed: ${failed.join(', ')}` : ''}`);
  if (flaky) console.log(`NOTE (journaled): ${flaky}.`);
  return exitCode === 0 ? 0 : 1;
}
