// Phase 3 of docs/PIANO-MOD.md, the Node side: `arm` checks that the mod is alive in its session
// (the sign of life the mod writes: src/shell/mod-alive.mjs) and arms for the tool or the shell;
// the verbs the mod runs journal how they came (PERSEVERANZA_VIA); a stop and a session notice
// name the tool only when the run was armed for it AND the driver has it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimesSync, readdirSync, mkdirSync } from 'node:fs';
import { project, cli, arm, armWithMod, modAlive, MOD_SESSION, readState, patchState, journal, gate, fire, spawnSync, existsSync, writeFileSync, join, NODE } from '../helpers/cli.mjs';
import { ROOT } from '../../src/shell/paths.mjs';
import { pruneAlive, readAlive, currentSession, alivePath, ALIVE_MAX_AGE_MS, ALIVE_KEEP, ALIVE_PROTECT_MS } from '../../src/shell/mod-alive.mjs';

const CLI = join(ROOT, 'src', 'cli', 'perseveranza.mjs');
const BRIDGE = join(ROOT, 'src', 'shell', 'mod-bridge.mjs');
const TOOL_WORDS = 'the `perseveranza` tool ({"verb": "<the first word>", "args": "<the words after it, if any>"}):';
const BASH_WORDS = 'the shell command (run it with Bash, the `perseveranza` tool does not run it):';
const SHELLISH = /node |perseveranza\.mjs/;

