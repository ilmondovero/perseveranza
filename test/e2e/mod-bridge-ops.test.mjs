// The bridge operations added for the mod (phase 2): session-start, route-model, tool-check,
// journal, and the mod-stop line of a stop. Each one is read-only on state.json and says the
// same thing as the settings hook it replaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { project, cli, arm, patchState, writePlan, gate, journal, spawnSync, join, NODE, sessionStart, readState, writeState } from '../helpers/cli.mjs';
import { ROOT, GATE_DIRNAME } from '../../src/shell/paths.mjs';
import { reconcileDecision } from '../../src/shell/activity-hook.mjs';
import { MODEL_ROUTING } from '../../src/core/machine.mjs';
import { OPS, MOD_JOURNAL_TYPES } from '../../src/shell/mod-bridge.mjs';
import { lastModStart, modLine } from '../../src/cli/verbs/status.mjs';
import { MOD_FAULT_FILE, readModFault, modFaultText, takeModFault } from '../../src/shell/mod-fault.mjs';
import { alertText } from '../../src/shell/watchdog.mjs';
import { formatEntry } from '../../src/shell/journal.mjs';

const BRIDGE = join(ROOT, 'src', 'shell', 'mod-bridge.mjs');

function bridge(p, req) {
  const input = JSON.stringify({ cwd: p.dir, ...req, event: { session_id: 't-sess', ...(req.event || {}) } });
  const r = spawnSync(NODE, [BRIDGE], { input, encoding: 'utf8', env: p.env });
  let res = null;
  try { res = JSON.parse(r.stdout); } catch { /* reported by the assertions */ }
  return { code: r.status, res, raw: r.stdout, stderr: r.stderr };
}

test('the new operations are listed, and an unknown one names them all', () => {
  for (const op of ['session-start', 'route-model', 'tool-check', 'journal']) assert.ok(OPS.includes(op), op);
  const p = project();
  const r = bridge(p, { op: 'nope' });
  assert.equal(r.res.ok, false);
  assert.ok(r.res.error.includes('route-model') && r.res.error.includes('journal'), r.raw);
});

test('session-start: nothing without a loop; the same notice as the SessionStart hook for a foreign session and after a compaction', () => {
  const p = project();
  let r = bridge(p, { op: 'session-start', event: { session_id: 'other', source: 'startup' } });
  assert.deepEqual(r.res, { ok: true, context: null });
  assert.ok(!existsSync(join(p.dir, GATE_DIRNAME)), 'no folder made');
  arm(p, 'notice task');
  writePlan(p, '- [ ] one\n');
  // the first stop claims the loop for t-sess
  bridge(p, { op: 'stop' });
  assert.equal(readState(p).owner.sessionId, 't-sess');
  for (const [evt, expectText] of [[{ session_id: 'other', source: 'startup' }, true], [{ session_id: 't-sess', source: 'compact' }, true], [{ session_id: 't-sess', source: 'startup' }, false]]) {
    const viaBridge = bridge(p, { op: 'session-start', event: evt }).res;
    const viaHook = sessionStart(p, evt).text;
    assert.equal(viaBridge.ok, true);
    assert.equal(!!viaBridge.context, expectText, JSON.stringify(evt));
    // the hook journals a 'session seen' line too: compare the text, not the timestamps
    const norm = (t) => String(t || '').replace(/\d+(\.\d+)?\s?(s|min|h|ms)\b/g, 'T').replace(/\d{1,2}:\d{2}(:\d{2})?/g, 'HH:MM');
    assert.equal(norm(viaBridge.context), norm(viaHook), JSON.stringify(evt));
  }
  assert.ok(bridge(p, { op: 'session-start', event: { session_id: 'other', source: 'startup' } }).res.context.includes('driven by another session (session t-sess'));
});

