// Phase 3 of docs/PIANO-MOD.md, the pure parts: the tool's arguments (hooks/lib/verbs.js, plain
// JavaScript the mod and Node both load), the words of /pf, the CLI's refusal of a run that came
// from the tool, the loop mode of a stop, and every prompt in both modes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateToolInput, toolRun, toolSchema, toolDescription, splitArgs, commandRun, verbArgs, serveCommand, isRunId, formatRun, cut, exitCodeOf, TOOL_VERBS, SHELL_VERBS, USER_VERBS, COMMAND_VERBS, ORIGIN_VERBS, USER_ORIGINS, TOOL_ARGS, MAX_OUTPUT } from '../../hooks/lib/verbs.js';
import { READ_ONLY_VERBS } from '../../hooks/lib/core.js';
import { COMPLEXITIES, normalizeState, defaultState } from '../../src/core/state.mjs';
import { VERBS, TOOL_VIA_VERBS, toolViaRefusal } from '../../src/cli/perseveranza.mjs';
import { RECONCILE_TOOL_VERBS, reconcileDecision } from '../../src/shell/activity-hook.mjs';
import { DEFAULT_PROMPTS, PROMPT_KEYS, PROMPT_VARS, renderPrompt, loopVar, userVar, bashVar, effectiveLoopMode, validatePack } from '../../src/core/prompts.mjs';
import { sessionNotice, compactNotice } from '../../src/core/staleness.mjs';
import { ROOT } from '../../src/shell/paths.mjs';
import { mk, run, LOOP } from '../helpers/core.mjs';

const IT = validatePack(JSON.parse(readFileSync(join(ROOT, 'packs', 'it.json'), 'utf8'))).overrides;
const T = 1_700_000_000_000;

// ---------------------------------------------------------------- the lists agree with the code
test('the tool\'s lists: only the loop\'s own state; test, ask, arm, disarm never; the CLI refuses the same', () => {
  assert.deepEqual(TOOL_VERBS, ['status', 'history', 'explain', 'report', 'complexity', 'claim-done', 'pause', 'resume']);
  assert.deepEqual(TOOL_VIA_VERBS, TOOL_VERBS);
  assert.deepEqual(TOOL_ARGS.level.schema.enum, COMPLEXITIES);
  for (const v of COMMAND_VERBS) assert.ok(VERBS.includes(v), v);
  for (const v of [...USER_VERBS, ...SHELL_VERBS]) assert.ok(!TOOL_VERBS.includes(v), v);
  assert.deepEqual(ORIGIN_VERBS, ['arm', 'disarm', 'test', 'ask']);
  assert.deepEqual(USER_ORIGINS, ['composer', 'bridge', 'sdk']);
  // the read-only verbs the mod lets past the guard are ones the guard lets through
  for (const v of READ_ONLY_VERBS) assert.equal(reconcileDecision('mcp__perseveranza__perseveranza', { verb: v }), null, v);
  for (const v of TOOL_VERBS.filter((x) => !RECONCILE_TOOL_VERBS.includes(x))) assert.ok(reconcileDecision('mcp__perseveranza__perseveranza', { verb: v }), v);
  assert.equal(reconcileDecision('mcp__perseveranza__perseveranza', { verb: 'pause' }), null);
});

