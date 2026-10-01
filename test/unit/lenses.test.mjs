// The final verification by lenses: how the machine reads and combines the verdict files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeState, effectiveLenses, singleLens } from '../../src/core/state.mjs';
import { parseVerifyVerdict } from '../../src/core/verdicts.mjs';
import { templateLayer } from '../../src/core/prompts.mjs';
import { arrivedLenses } from '../../src/cli/verbs/status.mjs';
import { mk, run, journal } from '../helpers/core.mjs';

const PLAN_DONE = '- [x] step one\n- [x] step two\n';
const T = 1_700_000_000_000;
const THREE = ['correctness', 'security', 'tests'];
const ID = 'R1';
const CRIT = { pass: false, findings: [{ severity: 'critical', desc: 'secret in code', file: 'k.js:1' }] };
// a round requested at T with id R1: by lenses (default) or of the single verifier
const round = (over = {}) => mk({ phase: 'final-verify', verdictLenses: THREE, verdictRequestId: ID, verdictRequestedAt: T, counters: { iterations: 7 }, ...over });
const singleRound = (over = {}) => round({ verdictLenses: ['general'], counters: { iterations: 4 }, ...over });
const lens = (name, fields = {}) => JSON.stringify({ requestId: ID, lens: name, pass: true, findings: [], ...fields });
const main = (fields = {}) => JSON.stringify({ requestId: ID, pass: true, findings: [], ...fields });
const ALL = { correctness: lens('correctness'), security: lens('security'), tests: lens('tests') };
// one Stop of the final verification: { verify?, lenses?, verifyAt?, lensesAt?, overrides? }
const fire = (s, { verify, lenses = {}, verifyAt, lensesAt = {}, overrides } = {}, when = T + 60_000) => run(s, {
  planText: PLAN_DONE, ...(overrides ? { overrides } : {}),
  artifacts: { ...(verify != null ? { verify } : {}), verifyLenses: lenses },
  artifactAt: { ...(verifyAt ? { verify: verifyAt } : {}), verifyLenses: lensesAt },
}, { now: when });
const keeps = (r) => r.effects.filter((e) => e.type === 'keepArtifact').map((e) => `${e.name}->${e.as}`);
const merged = (r) => { const w = r.effects.find((e) => e.type === 'writeArtifact'); return w ? { name: w.name, doc: JSON.parse(w.content) } : null; };
const summary = (r) => journal(r).find((j) => j.type === 'lenses');

// ---------------------------------------------------------------- choosing and asking
test('lenses: automatic by complexity, explicit when armed, fixed when the round is requested', () => {
  assert.deepEqual(effectiveLenses(mk({ complexity: 'high' })), THREE);
  assert.deepEqual(effectiveLenses(mk({ complexity: 'medium' })), ['general']);
  assert.deepEqual(effectiveLenses(mk({ complexity: 'low' })), ['general']);
  assert.deepEqual(effectiveLenses(mk({ complexity: 'low', options: { verifiers: ['security', 'tests'] } })), ['security', 'tests']);
  assert.equal(singleLens(['general']), true);
  assert.equal(singleLens([]), true);
  assert.equal(singleLens(['security']), false, 'one lens other than general is a lens round');
  const high = run(mk({ phase: 'cleanup', complexity: 'high' }), {}, { now: T });
  assert.equal(high.state.phase, 'final-verify');
  assert.deepEqual(high.state.verdictLenses, THREE);
  const medium = run(mk({ phase: 'cleanup', complexity: 'medium' }), {}, { now: T });
  assert.deepEqual(medium.state.verdictLenses, ['general']);
  assert.ok(medium.reason.includes('.omc-loop/verify.json') && !medium.reason.includes('verify-general.json'), 'the single verifier, as before');
  const chosen = run(mk({ phase: 'cleanup', complexity: 'high', options: { verifiers: ['general'] } }), {}, { now: T });
  assert.deepEqual(chosen.state.verdictLenses, ['general']);
  assert.ok(chosen.reason.includes('security lens'), 'the single verifier keeps the security hint at high complexity');
  assert.deepEqual(run(mk({ phase: 'implement' }), {}, { now: T }).state.verdictLenses, []);
});