test('route-model: a pf-* subagent gets the model MODEL_ROUTING gives the run complexity; anything else, or no loop, keeps its own', () => {
  const p = project();
  let r = bridge(p, { op: 'route-model', event: { subagentType: 'perseveranza:pf-reviewer' } });
  assert.deepEqual(r.res, { ok: true, model: null, outcome: 'dormant' });
  arm(p, 'routing');
  r = bridge(p, { op: 'route-model', event: { subagentType: 'general-purpose' } });
  assert.deepEqual(r.res, { ok: true, model: null, outcome: 'not-a-loop-agent' });
  r = bridge(p, { op: 'route-model', event: { subagentType: 'pf-advisor' } });
  assert.deepEqual(r.res, { ok: true, model: null, outcome: 'no-route' }, 'the advisor model is an option of the run, not a route');
  for (const c of ['low', 'medium', 'high']) {
    assert.equal(cli(p, 'complexity', c).code, 0);
    for (const [agent, route] of [['perseveranza:pf-reviewer', 'review'], ['pf-verifier', 'verify'], ['perseveranza:pf-executor', 'execute']]) {
      r = bridge(p, { op: 'route-model', event: { subagentType: agent, model: 'opus' } });
      assert.deepEqual(r.res, { ok: true, model: MODEL_ROUTING[route][c], outcome: 'routed' }, `${agent} at ${c}`);
    }
  }
  const routes = journal(p).filter((j) => j.type === 'model-route');
  assert.equal(routes.length, 9);
  assert.deepEqual({ ...routes[8], ts: undefined }, { ts: undefined, type: 'model-route', agent: 'perseveranza:pf-executor', complexity: 'high', model: 'opus', asked: 'opus', session: 't-sess' });
  // a loop claimed by another session is not this one's to route
  patchState(p, (s) => { s.owner.sessionId = 'someone-else'; });
  r = bridge(p, { op: 'route-model', event: { subagentType: 'pf-reviewer' } });
  assert.deepEqual(r.res, { ok: true, model: null, outcome: 'foreign-session' });
  // a state that cannot be read has no complexity: the prompt's model stands
  writeState(p, 'not a state');
  r = bridge(p, { op: 'route-model', event: { subagentType: 'pf-reviewer' } });
  assert.equal(r.res.model, null);
  assert.equal(r.res.outcome, 'corrupt', r.raw);
});

test('tool-check: the reconciliation guard of the PreToolUse hook, for the owner only, journaled when it refuses', () => {
  const p = project();
  let r = bridge(p, { op: 'tool-check', event: { tool: 'Edit', input: { file_path: 'a.js' } } });
  assert.deepEqual(r.res, { ok: true, deny: null, outcome: 'dormant' });
  arm(p, 'guard');
  bridge(p, { op: 'stop' });
  r = bridge(p, { op: 'tool-check', event: { tool: 'Edit', input: { file_path: 'a.js' } } });
  assert.deepEqual(r.res, { ok: true, deny: null, outcome: 'free' });
  patchState(p, (s) => { s.signals.interrupted = { at: new Date().toISOString(), silentMs: 60000, phase: 'implement', pending: [] }; });
  const cases = [
    ['Edit', { file_path: 'src/a.js' }],
    ['Write', { file_path: join(p.dir, GATE_DIRNAME, 'reconcile.json') }],
    ['Bash', { command: 'git status' }],
    ['Bash', { command: 'rm -rf src' }],
    ['Agent', { subagent_type: 'pf-executor' }],
    ['Read', { file_path: 'a.js' }],
  ];
  for (const [tool, input] of cases) {
    r = bridge(p, { op: 'tool-check', event: { tool, input } });
    assert.equal(r.res.deny, reconcileDecision(tool, input), `${tool} ${JSON.stringify(input)}`);
    assert.equal(r.res.outcome, r.res.deny ? 'refused' : 'allowed');
  }
  const refused = journal(p).filter((j) => j.type === 'activity' && j.event === 'refused');
  assert.deepEqual(refused.map((j) => j.tool), ['Edit', 'Bash', 'Agent']);
  assert.ok(refused.every((j) => j.via === 'mod' && j.why === 'reconciling'));
  r = bridge(p, { op: 'tool-check', event: { session_id: 'other', tool: 'Edit', input: { file_path: 'a.js' } } });
  assert.deepEqual(r.res, { ok: true, deny: null, outcome: 'foreign-session' });
});

