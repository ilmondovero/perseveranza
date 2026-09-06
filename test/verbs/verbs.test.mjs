import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { project, cli, arm, readState, writePlan, gate, journal, patchState } from '../helpers/cli.mjs';

test('arm creates a v2 state in phase plan and journals it', () => {
  const p = project();
  const r = arm(p, 'build the thing', ['--max', '9', '--commit', '--approve-plan', '--budget-tokens', '5000', '--test', 'npm test']);
  assert.ok(r.out.includes('ARMED'));
  const s = readState(p);
  assert.equal(s.schemaVersion, 2);
  assert.equal(s.phase, 'plan');
  assert.equal(s.task, 'build the thing');
  assert.equal(s.limits.maxIterations, 9);
  assert.equal(s.limits.maxIterationsExplicit, true);
  assert.equal(s.limits.maxTokens, 5000);
  assert.equal(s.options.commitSteps, true);
  assert.equal(s.options.approvePlan, true);
  assert.equal(s.options.testCmd, 'npm test');
  assert.equal(s.options.gitFinish, false);
  assert.deepEqual(s.options.externals, []);
  assert.equal(s.options.lang, 'en'); // helper env sets PERSEVERANZA_LANG=en
  assert.ok(s.armedAt);
  assert.ok(journal(p).some((j) => j.type === 'note' && /armed/.test(j.text)));
});

test('arm refuses to overwrite an armed loop unless --force', () => {
  const p = project();
  arm(p);
  patchState(p, (s) => { s.phase = 'review'; s.counters.iterations = 7; });
  const r = cli(p, 'arm', 'another', '--external', 'off');
  assert.equal(r.code, 1);
  assert.ok(r.out.includes('ALREADY armed'));
  assert.equal(readState(p).phase, 'review');
  const f = cli(p, 'arm', 'another', '--external', 'off', '--force');
  assert.equal(f.code, 0);
  assert.equal(readState(p).task, 'another');
  assert.equal(readState(p).counters.iterations, 0);
});

test('arm validates its flags', () => {
  const p = project();
  assert.equal(cli(p, 'arm').code, 1);
  assert.ok(cli(p, 'arm', 'x', '--complexity', 'huge').out.includes('Invalid --complexity'));
  assert.ok(cli(p, 'arm', 'x', '--bogus').out.includes('arm:'));
  assert.equal(readState(p), null);
});

test('arm language: Italian by default, then config, then PERSEVERANZA_LANG, then --lang', () => {
  const p = project();
  delete p.env.PERSEVERANZA_LANG;
  const out0 = arm(p).out;
  assert.equal(readState(p).options.lang, 'it');
  assert.ok(out0.includes('Instruction language: it (packs/it.json)'));
  const c = project();
  delete c.env.PERSEVERANZA_LANG;
  writeFileSync(join(c.home, 'config.json'), JSON.stringify({ lang: 'en' }));
  arm(c);
  assert.equal(readState(c).options.lang, 'en');
  const q = project();
  q.env.LC_ALL = 'de_DE.UTF-8'; // the shell locale never decides
  delete q.env.PERSEVERANZA_LANG;
  arm(q);
  assert.equal(readState(q).options.lang, 'it');
  const e = project();
  arm(e); // helper env: PERSEVERANZA_LANG=en
  assert.equal(readState(e).options.lang, 'en');
  const r = project();
  const out = arm(r, 't', ['--lang', 'fr']).out;
  assert.equal(readState(r).options.lang, 'fr');
  assert.ok(out.includes('no prompt pack for language "fr"'));
});