test('lenses: the prompt delegates one verifier per lens, in one message, with file, id and mandate', () => {
  const r = run(mk({ phase: 'cleanup', complexity: 'high' }), {}, { now: T });
  const id = r.state.verdictRequestId;
  assert.ok(r.reason.includes('In ONE message and in the FOREGROUND'), r.reason);
  for (const l of THREE) assert.ok(r.reason.includes(`[lens ${l}: writes .omc-loop/verify-${l}.json with requestId ${id}`), `${l}: ${r.reason}`);
  assert.ok(r.reason.includes('regressions introduced by the fixes'));
  assert.ok(r.reason.includes('path traversal'));
  assert.ok(r.reason.includes('comments and documentation claim is true'));
  assert.ok(!r.reason.includes('Include a security lens'), 'the security lens replaces the hint');
  assert.equal(journal(r).find((j) => j.type === 'transition').prompt, 'final-verify-lenses');
  const noSec = run(mk({ phase: 'cleanup', complexity: 'high', options: { verifiers: ['correctness', 'tests'] } }), {}, { now: T });
  assert.ok(noSec.reason.includes('Include a security lens'), noSec.reason);
});

test('lenses: a pack that customises only the single-verifier prompt keeps its wording', () => {
  const custom = [{ 'final-verify': 'MY VERIFY {{verdictRequestId}}', 'verify-missing-outcome': 'MY MISSING {{verdictRequestId}}' }];
  assert.equal(templateLayer('final-verify', custom), 0);
  assert.equal(templateLayer('final-verify-lenses', custom), 1);
  assert.equal(templateLayer('nope', custom), Infinity);
  const r = run(mk({ phase: 'cleanup', complexity: 'high' }), { overrides: custom }, { now: T });
  assert.deepEqual(r.state.verdictLenses, THREE);
  assert.ok(r.reason.endsWith(`MY VERIFY ${r.state.verdictRequestId}`), r.reason);
  assert.ok(fire(round(), { overrides: custom }).reason.endsWith('MY MISSING R1'));
  const both = run(mk({ phase: 'cleanup', complexity: 'high' }), { overrides: [{ ...custom[0], 'final-verify-lenses': 'LENSES{{lensList}}' }] }, { now: T });
  assert.ok(both.reason.includes('LENSES [lens correctness'), both.reason);
});

// ---------------------------------------------------------------- the rules
test('rule 1: every lens wrote, none blocks -> pass; each file kept, findings merged with lens and origin', () => {
  const r = fire(round(), { lenses: { ...ALL, security: lens('security', { findings: [{ severity: 'warning', desc: 'w', file: 'a.js:1' }] }) } });
  assert.equal(r.outcome, 'pass');
  assert.ok(r.types.includes('gitFinish'));
  assert.deepEqual(keeps(r).sort(), ['verify-correctness.json->verify-correctness-7.json', 'verify-security.json->verify-security-7.json', 'verify-tests.json->verify-tests-7.json']);
  const m = merged(r);
  assert.equal(m.name, 'verify-7.json');
  assert.equal(m.doc.pass, true);
  assert.deepEqual(m.doc.blockedBy, []);
  assert.deepEqual(m.doc.findings, [{ severity: 'warning', desc: 'w', file: 'a.js:1', lens: 'security', from: 'verify-security.json' }]);
  assert.deepEqual(m.doc.lenses.missing, []);
  const sum = summary(r);
  assert.deepEqual([sum.result, sum.arrived, sum.missing], ['pass', THREE, []]);
  assert.deepEqual(r.state.priorVerifies, [], 'a pass leaves nothing to recheck');
  assert.ok(r.types.indexOf('writeArtifact') < r.types.indexOf('saveState'));
});