test('the CLI, run with PERSEVERANZA_VIA=tool: every verb outside the tool\'s, and a takeover, refused', () => {
  for (const v of VERBS.filter((x) => !TOOL_VIA_VERBS.includes(x))) assert.match(toolViaRefusal('tool', v, []), /does not run through the perseveranza tool/, v);
  assert.match(toolViaRefusal('tool', 'test', ['--', 'npm test']), /shell command with Bash/);
  assert.match(toolViaRefusal('tool', 'resume', ['--takeover']), /user's decision/);
  // a takeover anywhere in the words, not only first
  assert.match(toolViaRefusal('tool', 'resume', ['x', '--takeover']), /user's decision/);
  assert.match(toolViaRefusal('tool', 'resume', ['--json', '--takeover']), /user's decision/);
  for (const v of TOOL_VIA_VERBS) assert.equal(toolViaRefusal('tool', v, []), null, v);
  // the command and the shell are not the tool
  for (const via of ['command', null, undefined, 'TOOL']) {
    assert.equal(toolViaRefusal(via, 'test', ['--', 'x']), null, String(via));
    assert.equal(toolViaRefusal(via, 'resume', ['--takeover']), null, String(via));
  }
});

test('the schema: closed, no field of test or ask; the description gives the exact forms and sends test/ask to Bash', () => {
  const s = toolSchema();
  assert.equal(s.type, 'object');
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ['verb']);
  assert.deepEqual(Object.keys(s.properties), ['verb', 'args', 'outcome', 'level', 'tail']);
  assert.deepEqual(s.properties.verb.enum, TOOL_VERBS);
  for (const [k, p] of Object.entries(s.properties)) {
    if (p.type === 'string') assert.ok(p.enum || p.maxLength, `${k}: an enum or a length`);
  }
  const d = toolDescription('node "R/src/cli/perseveranza.mjs"');
  for (const words of ['{"verb": "report", "args": "pass"}', '{"verb": "complexity", "args": "low"}', '{"verb": "claim-done"}', 'does NOT run the suite (test) or an external model (ask)', 'node "R/src/cli/perseveranza.mjs" test --if-needed', '/pf arm|disarm|resume --takeover', 'node "R/src/cli/perseveranza.mjs" <verb>']) assert.ok(d.includes(words), words);
});

// ---------------------------------------------------------------- the tool's arguments
test('validateToolInput: the words as a loop instruction writes them, or typed fields; the reserved keys of tool.call ignored', () => {
  const ok = (e) => { const v = validateToolInput({ tool: 'mcp__perseveranza__perseveranza', tool_use_id: 'u', agentId: 'a', ...e }); assert.ok(!v.error, `${JSON.stringify(e)}: ${v.error}`); return v.argv; };
  assert.deepEqual(ok({ verb: 'status' }), ['status']);
  // the form the e2e saw Haiku use
  assert.deepEqual(ok({ verb: 'complexity', args: 'low' }), ['complexity', 'low']);
  assert.deepEqual(ok({ verb: 'complexity', level: 'high' }), ['complexity', 'high']);
  assert.deepEqual(ok({ verb: 'complexity', level: 'high', args: 'high' }), ['complexity', 'high']);
  assert.deepEqual(ok({ verb: 'complexity low' }), ['complexity', 'low']);
  assert.deepEqual(ok({ verb: 'report', args: ' fail ' }), ['report', 'fail']);
  assert.deepEqual(ok({ verb: 'report', outcome: 'pass' }), ['report', 'pass']);
  assert.deepEqual(ok({ verb: 'report', args: '' , outcome: 'pass' }), ['report', 'pass']);
  assert.deepEqual(ok({ verb: 'history', args: '--tail 12' }), ['history', '--tail', '12']);
  assert.deepEqual(ok({ verb: 'history', args: '7' }), ['history', '--tail', '7']);
  assert.deepEqual(ok({ verb: 'history', tail: '12' }), ['history', '--tail', '12']);
  assert.deepEqual(ok({ verb: 'claim-done', args: null }), ['claim-done']);
  assert.deepEqual(ok({ verb: 'resume' }), ['resume']);
});

test('validateToolInput: test, ask, arm, disarm and a takeover are refused by kind; everything outside the schema is an error', () => {
  const v = (e) => validateToolInput(e);
  for (const verb of SHELL_VERBS) {
    assert.equal(v({ verb }).shell, verb);
    assert.equal(v({ verb: `${verb} --if-needed -- npm test` }).shell, verb);
  }
  assert.equal(v({ verb: 'ask', provider: 'codex', slot: 'plan', prompt: 'p' }).shell, 'ask');
  for (const verb of USER_VERBS) assert.equal(v({ verb, args: 'x' }).user, verb);
  assert.equal(v({ verb: 'resume', takeover: true }).user, 'resume --takeover');
  assert.equal(v({ verb: 'resume', takeover: false }).user, 'resume --takeover');
  assert.equal(v({ verb: 'resume', args: '--takeover' }).user, 'resume --takeover');
  assert.equal(v({ verb: 'resume --takeover' }).user, 'resume --takeover');
  const err = (e) => v(e).error;
  assert.match(err(null), /not an object/);
  assert.match(err([]), /not an object/);
  assert.match(err({ verb: '' }), /"verb" is missing/);
  assert.match(err({ verb: '  ' }), /"verb" is missing/);
  assert.match(err({ verb: 'providers' }), /unknown verb/);
  assert.match(err({ verb: 'runs' }), /unknown verb/);
  assert.match(err({ verb: '__proto__' }), /unknown verb/);
  assert.match(err({ verb: 'status', constructor: 'x' }), /unknown argument "constructor"/);
  assert.match(err({ verb: 'status', command: 'npm test' }), /unknown argument "command"/);
  assert.match(err({ verb: 'status', outcome: 'pass' }), /not an argument of status/);
  assert.match(err({ verb: 'status', args: 'now' }), /status takes only --json/);
  assert.match(err({ verb: 'claim-done', args: 'please' }), /claim-done takes no words/);
  assert.match(err({ verb: 'pause', args: 'pause' }), /pause takes no words/);
  assert.match(err({ verb: 'complexity' }), /complexity takes one word: low, medium, high/);
  assert.match(err({ verb: 'complexity', args: 'low high' }), /takes one word/);
  assert.match(err({ verb: 'complexity', level: 'low', args: 'high' }), /disagree/);
  assert.match(err({ verb: 'report', outcome: 'PASS' }), /one of pass, fail/);
  assert.match(err({ verb: 'report', args: 'pass; rm -rf /' }), /report takes one word/);
  assert.match(err({ verb: 'report', args: 3 }), /must be a string/);
  assert.match(err({ verb: 'report', args: 'x'.repeat(201) }), /longer than 200/);
  assert.match(err({ verb: 'report', args: '"pass' }), /quote is not closed/);
  assert.match(err({ verb: 'history', tail: 501 }), /from 1 to 500/);
  assert.match(err({ verb: 'history', tail: '9999' }), /from 1 to 500/);
  assert.match(err({ verb: 'history', args: '--tail 501' }), /from 1 to 500/);
  assert.match(err({ verb: 'history', args: '9999' }), /from 1 to 500/);
  assert.match(err({ verb: 'history', tail: 1.5 }), /from 1 to 500/);
  assert.match(err({ verb: 'history', args: '--tail 0' }), /from 1 to 500/);
  assert.match(err({ verb: 'history', args: '--tail' }), /history takes --tail N/);
  assert.match(err({ verb: 'history', tail: 3, args: '--tail 4' }), /both say/);
});

test('toolRun: argv only, never a shell string, the verb\'s timeout', () => {
  assert.deepEqual(toolRun({ verb: 'report', argv: ['report', 'pass'] }), { argv: ['report', 'pass'], stdin: '', timeoutMs: 60000 });
});

// ---------------------------------------------------------------- /pf's words
test('splitArgs: quotes as a shell splits them, nothing interpreted', () => {
  assert.deepEqual(splitArgs('arm "a b" --x \'c "d"\' e\\f').tokens, ['arm', 'a b', '--x', 'c "d"', 'e\\f']);
  assert.deepEqual(splitArgs('arm "say \\"hi\\" \\\\ ok"').tokens, ['arm', 'say "hi" \\ ok']);
  assert.deepEqual(splitArgs('  status  ').tokens, ['status']);
  assert.deepEqual(splitArgs('arm ""').tokens, ['arm', '']);
  assert.deepEqual(splitArgs('arm $(rm -rf /) `x` ; y | z').tokens, ['arm', '$(rm', '-rf', '/)', '`x`', ';', 'y', '|', 'z']);
  assert.match(splitArgs('arm "x').error, /double quote/);
  assert.match(splitArgs("arm 'x").error, /single quote/);
  assert.match(splitArgs('x'.repeat(8001)).error, /longer than 8000/);
  assert.match(splitArgs('a\u0001b').error, /control/);
  assert.match(splitArgs(Array(65).fill('a').join(' ')).error, /more than 64/);
  assert.deepEqual(splitArgs(undefined).tokens, []);
});

test('commandRun: the verbs of /pf; a verb that takes no words refuses extra ones (disarm included)', () => {
  assert.deepEqual(commandRun(''), { verb: 'status', argv: ['status'], stdin: '', timeoutMs: 60000 });
  assert.deepEqual(commandRun('arm "t" --complexity low').argv, ['arm', 't', '--complexity', 'low']);
  assert.equal(commandRun('arm x').timeoutMs, 180000);
  assert.equal(commandRun('test -- npm test').timeoutMs, 600000);
  assert.equal(commandRun('ask codex plan -- p').timeoutMs, 600000);
  assert.deepEqual(commandRun('help'), { help: true });
  assert.equal(commandRun('fix the bug').unknown, true);
  for (const v of COMMAND_VERBS.filter((x) => !['report', 'complexity'].includes(x))) assert.equal(commandRun(v).verb, v, v);
  assert.deepEqual(commandRun('disarm').argv, ['disarm']);
  assert.deepEqual(commandRun('disarm --no-archive').argv, ['disarm', '--no-archive']);
  assert.deepEqual(commandRun('resume --takeover').argv, ['resume', '--takeover']);
  assert.deepEqual(commandRun('history --tail 5 --json').argv, ['history', '--tail', '5', '--json']);
  assert.deepEqual(commandRun('runs show 2026-10-05_x --all').argv, ['runs', 'show', '2026-10-05_x', '--all']);
  // the ids `runs list` prints: <project>/<stamp> (archive.mjs safe() names), or the stamp alone
  assert.deepEqual(commandRun('runs show my.proj_1/2026-10-05T10-04-16-591Z-nriWqy').argv, ['runs', 'show', 'my.proj_1/2026-10-05T10-04-16-591Z-nriWqy']);
  assert.deepEqual(commandRun('runs show p/2026-10-05T10-04-16-591Z-nriWqy --all').argv, ['runs', 'show', 'p/2026-10-05T10-04-16-591Z-nriWqy', '--all']);
  for (const id of ['proj/stamp', 'stamp', 'a-b/c_d', 'x'.repeat(120)]) assert.equal(isRunId(id), true, id);
  for (const id of ['', 'a/b/c', '/abs', 'abs/', '..', 'proj/..', 'proj/.x', '.x', 'a\\b', 'C:x', 'a b', 'x'.repeat(121), null, 3]) assert.equal(isRunId(id), false, String(id));
  for (const bad of ['disarm the legacy alarm module', 'disarm --no-archive now', 'disarm --no-archive --no-archive', 'pause for lunch', 'resume now', 'resume --takeover please', 'status x', 'claim-done yes', 'explain all', 'report', 'report pass fail', 'report maybe', 'complexity huge', 'history 5', 'history --tail x', 'runs delete x', 'runs show ../x', 'runs show .hidden', 'runs show a/b/c', 'runs show /abs', 'runs show proj/..', 'runs show proj/.x', 'runs show a\\\\b', 'runs show C:x', 'runs show p/s --all x', 'runs show']) {
    const c = commandRun(bad);
    assert.ok(c.error && !c.argv, `${bad}: ${JSON.stringify(c)}`);
  }
});

test('serveCommand: arm, disarm, test, ask and a takeover without an origin (absent, null, no kind) run nothing, before any call', async () => {
  // an io that fails every call: the refusal comes before the mod touches anything
  const io = new Proxy({}, { get: () => () => { throw new Error('touched'); } });
  for (const e of [{}, { origin: null }, { origin: {} }, { origin: { kind: 7 } }, { origin: { kind: '' } }, { origin: { kind: 'plugin' } }]) {
    for (const args of ['arm "x"', 'disarm', 'test -- npm test', 'ask codex plan -- "x"', 'resume --takeover']) {
      const r = await serveCommand(io, {}, { ...e, args });
      assert.equal(r.exitCode, 1, `${JSON.stringify(e)} ${args}`);
      assert.match(r.text, /runs only when the user types it/);
    }
  }
});

test('verbArgs: the tool\'s resume never takes --takeover, the user\'s does', () => {
  assert.match(verbArgs('resume', ['--takeover']).error, /takes no words/);
  assert.deepEqual(verbArgs('resume', ['--takeover'], { user: true }).argv, ['resume', '--takeover']);
  assert.match(verbArgs('nope', []).error, /unknown verb/);
});

test('formatRun, exitCodeOf and cut: the exit code in words, any failure is FAILED, the head and the tail of a long output', () => {
  assert.equal(formatRun('report', { exitCode: 0, stdout: 'Outcome recorded: pass\n', stderr: '' }), 'perseveranza report: done (exit 0)\nOutcome recorded: pass');
  assert.equal(formatRun('test', { exitCode: 1, stdout: 'TEST RED', stderr: 'boom' }), 'perseveranza test: FAILED or REFUSED (exit 1)\nTEST RED\n[stderr]\nboom');
  // every exit but 0 is a failure, not only 1
  for (const code of [2, 3, 124, 255, -1]) assert.ok(formatRun('arm', { exitCode: code, stdout: '' }).startsWith(`perseveranza arm: FAILED or REFUSED (exit ${code})`), code);
  assert.ok(formatRun('status', { stdout: 'x', isStdoutTruncated: true }).includes('exit 1) [output truncated by Claude Code]'));
  for (const [r, code] of [[{ exitCode: 0 }, 0], [{ exitCode: 2 }, 2], [{ exitCode: 255 }, 255], [{ exitCode: -1 }, 1], [{ exitCode: -255 }, 1], [{ exitCode: 256 }, 1], [{ exitCode: 1.5 }, 1], [{}, 1], [{ exitCode: '0' }, 1]]) assert.equal(exitCodeOf(r), code, JSON.stringify(r));
  const long = `HEAD${'x'.repeat(MAX_OUTPUT * 2)}TAIL`;
  const c = cut(long, MAX_OUTPUT);
  assert.ok(c.startsWith('HEAD') && c.endsWith('TAIL') && c.length < MAX_OUTPUT + 100, c.length);
  assert.equal(cut('short', 10), 'short');
});

// ---------------------------------------------------------------- the loop mode
test('effectiveLoopMode: the tool only when the run was armed for it and the driver has it', () => {
  assert.equal(effectiveLoopMode('tool', 'tool'), 'tool');
  for (const [a, d] of [['tool', 'shell'], ['tool', undefined], ['shell', 'tool'], [undefined, 'tool'], ['TOOL', 'tool'], ['tool', 'Tool']]) assert.equal(effectiveLoopMode(a, d), 'shell', `${a} ${d}`);
  assert.equal(defaultState().options.loopMode, 'shell');
  assert.equal(normalizeState({ phase: 'plan', options: { loopMode: 'tool' } }).options.loopMode, 'tool');
  for (const bad of ['TOOL', 'cli', 3, null, {}]) assert.equal(normalizeState({ phase: 'plan', options: { loopMode: bad } }).options.loopMode, 'shell', String(bad));
});

// ---------------------------------------------------------------- every prompt, both modes
const PLAN = '- [ ] step one\n- [ ] step two\n';
const PLAN_DONE = '- [x] step one\n- [x] step two\n';
const R = { verdictRequestId: 'R1', verdictRequestedAt: T };
const rv = (o = {}) => JSON.stringify({ requestId: 'R1', blocking: 0, findings: [], ...o });
const vf = (o = {}) => JSON.stringify({ requestId: 'R1', pass: true, findings: [], ...o });
const lensVf = (lens, o = {}) => JSON.stringify({ requestId: 'R1', lens, pass: true, findings: [], ...o });

// In tool mode the CLI may appear only where a verb the tool does not run is named (the suite
// of `test`, an external model of `ask`), each time right after the words that send it to Bash
// (the second CLI of hint-ask, its stdin form, after a pipe). -> the offending excerpts
function strayCli(text, layers) {
  const bash = renderPrompt('loop-bash', {}, layers);
  const bad = [];
  for (let i = text.indexOf(LOOP); i >= 0; i = text.indexOf(LOOP, i + 1)) {
    const before = text.slice(0, i);
    const after = text.slice(i + LOOP.length);
    const sent = before.endsWith(`${bash} `) || before.endsWith('| ');
    const verb = after.startsWith(' test ') || after.startsWith(' ask ');
    if (!sent || !verb) bad.push(text.slice(Math.max(0, i - 60), i + LOOP.length + 20));
  }
  return bad;
}

// the phases with the advisor (plan, the 2nd fix of a step, the 2nd rejection), every lens,
// the external models (ask) and the test run
const CASES = [
  ['plan with the advisor', mk(), { planExists: false }],
  ['plan with the advisor and an external', mk({ options: { externals: ['codex'] } }), { planExists: false }],
  ['2nd fix: the advisor', mk({ phase: 'review', ...R, counters: { retries: 1 } }), { artifacts: { review: rv({ blocking: 1 }) }, planText: PLAN }],
  ['2nd fix with an external', mk({ phase: 'review', ...R, counters: { retries: 1 }, options: { externals: ['codex'] } }), { artifacts: { review: rv({ blocking: 1 }) }, planText: PLAN }],
  ['2nd rejection: the advisor of the verification fix', mk({ phase: 'final-verify', ...R, verdictLenses: ['general'], counters: { finalFails: 1 } }), { planText: PLAN_DONE, artifacts: { verify: vf({ pass: false, findings: [{ severity: 'critical', desc: 'x' }] }) } }],
  ['every lens requested', mk({ phase: 'cleanup', options: { verifiers: ['general', 'correctness', 'security', 'tests'] } }), { planText: PLAN_DONE }],
  ['every lens and an external', mk({ phase: 'cleanup', options: { verifiers: ['general', 'correctness'], externals: ['codex', 'grok'] } }), { planText: PLAN_DONE }],
  ['lenses missing', mk({ phase: 'final-verify', ...R, verdictLenses: ['correctness', 'security', 'tests'] }), { planText: PLAN_DONE, artifacts: { verifyLenses: { correctness: lensVf('correctness') } } }],
  ['lens rejection', mk({ phase: 'final-verify', ...R, verdictLenses: ['correctness', 'security'] }), { planText: PLAN_DONE, artifacts: { verifyLenses: { correctness: lensVf('correctness', { pass: false, findings: [{ severity: 'critical', desc: 'x' }] }), security: lensVf('security') } } }],
  ['plan approval', mk({ options: { approvePlan: true } }), { planExists: true, planText: PLAN }],
  ['claim refused, no test', mk({ phase: 'implement', signals: { claimedDone: true }, options: { testCmd: 'npm test' } }), { planText: PLAN_DONE }],
  ['review passed, plan done: the test run', mk({ phase: 'review', ...R, options: { testCmd: 'npm test' } }), { artifacts: { review: rv() }, planText: PLAN_DONE }],
  ['review missing', mk({ phase: 'review', ...R }), {}],
  ['verify missing', mk({ phase: 'final-verify', ...R, verdictLenses: ['general'] }), { planText: PLAN_DONE }],
];

test('tool mode: every phase names the tool for the loop\'s verbs; test and ask only as Bash commands; the user\'s verbs as /pf (en and it)', () => {
  for (const layers of [[], [IT]]) {
    const tool = loopVar('tool', LOOP, layers);
    const bash = renderPrompt('loop-bash', {}, layers);
    let named = 0;
    let sent = 0;
    for (const [name, s, c] of CASES) {
      const r = run(s, { ...c, overrides: layers, loopMode: 'tool' }, { now: T + 1000 });
      assert.ok(r.blocked, name);
      assert.deepEqual(strayCli(r.reason, layers), [], `${name}: ${r.reason}`);
      // never the tool for test or ask
      assert.ok(!r.reason.includes(`${tool} test`) && !r.reason.includes(`${tool} ask`), `${name}: ${r.reason}`);
      if (r.reason.includes(tool)) named++;
      if (r.reason.includes(`${bash} ${LOOP} test --if-needed -- npm test`) || r.reason.includes(`${bash} ${LOOP} ask <provider>`)) sent++;
    }
    assert.ok(named >= 9, `the tool named in ${named} phases`);
    assert.ok(sent >= 4, `test or ask sent to Bash in ${sent} phases`);
    const approval = run(mk({ options: { approvePlan: true } }), { planExists: true, planText: PLAN, overrides: layers, loopMode: 'tool' }, { now: T + 1000 });
    assert.ok(approval.reason.includes(`${userVar('tool', LOOP, layers)} resume`), approval.reason);
    assert.ok(!approval.reason.includes(`${tool} resume`), approval.reason);
  }
});

test('shell mode: the same phases name the CLI command, byte for byte as before (USER and BASH are the CLI)', () => {
  let named = 0;
  for (const [name, s, c] of CASES) {
    const r = run(s, c, { now: T + 1000 });
    assert.ok(r.blocked, name);
    assert.ok(!r.reason.includes('the `perseveranza` tool') && !r.reason.includes('/pf') && !r.reason.includes(renderPrompt('loop-bash')), `${name}: ${r.reason}`);
    if (r.reason.includes(LOOP)) named++;
  }
  assert.ok(named >= 9, `the CLI named in ${named} phases`);
  assert.equal(userVar('shell', LOOP), LOOP);
  assert.equal(bashVar('shell', LOOP), LOOP);
  assert.equal(userVar(undefined, LOOP, [IT]), LOOP);
});

test('every prompt key that uses {{LOOP}} renders the tool in tool mode and the CLI in shell mode, in both languages', () => {
  for (const layers of [[], [IT]]) {
    const tool = loopVar('tool', LOOP, layers);
    const user = userVar('tool', LOOP, layers);
    const testRun = `${bashVar('tool', LOOP, layers)} test --if-needed -- npm test`;
    // the keys whose template (in this language) says {{LOOP}}: session-restore may, and does not
    const uses = PROMPT_KEYS.filter((k) => (PROMPT_VARS[k] || []).includes('LOOP') && String((layers[0] && layers[0][k]) || DEFAULT_PROMPTS[k]).includes('{{LOOP}}'));
    assert.ok(uses.length >= 19, uses.length);
    for (const key of uses) {
      if (key === 'hint-ask') continue; // rendered with the CLI in both modes (askHint, below)
      const t = renderPrompt(key, { LOOP: tool, USER: user, testRun }, layers);
      assert.ok(t.includes(tool), `${key}: ${t}`);
      assert.deepEqual(strayCli(t, layers), [], `${key}: ${t}`);
      const s = renderPrompt(key, { LOOP, USER: LOOP, testRun: `${LOOP} test --if-needed -- npm test` }, layers);
      assert.ok(s.includes(LOOP), `${key}: ${s}`);
    }
  }
  // PROMPT_VARS keeps LOOP where it was (hint-ask-tool is gone: tool mode sends ask to Bash)
  assert.equal(PROMPT_KEYS.filter((k) => (PROMPT_VARS[k] || []).includes('LOOP')).length, 25);
  assert.equal(DEFAULT_PROMPTS['hint-ask-tool'], undefined);
  assert.ok(DEFAULT_PROMPTS['loop-tool'].includes('{"verb": "<the first word>", "args": "<the words after it, if any>"}'));
});

// The instructions that hand a verb to the USER (approving a plan, resuming, disarming, taking a
// loop over): in tool mode they name /pf, typed by the user, never the tool; in shell mode the CLI.
const USER_KEYS = ['plan-approval', 'session-abandoned', 'session-live', 'session-released', 'session-waiting'];
test('{{USER}}: every user-directed prompt names /pf in tool mode and the CLI in shell mode (en and it); the packs use it', () => {
  assert.deepEqual(PROMPT_KEYS.filter((k) => (PROMPT_VARS[k] || []).includes('USER')), USER_KEYS);
  for (const layers of [[], [IT]]) {
    const tool = loopVar('tool', LOOP, layers);
    const user = userVar('tool', LOOP, layers);
    assert.ok(user.endsWith('/pf'), user);
    for (const key of USER_KEYS) {
      const tpl = String((layers[0] && layers[0][key]) || DEFAULT_PROMPTS[key]);
      assert.ok(tpl.includes('{{USER}}') && !/\{\{LOOP\}\} (resume|disarm)/.test(tpl), `${key}: ${tpl}`);
      const t = renderPrompt(key, { LOOP: tool, USER: user }, layers);
      assert.ok(/\/pf (resume|disarm)/.test(t) && !t.includes(`${tool} resume`) && !t.includes(`${tool} disarm`) && !t.includes(LOOP), `${key}: ${t}`);
      const s = renderPrompt(key, { LOOP, USER: LOOP }, layers);
      assert.ok(s.includes(`${LOOP} resume`) && !s.includes('/pf'), `${key}: ${s}`);
    }
  }
});

test('the notices of another session (staleness.mjs) take USER, and default it to LOOP', () => {
  const s = normalizeState({ phase: 'review', task: 'x', armedAt: new Date(T).toISOString(), owner: { sessionId: 'owner-sess', lastFireAt: T } });
  const abandoned = { now: T + 24 * 3600 * 1000, sessionId: 'new-sess', LOOP: 'TOOL:' };
  assert.ok(sessionNotice(s, { ...abandoned, USER: '/pf' }).includes('(/pf resume --takeover'));
  assert.ok(sessionNotice(s, { ...abandoned, USER: '/pf' }).includes('(/pf disarm'));
  assert.ok(sessionNotice(s, abandoned).includes('(TOOL: resume --takeover'));
  const live = { now: T + 60 * 1000, sessionId: 'new-sess', LOOP: 'TOOL:', USER: '/pf' };
  assert.ok(sessionNotice(s, live).includes('/pf resume --takeover hands'));
  assert.ok(compactNotice(s, { LOOP: 'TOOL:', USER: '/pf' }).includes('TOOL: status'));
});