test('journal: only the mod\'s own line types, plain values, cut short, and only beside a live state', () => {
  const p = project();
  let r = bridge(p, { op: 'journal', facts: { lines: [{ type: 'mod-start', claudeCode: '2.1.289', ok: true }] } });
  assert.deepEqual(r.res, { ok: true, journaled: 0, outcome: 'dormant' });
  assert.ok(!existsSync(join(p.dir, GATE_DIRNAME)), 'never a folder made');
  arm(p, 'journal');
  const long = 'x'.repeat(1000);
  r = bridge(p, { op: 'journal', facts: { lines: [
    { type: 'mod-start', claudeCode: '2.1.289', ok: true, min: '2.1.287', nested: { a: 1 }, list: [1], bad: Infinity, ts: 'forged' },
    { type: 'transition', outcome: 'pass' },
    { type: 'mod-hook-skipped', hook: 'agent.spawn', error: long },
    'not an object',
    null,
  ] } });
  assert.deepEqual(r.res, { ok: true, journaled: 2 });
  const lines = journal(p).filter((j) => MOD_JOURNAL_TYPES.includes(j.type));
  assert.equal(lines.length, 2);
  assert.deepEqual({ ...lines[0], ts: undefined }, { ts: undefined, type: 'mod-start', claudeCode: '2.1.289', ok: true, min: '2.1.287', bad: null, session: 't-sess', via: 'mod' });
  assert.notEqual(lines[0].ts, 'forged');
  assert.equal(lines[1].error.length, 300);
  assert.ok(!journal(p).some((j) => j.type === 'transition' && j.outcome === 'pass'), 'a type of the loop is never forged by the mod');
  // at most 20 lines per call
  r = bridge(p, { op: 'journal', facts: { lines: Array.from({ length: 50 }, () => ({ type: 'mod-hook-skipped', hook: 'tool.call' })) } });
  assert.equal(r.res.journaled, 20);
});

test('stop: the driver is journaled (mod-stop) beside a live state, never in a project without a loop', () => {
  const p = project();
  bridge(p, { op: 'stop' });
  assert.ok(!existsSync(join(p.dir, GATE_DIRNAME)));
  arm(p, 'driver');
  const r = bridge(p, { op: 'stop', event: { stop_hook_active: true } });
  assert.ok(r.res.decision.block, r.raw);
  const last = journal(p).filter((j) => j.type === 'mod-stop').pop();
  assert.deepEqual({ ...last, ts: undefined }, { ts: undefined, type: 'mod-stop', outcome: 'no-plan', block: true, session: 't-sess', active: true });
});

test('status shows the Claude Code version the mod started on, and a warning when it is not supported', () => {
  const p = project();
  arm(p, 'status mod');
  assert.ok(!cli(p, 'status').out.includes('mod:'), 'no mod start, no line');
  bridge(p, { op: 'journal', facts: { lines: [{ type: 'mod-start', claudeCode: '2.1.289', ok: true, min: '2.1.287' }] } });
  let out = cli(p, 'status').out;
  assert.ok(out.includes('  mod:         driven by the perseveranza mod on Claude Code 2.1.289'), out);
  bridge(p, { op: 'journal', facts: { lines: [{ type: 'mod-start', claudeCode: '2.1.200', ok: false, min: '2.1.287', problem: 'older than the first version with mods' }] } });
  out = cli(p, 'status').out;
  assert.ok(out.includes('  mod:         WARNING: Claude Code 2.1.200 (the mod needs 2.1.287 or later): older than the first version with mods'), out);
  assert.deepEqual(lastModStart(gate(p, '')), { claudeCode: '2.1.200', ok: false, min: '2.1.287', problem: 'older than the first version with mods' });
  assert.equal(modLine(null), '');
});

test('journal: only the owner\'s session writes in its run\'s journal; a line written while the owner cannot be read is labelled', () => {
  const p = project();
  arm(p, 'owner journal');
  bridge(p, { op: 'stop' });
  assert.equal(readState(p).owner.sessionId, 't-sess');
  let r = bridge(p, { op: 'journal', event: { session_id: 'intruder' }, facts: { lines: [{ type: 'mod-start', claudeCode: '9.9.9', ok: false }] } });
  assert.deepEqual(r.res, { ok: true, journaled: 0, outcome: 'foreign-session' });
  assert.ok(!journal(p).some((j) => j.type === 'mod-start'), 'a foreign mod-start is never journaled');
  r = bridge(p, { op: 'journal', facts: { lines: [{ type: 'mod-start', claudeCode: '2.1.289', ok: true, min: '2.1.287', session: 'forged' }] } });
  assert.equal(r.res.journaled, 1);
  assert.equal(journal(p).filter((j) => j.type === 'mod-start').pop().session, 't-sess', 'the session is the request\'s, never the line\'s');
  // the state cannot be read: whose run it is cannot be told
  const good = readState(p);
  writeState(p, 'not a state');
  r = bridge(p, { op: 'journal', event: { session_id: 'intruder' }, facts: { lines: [{ type: 'mod-start', claudeCode: '9.9.9', ok: false }] } });
  assert.equal(r.res.journaled, 1);
  const labelled = journal(p).filter((j) => j.type === 'mod-start').pop();
  assert.equal(labelled.ownerUnknown, true);
  assert.equal(labelled.session, 'intruder');
  writeState(p, good);
  // status reads the owner's line, never the labelled one nor another session's
  assert.deepEqual(lastModStart(gate(p, ''), 't-sess'), { claudeCode: '2.1.289', ok: true, min: '2.1.287', problem: '' });
  assert.ok(cli(p, 'status').out.includes('Claude Code 2.1.289'));
  writeFileSync(gate(p, 'journal.jsonl'), `${JSON.stringify({ ts: 'x', type: 'mod-start', claudeCode: '8.8.8', ok: true, session: 'other123', via: 'mod' })}\n`, { flag: 'a' });
  assert.equal(lastModStart(gate(p, ''), 't-sess').claudeCode, '2.1.289');
  // an unclaimed run takes any (but never a labelled one)
  assert.equal(lastModStart(gate(p, ''), '').claudeCode, '8.8.8');
});