test('rule 1: stale files are set aside at once and never read; the lens has no file', () => {
  const other = fire(round(), { lenses: { ...ALL, security: lens('security', { ...CRIT, requestId: 'R0' }) }, lensesAt: { security: T + 30_000 } });
  assert.equal(other.outcome, 'missing', 'another request: not read, critical or not');
  assert.ok(keeps(other).includes('verify-security.json->verify-security-stale-7.json'));
  const st = journal(other).find((j) => j.type === 'verdict' && j.stale);
  assert.deepEqual([st.lens, st.staleBy, st.requestId, st.expectedRequestId], ['security', 'requestId', 'R0', ID]);
  assert.deepEqual(summary(other).stale, ['verify-security.json']);
  assert.ok(other.reason.includes('lens(es) security are missing'));
  // no id: dated by the clock
  const noId = JSON.stringify({ pass: true });
  assert.equal(fire(round(), { lenses: { ...ALL, security: noId }, lensesAt: { security: T - 5000 } }).outcome, 'missing');
  assert.equal(fire(round(), { lenses: { ...ALL, security: noId }, lensesAt: { security: T + 10 } }).outcome, 'pass');
  // the id copied with quotes or a period is the same id
  assert.equal(fire(round(), { lenses: { ...ALL, correctness: lens('correctness', { requestId: '"R1".' }) } }).outcome, 'pass');
  // a stale verify.json is no verdict either
  const sv = fire(round(), { verify: main({ requestId: 'R0' }) });
  assert.equal(sv.outcome, 'missing');
  assert.ok(keeps(sv).includes('verify.json->verify-stale-7.json'));
});

test('rule 2: a critical in one lens rejects at once, even with lenses missing; the fix reads one file', () => {
  const r = fire(round(), { lenses: { ...ALL, security: lens('security', CRIT), tests: lens('tests', { findings: [{ severity: 'warning', desc: 'untested' }] }) } });
  assert.equal(r.outcome, 'fail');
  assert.equal(r.state.phase, 'implement');
  assert.equal(r.state.counters.finalFails, 1);
  assert.ok(r.reason.includes('.omc-loop/verify-7.json'), r.reason);
  const m = merged(r);
  assert.equal(m.doc.pass, false);
  assert.deepEqual(m.doc.blockedBy, ['verify-security.json']);
  assert.deepEqual(m.doc.findings.map((f) => `${f.lens}:${f.severity}:${f.from}`), ['security:critical:verify-security.json', 'tests:warning:verify-tests.json']);
  assert.deepEqual(summary(r).blockedBy, ['verify-security.json']);
  assert.deepEqual(r.state.priorVerifies, ['verify-7.json']);
  const early = fire(round(), { lenses: { security: lens('security', CRIT) } });
  assert.equal(early.outcome, 'fail');
  assert.deepEqual(merged(early).doc.lenses.missing, ['correctness', 'tests']);
  // pass:true with a critical is a critical
  assert.equal(fire(round(), { lenses: { ...ALL, correctness: lens('correctness', { pass: true, findings: [{ severity: 'blocker', desc: 'x' }] }) } }).outcome, 'fail');
});