test('report, complexity, claim-done, pause, resume write only their signals', () => {
  const p = project();
  arm(p);
  assert.equal(cli(p, 'report', 'maybe').code, 1);
  assert.equal(cli(p, 'report', 'fail').code, 0);
  assert.equal(readState(p).signals.lastReport, 'fail');
  assert.equal(cli(p, 'complexity', 'high').code, 0);
  assert.equal(readState(p).complexity, 'high');
  assert.equal(cli(p, 'complexity', 'nope').code, 1);
  assert.equal(cli(p, 'claim-done').code, 0);
  assert.equal(readState(p).signals.claimedDone, true);
  assert.equal(cli(p, 'pause').code, 0);
  assert.equal(readState(p).signals.paused, true);
  patchState(p, (s) => { s.counters.retries = 2; s.counters.finalFails = 1; });
  writeFileSync(gate(p, 'ESCALATION.md'), 'x');
  assert.equal(cli(p, 'resume').code, 0);
  const s = readState(p);
  assert.equal(s.signals.paused, false);
  assert.equal(s.counters.retries, 0);
  assert.equal(s.counters.finalFails, 0);
  assert.ok(!existsSync(gate(p, 'ESCALATION.md')));
  assert.equal(s.phase, 'plan');
  const kinds = journal(p).filter((j) => j.type === 'signal').map((j) => j.verb);
  assert.deepEqual(kinds, ['report', 'complexity', 'claim-done', 'pause', 'resume']);
});

test('verbs refuse to run when not armed', () => {
  const p = project();
  for (const v of ['report pass', 'complexity low', 'claim-done', 'pause', 'resume', 'test -- true', 'ask codex x -- hi']) {
    const r = cli(p, ...v.split(' '));
    assert.equal(r.code, 1, v);
    assert.ok(r.out.includes('NOT armed'), v);
  }
  assert.equal(cli(p, 'status').code, 1);
  assert.equal(cli(p, 'disarm').code, 0);
});

test('test verb records the real exit code, iteration and a fingerprint outside git', () => {
  const p = project();
  arm(p);
  patchState(p, (s) => { s.counters.iterations = 4; });
  const ok = cli(p, 'test', '--', 'node', '-e', '"process.exit(0)"');
  assert.equal(ok.code, 0);
  let s = readState(p);
  assert.equal(s.lastTest.exitCode, 0);
  assert.equal(s.lastTest.iteration, 4);
  assert.equal(s.lastTest.fingerprint, null);
  assert.equal(s.options.testCmd, 'node -e "process.exit(0)"');
  const ko = cli(p, 'test', '--', 'node', '-e', '"process.exit(3)"');
  assert.equal(ko.code, 1);
  s = readState(p);
  assert.equal(s.lastTest.exitCode, 3);
  assert.ok(journal(p).filter((j) => j.type === 'test').length === 2);
  assert.ok(cli(p, 'test').out.includes('Running: node -e "process.exit(0)"')); // falls back to the recorded command
});

test('test verb: fingerprint inside a git repo changes when the tree changes', () => {
  const p = project({ git: true });
  arm(p);
  cli(p, 'test', '--', 'node', '-e', '0');
  const a = readState(p).lastTest.fingerprint;
  assert.match(a, /^[0-9a-f]{64}$/);
  writeFileSync(join(p.dir, 'new.txt'), 'x');
  cli(p, 'test', '--', 'node', '-e', '0');
  const b = readState(p).lastTest.fingerprint;
  assert.notEqual(a, b);
});

test('status, history, explain, prompts, config, providers produce output', () => {
  const p = project();
  arm(p, 'the task');
  writePlan(p, '- [x] a\n- [ ] b\n');
  const st = cli(p, 'status');
  assert.equal(st.code, 0);
  assert.ok(st.out.includes('ARMED — the task'));
  assert.ok(st.out.includes('steps:       1/2 done'));
  assert.ok(st.out.includes('next outcomes'));
  assert.ok(JSON.parse(cli(p, 'status', '--json').out).schemaVersion === 2);
  const h = cli(p, 'history');
  assert.ok(h.out.includes('armed: the task'));
  assert.ok(Array.isArray(JSON.parse(cli(p, 'history', '--json', '--tail', '1').out)));
  const ex = cli(p, 'explain');
  assert.ok(ex.out.includes('Current phase: plan'));
  assert.ok(ex.out.includes('Full transition table'));
  assert.ok(cli(p, 'explain', '--markdown').out.startsWith('| phase | outcome |'));
  assert.ok(cli(p, 'prompts', 'keys').out.includes('review-advance'));
  assert.ok(cli(p, 'prompts', 'show', 'cleanup').out.includes('PHASE: pre-verification cleanup'));
  assert.equal(cli(p, 'prompts', 'show', 'nope').code, 1);
  const cfg = cli(p, 'config');
  assert.ok(cfg.out.includes('OLLAMA_API_KEY:       NOT set'));
  assert.ok(cfg.out.includes(p.home));
  const pr = cli(p, 'providers', 'list');
  assert.equal(pr.code, 0);
  assert.ok(pr.out.includes('ollama-cloud'));
  assert.ok(cli(p, 'bogus').out.includes('Unknown verb'));
});

