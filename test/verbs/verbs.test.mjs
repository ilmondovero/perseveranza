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
  assert.equal(s.options.lang, 'en');
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

test('arm --lang and language detection from the environment', () => {
  const p = project();
  arm(p, 't', ['--lang', 'it']);
  assert.equal(readState(p).options.lang, 'it');
  const q = project();
  q.env.LC_ALL = 'it_IT.UTF-8';
  arm(q);
  assert.equal(readState(q).options.lang, 'it');
  const r = project();
  r.env.PERSEVERANZA_LANG = 'fr';
  const out = arm(r).out;
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
  assert.ok(a && a.length === 40);
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