test('rule 2: a lens with pass:false over plain warnings is a pass with warnings, never listed as such when it blocks', () => {
  const r = fire(round(), { lenses: { ...ALL, correctness: lens('correctness', { pass: false, findings: [{ severity: 'warning', desc: 'naming' }] }) } });
  assert.equal(r.outcome, 'pass');
  const v = journal(r).find((j) => j.type === 'verdict' && j.lens === 'correctness');
  assert.deepEqual([v.pass, v.declaredPass], [true, false]);
  assert.ok(v.notes.some((n) => n.includes('read as a pass with warnings')));
  assert.deepEqual(summary(r).softFails, ['verify-correctness.json']);
  // the single verifier keeps its rule (decision 6.2 deferred)
  assert.equal(run(mk({ phase: 'final-verify' }), { artifacts: { verify: '{"pass":false,"findings":[{"severity":"warning","desc":"w"}]}' } }).outcome, 'fail');
  // the file that blocks is never among the soft fails
  const b = fire(round(), { lenses: { ...ALL, security: lens('security', { pass: false, findings: [{ severity: 'high', desc: 'x' }] }) } });
  assert.equal(b.outcome, 'fail');
  assert.deepEqual(summary(b).softFails, []);
  assert.ok(!journal(b).find((j) => j.type === 'verdict' && j.lens === 'security').notes.some((n) => n.includes('read as a pass')));
});

test('rule 2: a lens that rejects over findings it marked high/major blocks; plain or weaker ones do not', () => {
  const high = { pass: false, findings: [{ severity: 'high', desc: 'token logged' }] };
  assert.equal(run(mk({ phase: 'final-verify' }), { artifacts: { verify: JSON.stringify(high) } }).outcome, 'fail');
  const r = fire(round(), { lenses: { ...ALL, security: lens('security', high) } });
  assert.equal(r.outcome, 'fail', 'the same verdict, the same outcome');
  assert.ok(journal(r).find((j) => j.type === 'verdict' && j.lens === 'security').notes.some((n) => n.includes('marked high/major')));
  for (const sev of ['major', 'grave', 'alta', 'alto', 'maggiore']) {
    assert.equal(fire(round(), { lenses: { ...ALL, security: lens('security', { pass: false, findings: [{ severity: sev, desc: 'x' }] }) } }).outcome, 'fail', sev);
  }
  assert.equal(fire(round(), { lenses: { ...ALL, security: lens('security', { pass: true, findings: [{ severity: 'high', desc: 'x' }] }) } }).outcome, 'pass', 'high is not critical');
  for (const sev of ['warning', 'suggestion', 'medium', 'low']) {
    assert.equal(fire(round(), { lenses: { ...ALL, security: lens('security', { pass: false, findings: [{ severity: sev, desc: 'x' }] }) } }).outcome, 'pass', sev);
  }
  assert.equal(parseVerifyVerdict(JSON.stringify(high)).strongWarnings, 1);
});

test('rule 3: an unreadable lens file is covered by nobody, not even a passing verify.json', () => {
  // a malformed lens file (it had a critical in it) beside verify.json pass: still missing
  const broken = '{"requestId":"R1","lens":"tests","pass":false,"findings":[{"severity":"critical","desc":"x"}';
  const r = fire(round(), { verify: main(), lenses: { correctness: lens('correctness'), security: lens('security'), tests: broken } });
  assert.equal(r.outcome, 'missing');
  assert.ok(r.reason.includes('lens(es) tests are missing'), r.reason);
  assert.deepEqual(keeps(r), [], 'nothing moved while the round is open: the broken file stays unreadable on disk');
  assert.deepEqual(summary(r).invalid, ['verify-tests.json']);
  // the next stop, the same files: a rejection (missing twice), the broken file kept as invalid
  const r2 = fire(r.state, { verify: main(), lenses: { correctness: lens('correctness'), security: lens('security'), tests: broken } }, T + 120_000);
  assert.equal(r2.outcome, 'missing-twice');
  assert.ok(keeps(r2).includes(`verify-tests.json->verify-tests-invalid-${r.state.counters.iterations}.json`));
  assert.equal(merged(r2).doc.pass, false);
  // a rewritten, valid file: the round completes
  const fixed = fire(r.state, { verify: main(), lenses: { ...ALL } }, T + 120_000);
  assert.equal(fixed.outcome, 'pass');
});