test('prompts validate: good pack, bad placeholder, unknown key, --complete', () => {
  const p = project();
  const good = join(p.dir, 'good.json');
  writeFileSync(good, JSON.stringify({ prompts: { cleanup: 'Clean then {{testRun}}' } }));
  const g = cli(p, 'prompts', 'validate', good);
  assert.equal(g.code, 0);
  assert.ok(g.out.includes('OK'));
  const bad = join(p.dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ prompts: { cleanup: '{{nope}}', zzz: 'x' } }));
  const b = cli(p, 'prompts', 'validate', bad);
  assert.equal(b.code, 1);
  assert.ok(b.out.includes('BAD placeholder'));
  assert.ok(b.out.includes('unknown keys (ignored): zzz'));
  const c = cli(p, 'prompts', 'validate', good, '--complete');
  assert.equal(c.code, 1);
  assert.ok(c.out.includes('missing keys'));
  assert.equal(cli(p, 'prompts', 'validate', join(p.dir, 'missing.json')).code, 1);
});

test('prompts layers shows the active override sources', () => {
  const p = project();
  arm(p);
  writeFileSync(gate(p, 'prompts.json'), JSON.stringify({ prompts: { cleanup: 'x' } }));
  const r = cli(p, 'prompts', 'layers', 'it');
  assert.ok(r.out.includes('.omc-loop/prompts.json'));
  assert.ok(r.out.includes('packs/it.json'));
  writeFileSync(gate(p, 'prompts.json'), '{broken');
  assert.equal(cli(p, 'prompts', 'layers').code, 1);
});

test('disarm archives the run by default, --no-archive just removes it', () => {
  const p = project();
  arm(p, 'archived task');
  const r = cli(p, 'disarm');
  assert.equal(r.code, 0);
  assert.ok(!existsSync(gate(p, 'state.json')));
  const runs = cli(p, 'runs');
  assert.ok(runs.out.includes('disarmed'));
  assert.ok(runs.out.includes('archived task'));
  const id = runs.out.trim().split('\n')[0].trim().split(/\s+/)[0];
  const show = cli(p, 'runs', 'show', id);
  assert.equal(show.code, 0);
  assert.ok(show.out.includes('"outcome": "disarmed"'));
  assert.ok(show.out.includes('armed: archived task'));
  const q = project();
  arm(q);
  cli(q, 'disarm', '--no-archive');
  assert.ok(cli(q, 'runs').out.includes('No archived runs'));
  assert.ok(cli(q, 'disarm').out.includes('was not armed'));
});

test('hud on/off compose with the existing statusline and restore it', async () => {
  const p = project();
  const cdir = join(p.home, 'claude');
  p.env.CLAUDE_CONFIG_DIR = cdir;
  const settings = join(cdir, 'settings.json');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(cdir, { recursive: true });
  writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'echo base' }, other: 1 }));
  assert.equal(cli(p, 'hud', 'on').code, 0);
  const on = JSON.parse(readFileSync(settings, 'utf8'));
  assert.ok(on.statusLine.command.includes('statusline-hud.mjs'));
  assert.equal(on.other, 1);
  assert.ok(existsSync(join(p.home, 'statusline-hud.mjs')));
  assert.ok(cli(p, 'hud', 'status').out.includes('HUD:   ON'));
  assert.equal(cli(p, 'hud', 'off').code, 0);
  assert.equal(JSON.parse(readFileSync(settings, 'utf8')).statusLine.command, 'echo base');
  assert.ok(!existsSync(join(p.home, 'statusline-hud.mjs')));
});

