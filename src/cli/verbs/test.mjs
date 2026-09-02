import { spawnSync } from 'node:child_process';
import { gate, requireState, saveState, argsAfterDoubleDash, VerbError } from '../shared.mjs';
import { appendJournal } from '../../shell/journal.mjs';
import { workTreeFingerprint } from '../../shell/git.mjs';
import { parseTimeoutMs } from '../../shell/util.mjs';

// Runs the suite ITSELF and records the real exit code: the proof is not self-declared.
// Also records a fingerprint of the work tree AFTER the run, so a claim-done after further
// edits is refused as stale.
export function run({ rawArgv, cwd, env }) {
  const paths = gate(cwd);
  const s = requireState(paths);
  const cmd = argsAfterDoubleDash(rawArgv) || s.options.testCmd || '';
  if (!cmd) throw new VerbError('Usage: test -- <command> (or configure --test at arm)');
  console.log(`Running: ${cmd}`);
  const timeout = parseTimeoutMs(env.OMC_TEST_TIMEOUT_MS, 1800000); // heavy suites: 30 min default
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit', timeout, env });
  const exitCode = r.status === null ? 124 : r.status; // null = timeout or signal
  const fingerprint = workTreeFingerprint(cwd);
  s.lastTest = { cmd, exitCode, iteration: s.counters.iterations, at: new Date().toISOString(), fingerprint };
  if (!s.options.testCmd) s.options.testCmd = cmd;
  saveState(paths, s);
  appendJournal(paths.gateDir, { type: 'test', cmd, exitCode, iteration: s.counters.iterations, fingerprint });
  console.log(exitCode === 0 ? 'TEST GREEN (exit 0): recorded.' : `TEST RED (exit ${exitCode}${exitCode === 124 ? ', timeout' : ''}): recorded.`);
  return exitCode === 0 ? 0 : 1;
}