test('rule 3: a partial round asks only the missing lenses; the files stay valid for the same request', () => {
  const r = fire(round(), { lenses: { correctness: lens('correctness'), tests: lens('tests') } });
  assert.equal(r.outcome, 'missing');
  assert.equal(r.state.verdictRequestId, ID);
  assert.deepEqual(keeps(r), []);
  assert.equal(merged(r), null);
  assert.ok(r.reason.includes('lens(es) security are missing') && r.reason.includes('[lens security: writes .omc-loop/verify-security.json with requestId R1'), r.reason);
  assert.ok(!r.reason.includes('[lens correctness') && !r.reason.includes('[lens tests'));
  assert.equal(journal(r).find((j) => j.type === 'transition').prompt, 'verify-missing-lenses');
  assert.deepEqual([summary(r).result, summary(r).arrived, summary(r).missing], ['partial', ['correctness', 'tests'], ['security']]);
  const r2 = fire(r.state, { lenses: ALL }, T + 120_000);
  assert.equal(r2.outcome, 'pass');
  assert.equal(merged(r2).name, `verify-${r.state.counters.iterations}.json`);
});

test('rule 3: missing twice is a rejection; what arrived is kept, merged and rechecked next', () => {
  const files = { lenses: { correctness: lens('correctness', { findings: [{ severity: 'warning', desc: 'edge' }] }) } };
  const r = fire(round(), files);
  const r2 = fire(r.state, files, T + 120_000);
  assert.equal(r2.outcome, 'missing-twice');
  assert.equal(r2.state.counters.finalFails, 1);
  const n = r.state.counters.iterations;
  assert.deepEqual(keeps(r2), [`verify-correctness.json->verify-correctness-${n}.json`]);
  const m = merged(r2);
  assert.deepEqual([m.doc.result, m.doc.pass, m.doc.lenses.missing], ['missing-twice', false, ['security', 'tests']]);
  assert.ok(r2.reason.includes(`.omc-loop/verify-${n}.json`), r2.reason);
  assert.deepEqual(r2.state.priorVerifies, [`verify-${n}.json`]);
  const none = fire(round({ flags: { repeated: true } }));
  assert.equal(none.outcome, 'missing-twice');
  assert.equal(merged(none), null);
});

test('rule 4: verify.json covers the lenses with no file, and means the same whatever else arrived', () => {
  // alone: it covers the whole round (lens-fallback)
  const alone = fire(round(), { verify: main() });
  assert.equal(alone.outcome, 'pass');
  assert.ok(keeps(alone).includes('verify.json->verify-main-7.json'));
  assert.deepEqual(merged(alone).doc.lenses.covered, { correctness: 'verify.json', security: 'verify.json', tests: 'verify.json' });
  assert.deepEqual(journal(alone).find((j) => j.type === 'lens-fallback').covers, THREE);
  // beside a partial set: it covers only the lenses without a file
  const part = fire(round(), { verify: main({ findings: [{ severity: 'warning', desc: 'w' }] }), lenses: { correctness: lens('correctness') } });
  assert.equal(part.outcome, 'pass');
  assert.deepEqual(merged(part).doc.lenses.covered, { correctness: 'verify-correctness.json', security: 'verify.json', tests: 'verify.json' });
  assert.deepEqual(merged(part).doc.findings, [{ severity: 'warning', desc: 'w', file: null, lens: 'general', from: 'verify.json' }]);
  // pass:false (the single verifier's rule) rejects: alone, beside a partial set, beside all of them
  const reject = main({ pass: false, findings: [{ severity: 'warning', desc: 'w' }] });
  for (const lenses of [{}, { correctness: lens('correctness') }, ALL]) {
    const r = fire(round(), { verify: reject, lenses });
    assert.equal(r.outcome, 'fail', `with ${Object.keys(lenses).join(',') || 'no lens'}`);
    assert.deepEqual(merged(r).doc.blockedBy, ['verify.json']);
    assert.ok(!keeps(r).some((k) => k.includes('unexpected')), 'never set aside while valid');
  }
  // a critical in verify.json beside every lens passing: rejected, in one stop or two
  assert.equal(fire(round(), { verify: main(CRIT), lenses: ALL }).outcome, 'fail');
  const first = fire(round(), { lenses: { correctness: lens('correctness'), security: lens('security') } });
  assert.equal(first.outcome, 'missing');
  const second = fire(first.state, { verify: main(CRIT), lenses: ALL }, T + 120_000);
  assert.equal(second.outcome, 'fail');
  // id-less, written after the request: of this round
  assert.equal(fire(round(), { verify: JSON.stringify(CRIT), verifyAt: T + 10, lenses: ALL }).outcome, 'fail');
  // the pack that asks the missing lens for verify.json: no missing-twice, the file kept
  const custom = [{ 'verify-missing-outcome': 'MY MISSING: write verify.json with {{verdictRequestId}}' }];
  const ask = fire(round(), { overrides: custom, lenses: { correctness: lens('correctness') } });
  assert.equal(ask.outcome, 'missing');
  assert.ok(ask.reason.endsWith('MY MISSING: write verify.json with R1'));
  const answered = fire(ask.state, { overrides: custom, verify: main(), lenses: { correctness: lens('correctness') } }, T + 120_000);
  assert.equal(answered.outcome, 'pass');
  assert.equal(answered.state.counters.finalFails, 0);
  assert.ok(keeps(answered).includes(`verify.json->verify-main-${ask.state.counters.iterations}.json`));
});