// ---------------------------------------------------------------- 2.1: test --if-needed, failures, flakiness
test('test --if-needed reuses a green recorded for the same tree and refreshes its iteration', () => {
  const p = project({ git: true });
  arm(p);
  patchState(p, (s) => { s.counters.iterations = 2; });
  const first = cli(p, 'test', '--if-needed', '--', 'node', '-e', '0');
  assert.equal(first.code, 0);
  assert.ok(first.out.includes('No green run recorded for this tree: running the suite.'));
  assert.ok(first.out.includes('TEST GREEN (exit 0)'));
  patchState(p, (s) => { s.counters.iterations = 5; });
  const again = cli(p, 'test', '--if-needed');
  assert.equal(again.code, 0);
  assert.ok(again.out.includes('already recorded for this exact tree'), again.out);
  assert.ok(!again.out.includes('Running:'));
  const s = readState(p);
  assert.equal(s.lastTest.iteration, 5);
  assert.equal(s.lastTest.exitCode, 0);
  const j = journal(p).filter((e) => e.type === 'test');
  assert.equal(j.length, 2);
  assert.equal(j[1].reused, true);
  assert.equal(j[1].docsOnly, false);
  // a code change invalidates the reuse
  writeFileSync(join(p.dir, 'code.js'), 'x');
  const rerun = cli(p, 'test', '--if-needed');
  assert.ok(rerun.out.includes('Running:'), rerun.out);
  // a red run is never reused
  cli(p, 'test', '--', 'node', '-e', '"process.exit(2)"');
  assert.ok(cli(p, 'test', '--if-needed', '--', 'node', '-e', '0').out.includes('Running:'));
});

test('test --if-needed: only documentation changed -> suite not rerun, said and journaled', () => {
  const p = project({ git: true });
  arm(p);
  cli(p, 'test', '--', 'node', '-e', '0');
  const before = readState(p).lastTest;
  assert.match(before.codeFingerprint, /^[0-9a-f]{64}$/);
  assert.notEqual(before.codeFingerprint, before.fingerprint);
  writeFileSync(join(p.dir, 'README.md'), 'hello\n\nmore docs\n');
  writeFileSync(join(p.dir, 'CHANGELOG.md'), '# changes\n');
  const r = cli(p, 'test', '--if-needed');
  assert.equal(r.code, 0);
  assert.ok(r.out.includes('only documentation changed since: suite NOT rerun'), r.out);
  const after = readState(p).lastTest;
  assert.equal(after.codeFingerprint, before.codeFingerprint);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.ok(journal(p).some((e) => e.type === 'test' && e.reused && e.docsOnly));
  // the refreshed full fingerprint now matches the tree: a plain --if-needed reuses again
  assert.ok(cli(p, 'test', '--if-needed').out.includes('exact tree'));
  // outside git nothing can be tied to a tree: the suite runs
  const q = project();
  arm(q);
  cli(q, 'test', '--', 'node', '-e', '0');
  assert.ok(cli(q, 'test', '--if-needed').out.includes('Cannot fingerprint the tree'));
});