test('mod-fault.json: status shows it, the watchdog names it, the next stop journals and removes it, arm clears a leftover one', () => {
  const p = project();
  arm(p, 'fault');
  writePlan(p, '- [ ] one\n');
  bridge(p, { op: 'stop' });
  const fault = { at: Date.now() - 120000, hook: 'classic.Stop', error: 'no answer from the bridge: spawn node ENOENT', session: 't-sess', stopHookActive: true, recovery: false };
  writeFileSync(gate(p, MOD_FAULT_FILE), JSON.stringify(fault));
  assert.deepEqual(readModFault(gate(p, '')), fault);
  const text = modFaultText(fault, fault.at + 120000);
  assert.ok(text.includes("the mod's classic.Stop hook could not reach its helper 2"), text);
  assert.ok(text.includes('spawn node ENOENT') && text.includes('the session was let stop'), text);
  let out = cli(p, 'status').out;
  assert.ok(out.includes('  mod fault:   the mod\'s classic.Stop hook could not reach its helper'), out);
  const s = readState(p);
  const alert = alertText({ state: s, silentMs: 3600000, via: 'fire', seenAt: Date.now() - 3600000, activity: null }, gate(p, ''));
  assert.ok(alert.includes('Note: the mod\'s classic.Stop hook could not reach its helper'), alert);
  // the next stop that reaches the bridge: journaled, removed
  bridge(p, { op: 'stop', event: { stop_hook_active: true } });
  assert.ok(!existsSync(gate(p, MOD_FAULT_FILE)));
  const j = journal(p).filter((e) => e.type === 'mod-fault');
  assert.equal(j.length, 1);
  assert.equal(j[0].error, fault.error);
  assert.equal(j[0].recovery, false);
  assert.ok(formatEntry(j[0]).includes('MOD FAULT: classic.Stop could not reach its helper'), formatEntry(j[0]));
  out = cli(p, 'status').out;
  assert.ok(!out.includes('mod fault:'), out);
  assert.ok(!alertText({ state: s, silentMs: 1, via: 'fire', seenAt: Date.now(), activity: null }, gate(p, '')).includes('Note:'));
  // nothing to take: nothing journaled
  assert.equal(takeModFault(gate(p, '')), null);
  // a marker that cannot be read is still a fact
  writeFileSync(gate(p, MOD_FAULT_FILE), '{torn');
  assert.deepEqual(readModFault(gate(p, '')), { unreadable: true });
  assert.ok(cli(p, 'status').out.includes('cannot be read'));
  // a leftover marker, the run gone: status says it; arm reports it and clears it
  assert.equal(cli(p, 'disarm').code, 0);
  mkdirSync(gate(p, ''), { recursive: true });
  writeFileSync(gate(p, MOD_FAULT_FILE), JSON.stringify(fault));
  out = cli(p, 'status').out;
  assert.ok(out.includes('Mod fault left behind'), out);
  const armed = arm(p, 'after the fault');
  assert.ok(String(armed.out || '').includes('a previous run left a mod fault'), JSON.stringify(armed));
  assert.ok(!existsSync(gate(p, MOD_FAULT_FILE)));
  assert.ok(journal(p).some((e) => e.type === 'note' && e.text.startsWith('a previous run\'s mod fault was cleared')));
});

test('stop without a live state leaves a marker where it is (arm reports it)', () => {
  const p = project();
  arm(p, 'gone');
  assert.equal(cli(p, 'disarm').code, 0);
  mkdirSync(gate(p, ''), { recursive: true });
  writeFileSync(gate(p, MOD_FAULT_FILE), JSON.stringify({ at: 1, hook: 'classic.Stop', error: 'x' }));
  bridge(p, { op: 'stop' });
  assert.ok(existsSync(gate(p, MOD_FAULT_FILE)));
});