const run = (p, args, env = {}, input = undefined) => {
  const r = spawnSync(NODE, [CLI, ...args], { cwd: p.dir, encoding: 'utf8', env: { ...p.env, ...env }, input });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const ARM = ['arm', 'the task', '--external', 'off', '--no-git-finish'];
function bridge(p, req) {
  const r = spawnSync(NODE, [BRIDGE], { input: JSON.stringify({ cwd: p.dir, ...req, event: { session_id: 't-sess', ...(req.event || {}) } }), encoding: 'utf8', env: p.env });
  return JSON.parse(r.stdout);
}

// ---------------------------------------------------------------- arm and the mod
test('arm inside a session whose mod left no sign of life: refused, nothing written, the causes and the way out', () => {
  const p = project();
  const r = run(p, ARM, { CLAUDE_CODE_SESSION_ID: 'sess-without-mod' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /perseveranza NOT armed: the perseveranza mod is not running in this Claude Code session \(sess-wit/);
  for (const cause of ['2.1.287', '--bare', '--safe-mode', 'disableAllHooks', 'policy', 'trust', 'rollout switch saved off', 'Desktop app', 'VS Code', 'PERSEVERANZA_HOME set differently', '--no-mod-check']) assert.ok(r.out.includes(cause), `${cause}: ${r.out}`);
  assert.equal(existsSync(gate(p, '')), false, 'no .perseveranza/ made for a loop nothing would drive');
});

test('arm with the mod alive in this session: armed for the tool', () => {
  const p = project();
  modAlive(p, 'sess-ok', { claudeCode: '2.1.289' });
  const r = run(p, ARM, { CLAUDE_CODE_SESSION_ID: 'sess-ok' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Mod: alive in this session \(sess-ok on Claude Code 2\.1\.289\)/);
  assert.equal(readState(p).options.loopMode, 'tool');
});

test('a sign of life half written (not JSON) is still one', () => {
  const p = project();
  mkdirSync(join(p.home, 'mod-alive'), { recursive: true });
  writeFileSync(join(p.home, 'mod-alive', 'sess-half.json'), '{"sess');
  const r = run(p, ARM, { CLAUDE_CODE_SESSION_ID: 'sess-half' });
  assert.equal(r.code, 0, r.out);
  assert.equal(readState(p).options.loopMode, 'tool');
});

test('another session\'s sign of life does not count for this one', () => {
  const p = project();
  modAlive(p, 'sess-other');
  const r = run(p, ARM, { CLAUDE_CODE_SESSION_ID: 'sess-mine' });
  assert.equal(r.code, 1, r.out);
});

test('--no-mod-check: armed without the check, for the shell; inside a session it says so', () => {
  const p = project();
  const r = run(p, [...ARM, '--no-mod-check'], { CLAUDE_CODE_SESSION_ID: 'sess-without-mod' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Mod check skipped \(--no-mod-check\)/);
  assert.equal(readState(p).options.loopMode, 'shell');
  // even with the mod alive: the flag is the user's word
  const q = project();
  modAlive(q, 'sess-ok');
  run(q, [...ARM, '--no-mod-check'], { CLAUDE_CODE_SESSION_ID: 'sess-ok' });
  assert.equal(readState(q).options.loopMode, 'shell');
});

test('outside any session (a terminal, a script): armed for the shell, with a warning instead of a refusal', () => {
  const p = project();
  const r = run(p, ARM);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /WARNING: not inside a Claude Code session/);
  assert.equal(readState(p).options.loopMode, 'shell');
  // --no-mod-check there: no warning, the note
  const q = project();
  const s = run(q, [...ARM, '--no-mod-check']);
  assert.ok(!s.out.includes('WARNING'), s.out);
  assert.match(s.out, /no Claude Code session/);
});

test('a session id that is not one (a path) is never a file name: treated as no session', () => {
  const p = project();
  modAlive(p, 'ok-session');
  for (const bad of ['../ok-session', 'a/b', '..', 'x'.repeat(200), 'a b']) {
    assert.equal(alivePath(bad, p.env), null, bad);
    assert.deepEqual(currentSession({ CLAUDE_CODE_SESSION_ID: bad }).id, null, bad);
  }
  const r = run(p, ARM, { CLAUDE_CODE_SESSION_ID: '../ok-session' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no valid CLAUDE_CODE_SESSION_ID: "\.\.\/ok-session"/);
  assert.equal(readState(p).options.loopMode, 'shell');
});

test('arm removes the signs of life older than 30 days, never its own', () => {
  const p = project();
  for (const s of ['old-1', 'old-2', 'fresh', 'mine']) modAlive(p, s);
  const dir = join(p.home, 'mod-alive');
  const old = new Date(Date.now() - ALIVE_MAX_AGE_MS - 3600_000);
  for (const s of ['old-1', 'old-2', 'mine']) utimesSync(join(dir, `${s}.json`), old, old);
  const r = run(p, ARM, { CLAUDE_CODE_SESSION_ID: 'mine' });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(readdirSync(dir).sort(), ['fresh.json', 'mine.json']);
  // pruneAlive itself: nothing to do without the folder
  assert.equal(pruneAlive({ PERSEVERANZA_HOME: join(p.home, 'nope') }), 0);
  assert.equal(readAlive('fresh', p.env).alive, true);
  assert.equal(readAlive('gone', p.env).alive, false);
});

test('a refused arm leaves an armed loop alone (the check comes before anything is written)', () => {
  const p = project();
  arm(p, 'first');
  const before = readState(p);
  const r = run(p, [...ARM, '--force'], { CLAUDE_CODE_SESSION_ID: 'sess-without-mod' });
  assert.equal(r.code, 1);
  assert.deepEqual(readState(p), before);
});

// ---------------------------------------------------------------- the verbs say how they came
test('PERSEVERANZA_VIA=tool: the verbs journal via tool, the summary of the run says so; nothing it starts inherits it', () => {
  const p = project({ git: true });
  // the suite fails if it sees the variable: the CLI took it out of its environment first
  armWithMod(p, 'via', ['--test', 'node -e "process.exit(process.env.PERSEVERANZA_VIA ? 3 : 0)"']);
  const env = { PERSEVERANZA_VIA: 'tool', CLAUDE_CODE_SESSION_ID: MOD_SESSION };
  assert.equal(run(p, ['complexity', 'low'], env).code, 0);
  assert.equal(run(p, ['report', 'pass'], env).code, 0);
  // the suite from /pf (the user's command): it must not see the variable either
  const t = run(p, ['test'], { PERSEVERANZA_VIA: 'command' });
  assert.equal(t.code, 0, t.out);
  assert.equal(run(p, ['pause'], { PERSEVERANZA_VIA: 'command' }).code, 0);
  assert.equal(run(p, ['resume'], { PERSEVERANZA_VIA: 'evil' }).code, 0);
  const j = journal(p);
  const signals = j.filter((x) => x.type === 'signal').map((x) => [x.verb, x.via]);
  assert.deepEqual(signals, [['complexity', 'tool'], ['report', 'tool'], ['pause', 'command'], ['resume', undefined]]);
  assert.equal(j.find((x) => x.type === 'test').via, 'command');
  // the run's archive: disarm it and read the summary
  assert.equal(cli(p, 'disarm').code, 0);
  const runs = join(p.home, 'runs');
  const [project_] = readdirSync(runs);
  const [runDir] = readdirSync(join(runs, project_));
  const summary = JSON.parse(spawnSync(NODE, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(runs, project_, runDir, 'summary.json'))},'utf8'))`], { encoding: 'utf8' }).stdout);
  assert.deepEqual(summary.verbs.map((v) => [v.verb, v.via]), [['complexity', 'tool'], ['report', 'tool'], ['pause', 'command'], ['resume', 'shell'], ['disarm', 'shell']]);
  assert.equal(summary.tests[0].via, 'command');
});

test('a run that came from the tool (PERSEVERANZA_VIA=tool): test, ask, arm, disarm and a takeover refused, nothing started', () => {
  const p = project();
  const write = (name) => `node -e "require('fs').writeFileSync('${name}','x')"`;
  armWithMod(p, 'hostile', ['--test', write('pwned-armed')]);
  const tool = { PERSEVERANZA_VIA: 'tool' };
  const marker = (n) => existsSync(join(p.dir, n));
  // the suite armed by a state edit, then "test" through the tool: refused before it runs
  patchState(p, (s) => { s.options.testCmd = write('pwned-state'); });
  const before = journal(p).length;
  for (const args of [['test'], ['test', '--if-needed'], ['test', '--', write('pwned-given')]]) {
    const r = run(p, args, tool);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /"test" does not run through the perseveranza tool/);
  }
  // ask: no provider started, no opinion written
  const r = run(p, ['ask', 'codex', 'plan', '--', 'hi'], tool);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /"ask" does not run through the perseveranza tool/);
  assert.equal(readdirSync(gate(p, '')).some((n) => n.startsWith('external-')), false);
  // arm, disarm, the rest of the CLI
  for (const args of [['arm', 'x', '--force', '--no-mod-check'], ['disarm'], ['providers', 'check'], ['config'], ['hud', 'on'], ['runs'], ['prompts', 'keys']]) assert.equal(run(p, args, tool).code, 2, args.join(' '));
  // a takeover
  patchState(p, (s) => { s.owner.sessionId = 'other-session'; s.signals.paused = true; });
  const k = run(p, ['resume', '--takeover'], tool);
  assert.equal(k.code, 2, k.out);
  assert.match(k.out, /taking a loop over \(resume --takeover\) is the user's decision/);
  assert.equal(readState(p).owner.sessionId, 'other-session');
  assert.equal(readState(p).signals.paused, true);
  for (const n of ['pwned-armed', 'pwned-state', 'pwned-given']) assert.equal(marker(n), false, n);
  assert.equal(existsSync(gate(p, 'state.json')), true, 'still armed');
  assert.equal(journal(p).length, before, 'nothing journaled');
  // the same verbs from /pf (via command) or a shell run as before
  assert.equal(run(p, ['resume', '--takeover'], { PERSEVERANZA_VIA: 'command' }).code, 0);
  assert.equal(readState(p).owner.sessionId, null);
  assert.equal(run(p, ['test'], {}).code, 0);
  assert.equal(marker('pwned-state'), true, 'the shell runs the suite (Bash permissions decide there)');
});

// ---------------------------------------------------------------- tool words only where both agree
test('the stop names the tool only when the run was armed for it and the driver has it', () => {
  // armed for the tool, driven by the mod with its tool: the tool's words, no shell command
  const p = project();
  armWithMod(p, 'both');
  let r = bridge(p, { op: 'stop', facts: { loopMode: 'tool' } });
  assert.ok(r.decision.block.includes(`${TOOL_WORDS} complexity low|medium|high`), r.decision.block);
  assert.ok(!SHELLISH.test(r.decision.block), r.decision.block);
  // the suite, in tool mode: a shell command for Bash, never the tool
  const q2 = project();
  armWithMod(q2, 'suite', ['--test', 'npm test']);
  writeFileSync(gate(q2, 'plan.md'), '- [x] one\n');
  patchState(q2, (s) => { s.phase = 'implement'; s.signals.claimedDone = true; });
  r = bridge(q2, { op: 'stop', facts: { loopMode: 'tool' } });
  assert.ok(r.decision.block.includes(`${BASH_WORDS} node "`) && r.decision.block.includes('perseveranza.mjs" test --if-needed -- npm test'), r.decision.block);
  assert.ok(!r.decision.block.includes(`${TOOL_WORDS} test`), r.decision.block);
  // armed for the tool, driven without it (a settings hook of a manual install): the shell's
  const q = project();
  armWithMod(q, 'hook');
  const f = fire(q);
  assert.ok(f.reason.includes('perseveranza.mjs" complexity low|medium|high'), f.reason);
  // armed for the shell (--no-mod-check, a terminal), driven by the mod: the shell's
  const s = project();
  arm(s, 'shell');
  r = bridge(s, { op: 'stop', facts: { loopMode: 'tool' } });
  assert.ok(r.decision.block.includes('perseveranza.mjs" complexity'), r.decision.block);
  assert.ok(!r.decision.block.includes(TOOL_WORDS));
});

test('the session notice of the bridge names the tool on the same terms', () => {
  const p = project();
  armWithMod(p, 'notice');
  patchState(p, (s) => { s.owner.sessionId = 'other-session'; s.owner.lastFireAt = Date.now() - 10 * 3600_000; });
  const tool = bridge(p, { op: 'session-start', event: { session_id: 'me', source: 'startup' }, facts: { loopMode: 'tool' } });
  // the takeover and the disarm are the user's: /pf, typed by the user, never the tool
  assert.ok(tool.context.includes('(typed by the user) /pf resume --takeover'), tool.context);
  assert.ok(tool.context.includes('(typed by the user) /pf disarm'), tool.context);
  assert.ok(!tool.context.includes(TOOL_WORDS), tool.context);
  assert.ok(!SHELLISH.test(tool.context), tool.context);
  const shell = bridge(p, { op: 'session-start', event: { session_id: 'me', source: 'startup' }, facts: {} });
  assert.ok(shell.context.includes('perseveranza.mjs" resume --takeover'), shell.context);
});

test('bridge op alive: the sign of life when the mod could not write it; never for an id that is not one', () => {
  const p = project();
  const r = bridge(p, { op: 'alive', facts: { session: 'sess-b', claudeCode: '2.1.289', plugin: 'perseveranza' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const a = readAlive('sess-b', p.env);
  assert.equal(a.alive, true);
  assert.equal(a.info.claudeCode, '2.1.289');
  assert.equal(a.info.via, 'bridge');
  assert.deepEqual(bridge(p, { op: 'alive', facts: { session: '../x' } }), { ok: false, error: 'not a session id' });
  // and arm then finds it
  const armed = run(p, ARM, { CLAUDE_CODE_SESSION_ID: 'sess-b' });
  assert.equal(armed.code, 0, armed.out);
  assert.equal(readState(p).options.loopMode, 'tool');
});

test('bridge op alive with facts.prune: the old ones and the oldest past the cap go, never this session\'s, nothing but signs of life', () => {
  const p = project();
  const dir = join(p.home, 'mod-alive');
  const n = ALIVE_KEEP + 5;
  const id = (i) => `s-${String(i).padStart(3, '0')}`;
  for (let i = 0; i < n; i++) modAlive(p, id(i));
  modAlive(p, 'old-one');
  modAlive(p, 'mine');
  writeFileSync(join(dir, 'notes.txt'), 'not ours');
  writeFileSync(join(dir, 'bad name.json'), 'not ours either');
  // s-000 the oldest ... the last the newest, all older than a day (a younger file is never
  // pruned by count); mine older than all of them; old-one past the age
  for (let i = 0; i < n; i++) { const at = new Date(Date.now() - 2 * 24 * 3600_000 - (n - i) * 60_000); utimesSync(join(dir, `${id(i)}.json`), at, at); }
  const older = new Date(Date.now() - 10 * 24 * 3600_000);
  utimesSync(join(dir, 'mine.json'), older, older);
  const old = new Date(Date.now() - ALIVE_MAX_AGE_MS - 3600_000);
  utimesSync(join(dir, 'old-one.json'), old, old);
  const r = bridge(p, { op: 'alive', facts: { prune: true, session: 'mine' } });
  assert.deepEqual(r, { ok: true, removed: 6 });
  const left = readdirSync(dir).sort();
  assert.equal(left.length, ALIVE_KEEP + 3);
  for (const keep of ['mine.json', 'notes.txt', 'bad name.json', `${id(n - 1)}.json`, `${id(5)}.json`]) assert.ok(left.includes(keep), keep);
  for (const gone of ['old-one.json', `${id(0)}.json`, `${id(4)}.json`]) assert.ok(!left.includes(gone), gone);
  // no session given: nothing kept apart, still the cap
  assert.equal(bridge(p, { op: 'alive', facts: { prune: true } }).ok, true);
  assert.equal(readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'bad name.json').length, ALIVE_KEEP);
});

test('the prune by count never takes a file younger than a day: a long-lived session keeps its sign of life (verification of phase 3)', () => {
  // the verifier's case: session A started 2 h ago, then 100 claude -p children, then session B
  const p = project();
  const dir = join(p.home, 'mod-alive');
  modAlive(p, 'sessA');
  const twoHours = new Date(Date.now() - 2 * 3600_000);
  utimesSync(join(dir, 'sessA.json'), twoHours, twoHours);
  for (let i = 0; i < ALIVE_KEEP; i++) { modAlive(p, `child-${i}`); const at = new Date(Date.now() - 3600_000 + i * 1000); utimesSync(join(dir, `child-${i}.json`), at, at); }
  modAlive(p, 'sessB');
  assert.equal(run(p, ARM, { CLAUDE_CODE_SESSION_ID: 'sessB' }).code, 0);
  assert.equal(existsSync(join(dir, 'sessA.json')), true, 'A keeps its file');
  // and A arms in its own project
  const q = project();
  const r = run(q, ARM, { CLAUDE_CODE_SESSION_ID: 'sessA', PERSEVERANZA_HOME: p.home });
  assert.equal(r.code, 0, r.out);
  // older than a day and past the cap: the oldest go, never the caller's
  const old = (h) => new Date(Date.now() - h * 3600_000);
  utimesSync(join(dir, 'sessA.json'), old(30), old(30));
  for (let i = 0; i < ALIVE_KEEP; i++) utimesSync(join(dir, `child-${i}.json`), old(25), old(25));
  assert.equal(pruneAlive(p.env, { keep: 'sessB' }), 1);
  assert.equal(existsSync(join(dir, 'sessA.json')), false);
  assert.equal(existsSync(join(dir, 'sessB.json')), true);
  assert.ok(ALIVE_PROTECT_MS >= 24 * 3600_000);
});