test('rule 5: in a round of the single verifier, verify-general.json is that verifier\'s file', () => {
  const r = fire(singleRound(), { lenses: { general: main() } });
  assert.equal(r.outcome, 'pass');
  assert.ok(!keeps(r).some((k) => k.includes('unexpected')));
  assert.deepEqual(merged(r).doc.lenses.covered, { general: 'verify-general.json' });
  // by the single verifier's rule: pass:false rejects
  assert.equal(fire(singleRound(), { lenses: { general: main({ pass: false }) } }).outcome, 'fail');
  // the single verifier with nothing but verify.json: exactly as before the lenses
  const before = fire(singleRound(), { verify: main() });
  assert.equal(before.outcome, 'pass');
  assert.deepEqual(keeps(before), ['verify.json->verify-4.json']);
  assert.equal(merged(before), null);
});

test('rule 6: a lens nobody asked for blocks if it blocks, otherwise it is only noted and covers nothing', () => {
  // three-lens round: verify-general.json with a critical rejects it
  const g = fire(round(), { lenses: { ...ALL, general: lens('general', CRIT) } });
  assert.equal(g.outcome, 'fail');
  assert.deepEqual(merged(g).doc.blockedBy, ['verify-general.json']);
  assert.equal(merged(g).doc.findings[0].from, 'verify-general.json');
  // two-lens round: verify-tests.json with a critical rejects it
  const t = fire(round({ verdictLenses: ['correctness', 'security'] }), { lenses: { ...ALL, tests: lens('tests', CRIT) } });
  assert.equal(t.outcome, 'fail');
  // single round: verify.json passed, verify-security.json of this round with a critical rejects it
  const s1 = fire(singleRound(), { verify: main(), lenses: { security: lens('security', CRIT) } });
  assert.equal(s1.outcome, 'fail');
  assert.equal(s1.state.counters.finalFails, 1);
  assert.ok(keeps(s1).includes('verify.json->verify-main-4.json') && keeps(s1).includes('verify-security.json->verify-security-4.json'));
  assert.deepEqual(merged(s1).doc.blockedBy, ['verify-security.json']);
  assert.ok(s1.reason.includes('.omc-loop/verify-4.json'), s1.reason);
  assert.equal(fire(singleRound(), { lenses: { security: lens('security', CRIT) } }).outcome, 'fail', 'with verify.json not there yet');
  // without a block: only noted, the round decides on what it asked for
  const quiet = fire(round({ verdictLenses: ['correctness', 'security'] }), { lenses: { ...ALL, tests: lens('tests', { pass: false, findings: [{ severity: 'warning', desc: 'w' }] }) } });
  assert.equal(quiet.outcome, 'pass');
  assert.deepEqual(summary(quiet).unexpected, ['verify-tests.json']);
  assert.ok(journal(quiet).some((j) => j.type === 'verdict' && j.unexpected && j.lens === 'tests'));
  // it covers nothing: a missing lens stays missing
  assert.equal(fire(round({ verdictLenses: ['correctness', 'security'] }), { lenses: { correctness: lens('correctness'), tests: lens('tests') } }).outcome, 'missing');
  const sq = fire(singleRound(), { verify: main(), lenses: { security: lens('security') } });
  assert.equal(sq.outcome, 'pass');
  // an unexpected file of another request is not of this round
  assert.equal(fire(round({ verdictLenses: ['correctness', 'security'] }), { lenses: { ...ALL, tests: lens('tests', { ...CRIT, requestId: 'R0' }) } }).outcome, 'pass');
});