test('test verb: failed test names are parsed from the output and a non-reproducible red is journaled', async () => {
  const { parseFailedTests, flakinessNote } = await import('../../src/cli/verbs/test.mjs');
  assert.deepEqual(parseFailedTests('FAILED tests/test_a.py::test_one - AssertionError\nFAILED tests/test_b.py::TestX::test_two\n'), ['tests/test_a.py::test_one', 'tests/test_b.py::TestX::test_two']);
  assert.deepEqual(parseFailedTests('not ok 3 - counts beats # SKIP\nnot ok 4 - loop free\n'), ['counts beats', 'loop free']);
  assert.deepEqual(parseFailedTests('  ✖ heartbeat (5.12ms)\n  ✕ jest style\n'), ['heartbeat', 'jest style']);
  assert.deepEqual(parseFailedTests('--- FAIL: TestGo (0.00s)\ntest mod::t1 ... FAILED\n'), ['TestGo', 'mod::t1']);
  assert.deepEqual(parseFailedTests('all green'), []);
  assert.equal(flakinessNote(null, { exitCode: 1, failed: ['a'] }, true), '');
  assert.equal(flakinessNote({ exitCode: 0 }, { exitCode: 1, failed: ['a'] }, true), '');
  assert.equal(flakinessNote({ exitCode: 1, failed: ['a'] }, { exitCode: 1, failed: ['a'] }, true), '');
  assert.equal(flakinessNote({ exitCode: 1, failed: ['a'] }, { exitCode: 0, failed: [] }, false), '');
  assert.ok(flakinessNote({ exitCode: 1, failed: ['a'] }, { exitCode: 0, failed: [] }, true).includes('red not reproducible'));
  assert.ok(flakinessNote({ exitCode: 1, failed: ['a', 'b'] }, { exitCode: 1, failed: ['b', 'c'] }, true).includes('a failed in the previous run'));

  // through the real verb: a red with a parsed name, then green on the same tree
  const p = project({ git: true });
  arm(p);
  const red = cli(p, 'test', '--', 'node', '-e', '"console.log(\'not ok 1 - heartbeat\'); process.exit(1)"');
  assert.equal(red.code, 1);
  assert.ok(red.out.includes('Failed: heartbeat'), red.out);
  assert.deepEqual(readState(p).lastTest.failed, ['heartbeat']);
  const green = cli(p, 'test', '--', 'node', '-e', '0');
  assert.equal(green.code, 0);
  assert.ok(green.out.includes('red not reproducible'), green.out);
  const j = journal(p).filter((e) => e.type === 'test');
  assert.deepEqual(j[0].failed, ['heartbeat']);
  assert.ok(j[1].flaky.includes('heartbeat'));
  assert.ok(cli(p, 'history').out.includes('FLAKY'));
});

test('arm reports reachability from the last provider check, and --check probes now', () => {
  const p = project();
  // only the http provider takes part: the CLIs installed on the developer's machine are disabled
  const CLIS = ['codex', 'agy', 'grok', 'cursor', 'claude'];
  writeFileSync(join(p.home, 'config.json'), JSON.stringify({ providers: { disabled: CLIS } }));
  // a provider "detected" (its key is set) but never probed
  p.env.OLLAMA_API_KEY = 'k';
  const a = cli(p, 'arm', 'x', '--no-git-finish');
  assert.equal(a.code, 0, a.out);
  assert.ok(a.out.includes('External models for the second opinion: ollama-cloud'), a.out);
  assert.ok(a.out.includes('never probed: ollama-cloud'), a.out);
  cli(p, 'disarm', '--no-archive');
  // a recorded failure is reported as such, not as "available"
  writeFileSync(join(p.home, 'config.json'), JSON.stringify({ providers: { disabled: CLIS, lastCheck: { 'ollama-cloud': { ok: false, at: '2026-09-06T00:00:00.000Z', error: 'HTTP 404 model not found' } } } }));
  const b = cli(p, 'arm', 'x', '--no-git-finish');
  assert.ok(b.out.includes('FAILED the last check: ollama-cloud (HTTP 404 model not found)'), b.out);
  cli(p, 'disarm', '--no-archive');
  // --check probes now against an unreachable host: dropped for this run and disabled in the config
  p.env.OLLAMA_HOST = 'http://127.0.0.1:9';
  p.env.OMC_ASK_TIMEOUT_MS = '3000';
  const c = cli(p, 'arm', 'x', '--no-git-finish', '--check');
  assert.equal(c.code, 0, c.out);
  assert.ok(c.out.includes('External models for the second opinion: none'), c.out);
  assert.ok(c.out.includes('probed now: ollama-cloud: FAILED'), c.out);
  assert.deepEqual(readState(p).options.externals, []);
  const cfg = JSON.parse(readFileSync(join(p.home, 'config.json'), 'utf8'));
  assert.deepEqual(cfg.providers.disabled, [...CLIS, 'ollama-cloud']);
  assert.equal(cfg.providers.lastCheck['ollama-cloud'].ok, false);
  assert.ok(cli(p, 'providers', 'list').out.includes('DISABLED'));
});