test('rule 7: report pass covers no missing lens; report fail rejects; the single verifier as before', () => {
  const pass = fire(round({ signals: { lastReport: 'pass' } }), { lenses: { correctness: lens('correctness') } });
  assert.equal(pass.outcome, 'missing', 'a self-declared pass is no proof for a lens');
  assert.ok(journal(pass).some((j) => j.type === 'note' && j.text.includes('report pass ignored')));
  assert.equal(fire(round({ signals: { lastReport: 'pass' } })).outcome, 'missing');
  const fail = fire(round({ signals: { lastReport: 'fail' } }), { lenses: { correctness: lens('correctness') } });
  assert.equal(fail.outcome, 'fail');
  assert.deepEqual([merged(fail).doc.result, merged(fail).doc.pass], ['report-fail', false]);
  // the single verifier: the verb counts (no file), as before the lenses
  assert.equal(fire(singleRound({ signals: { lastReport: 'pass' } })).outcome, 'pass');
  const sp = fire(singleRound({ signals: { lastReport: 'pass' } }), { lenses: { security: lens('security') } });
  assert.equal(sp.outcome, 'pass');
  assert.deepEqual([merged(sp).doc.result, merged(sp).doc.pass], ['report-pass', true], 'the merged file says what the loop did');
  // ...but not over its own unreadable file
  assert.equal(fire(singleRound({ signals: { lastReport: 'pass' } }), { lenses: { general: '{broken', security: lens('security') } }).outcome, 'missing');
});

test('rule 8: lens field, journal and merged file agree with the outcome', () => {
  const mis = fire(round(), { lenses: { ...ALL, correctness: lens('security') } });
  assert.equal(mis.outcome, 'pass');
  assert.ok(journal(mis).find((j) => j.type === 'verdict' && j.lens === 'correctness').notes.some((n) => n.includes('declares lens "security"')));
  assert.equal(parseVerifyVerdict(lens('Tests')).lens, 'tests');
  const f = fire(round(), { verify: main({ pass: false, findings: [{ severity: 'warning', desc: 'v' }] }), lenses: { ...ALL, tests: lens('tests', { pass: false, findings: [{ severity: 'warning', desc: 't' }] }) } });
  assert.equal(f.outcome, 'fail');
  const m = merged(f).doc;
  assert.equal(m.pass, false);
  assert.deepEqual(m.blockedBy, ['verify.json']);
  assert.ok(m.findings.every((x) => x.from && x.lens));
  assert.deepEqual(summary(f).softFails, ['verify-tests.json'], 'the soft fail is the lens, not the file that blocked');
  assert.deepEqual(summary(f).blockedBy, ['verify.json']);
});

// ---------------------------------------------------------------- memory, state, status
test('antifragile: the rejected rounds are rechecked by the next one (last three)', () => {
  const s = mk({ phase: 'final-verify', flags: { cleanedOnce: true }, signals: { claimedDone: true }, verdictRequestId: 'R1', counters: { iterations: 9 }, priorVerifies: ['verify-2.json', 'verify-4.json', 'verify-6.json'] });
  const r = run(s, { planText: PLAN_DONE, artifacts: { verify: '{"requestId":"R1","pass":false,"findings":[{"severity":"critical","desc":"x"}]}' } }, { now: T });
  assert.equal(r.outcome, 'claim-again');
  assert.deepEqual(r.state.priorVerifies, ['verify-4.json', 'verify-6.json', 'verify-9.json']);
  assert.ok(r.reason.includes('Earlier rounds of this verification rejected the work: their findings are in .omc-loop/verify-4.json, .omc-loop/verify-6.json, .omc-loop/verify-9.json'), r.reason);
  const lensed = run(mk({ phase: 'cleanup', complexity: 'high', priorVerifies: ['verify-3.json'] }), {}, { now: T });
  assert.ok(lensed.reason.includes('their findings are in .omc-loop/verify-3.json') && lensed.reason.includes('introduced no regression'), lensed.reason);
  assert.ok(!run(mk({ phase: 'cleanup' }), {}, { now: T }).reason.includes('Earlier rounds'));
  assert.deepEqual(run(mk({ phase: 'final-verify' }), { artifacts: { verify: '{"pass":true}' } }).state.priorVerifies, []);
});

test('lens state is normalised: unknown lenses dropped, memory capped and sane', () => {
  const s = normalizeState({ phase: 'final-verify', options: { verifiers: ['Security', 'bogus', 'security', 'tests'] }, verdictLenses: ['tests', 'nope'], priorVerifies: ['verify-1.json', '../etc/passwd', 'verify-2.json', 'verify-3.json', 'verify-4.json', 7] });
  assert.deepEqual(s.options.verifiers, ['security', 'tests']);
  assert.deepEqual(s.verdictLenses, ['tests']);
  assert.deepEqual(s.priorVerifies, ['verify-2.json', 'verify-3.json', 'verify-4.json']);
  const empty = normalizeState({ phase: 'plan', options: { verifiers: ['bogus'] }, verdictLenses: 'x', priorVerifies: null });
  assert.equal(empty.options.verifiers, null);
  assert.deepEqual(empty.verdictLenses, []);
  assert.deepEqual(empty.priorVerifies, []);
  const legacy = run(normalizeState({ phase: 'final-verify', complexity: 'high' }), { artifacts: { verify: '{"pass":true}' } });
  assert.equal(legacy.outcome, 'pass');
});

test('status counts an id-less lens file by the hook\'s rule: written before the request, it has not arrived', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prs-lens-status-'));
  try {
    const now = Date.now();
    const s = { verdictLenses: THREE, verdictRequestId: ID, verdictRequestedAt: now };
    const at = (name, ms) => utimesSync(join(dir, name), ms / 1000, ms / 1000);
    writeFileSync(join(dir, 'verify-correctness.json'), JSON.stringify({ pass: true }));
    at('verify-correctness.json', now - 60_000);
    writeFileSync(join(dir, 'verify-security.json'), JSON.stringify({ pass: true }));
    at('verify-security.json', now + 5000);
    writeFileSync(join(dir, 'verify-tests.json'), JSON.stringify({ requestId: 'R0', pass: true }));
    assert.deepEqual(arrivedLenses(dir, s), ['security']);
    writeFileSync(join(dir, 'verify-tests.json'), JSON.stringify({ requestId: `"${ID}".`, pass: true }));
    at('verify-tests.json', now - 60_000);
    assert.deepEqual(arrivedLenses(dir, s), ['security', 'tests'], 'the right id counts whatever the clock');
    at('verify-correctness.json', now - 500);
    assert.deepEqual(arrivedLenses(dir, s), ['correctness', 'security', 'tests'], 'within the second of tolerance');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
