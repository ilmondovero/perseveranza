// The internal advisor: a consultative second opinion at the plan and from the 2nd fix.
// It never routes: these tests check what the prompts say and what the journal records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mk, run, journal } from '../helpers/core.mjs';
import { normalizeState, loadState, defaultState, DEFAULT_ADVISOR_MODEL } from '../../src/core/state.mjs';
import { DEFAULT_PROMPTS, PROMPT_VARS, validatePack } from '../../src/core/prompts.mjs';
import { TRANSITIONS } from '../../src/core/transitions.mjs';
import { formatEntry } from '../../src/shell/journal.mjs';
import { summary } from '../../src/cli/verbs/status.mjs';
import { ROOT } from '../../src/shell/paths.mjs';

const REJECT_REVIEW = { artifacts: { review: '{"blocking":1,"findings":[{"severity":"critical","desc":"wrong"}]}' } };
const REJECT_VERIFY = { artifacts: { verify: '{"pass":false,"findings":[{"severity":"critical","desc":"broken"}]}' } };
const FALLBACK = 'If no external model gives a usable answer';
const advisorEntries = (r) => journal(r).filter((e) => e.type === 'advisor-hint');
const opts = (externals, advisor, advisorModel = 'sonnet') => ({ externals: externals ? ['codex'] : [], advisor, advisorModel });

test('fix after a review: every combination of externals x advisor x attempt', () => {
  for (const externals of [false, true]) {
    for (const advisor of [true, false]) {
      for (const attempt of [1, 2, 3]) {
        const label = `externals=${externals} advisor=${advisor} attempt=${attempt}`;
        const r = run(mk({ phase: 'review', counters: { retries: attempt - 1 }, options: opts(externals, advisor) }), REJECT_REVIEW);
        assert.equal(r.outcome, 'fail', label);
        assert.equal(r.state.phase, 'implement', `${label}: the advisor never routes`);
        assert.ok(r.reason.includes(`attempt ${attempt}/3`), label);
        assert.ok(!r.reason.includes('{{'), `${label}: no literal placeholder`);
        const again = attempt >= 2;
        assert.equal(r.reason.includes('external-fix'), again && externals, `${label}: external diagnosis as before`);
        assert.equal(r.reason.includes('advisor-fix-'), again && advisor, `${label}: advisor hint`);
        assert.equal(r.reason.includes(FALLBACK), again && advisor && externals, `${label}: fallback clause only beside externals`);
        const entries = advisorEntries(r);
        if (!again) { assert.deepEqual(entries, [], label); continue; }
        assert.equal(entries.length, 1, label);
        assert.equal(entries[0].slot, 'fix');
        assert.equal(entries[0].reason, !advisor ? 'off' : externals ? 'fallback' : 'no-external', label);
        if (advisor) {
          assert.equal(entries[0].model, 'sonnet');
          assert.ok(r.reason.includes('model=sonnet'), `${label}: the chosen model`);
          assert.ok(r.reason.includes('pf-advisor'), label);
          assert.ok(r.reason.includes('is NOT a finding and does NOT block'), label);
          assert.ok(r.reason.includes('.perseveranza/notes.md'), label);
          assert.ok(r.reason.includes('ill-posed'), `${label}: the plan can be the problem`);
        } else assert.equal(entries[0].model, undefined);
      }
    }
  }
});

test('fix after the final verification: every combination of externals x advisor x rejection', () => {
  for (const externals of [false, true]) {
    for (const advisor of [true, false]) {
      for (const rejection of [1, 2]) {
        const label = `externals=${externals} advisor=${advisor} rejection=${rejection}`;
        const r = run(mk({ phase: 'final-verify', counters: { finalFails: rejection - 1, iterations: 12 }, options: opts(externals, advisor, 'opus') }), REJECT_VERIFY);
        assert.equal(r.outcome, 'fail', label);
        assert.equal(r.state.phase, 'implement', label);
        assert.ok(r.reason.includes(`rejection ${rejection}/3`), label);
        assert.ok(!r.reason.includes('{{'), `${label}: no literal placeholder`);
        const again = rejection >= 2;
        assert.equal(r.reason.includes('external-fix'), again && externals, `${label}: external diagnosis from the 2nd rejection`);
        assert.equal(r.reason.includes('advisor-fix-13.md'), again && advisor, `${label}: advisor hint, named after the iteration`);
        assert.equal(r.reason.includes(FALLBACK), again && advisor && externals, label);
        const entries = advisorEntries(r);
        assert.equal(entries.length, again ? 1 : 0, label);
        if (again) {
          assert.equal(entries[0].slot, 'verify-fix');
          assert.equal(entries[0].reason, !advisor ? 'off' : externals ? 'fallback' : 'no-external', label);
        }
        if (again && advisor) {
          assert.ok(r.reason.includes('model=opus'), label);
          assert.ok(r.reason.includes('.perseveranza/verify-12.json'), `${label}: the rejected rounds are passed to the advisor`);
        }
      }
    }
  }
});

test('plan: the advisor critiques the plan, as fallback beside externals, nothing when off', () => {
  for (const externals of [false, true]) {
    for (const advisor of [true, false]) {
      const label = `externals=${externals} advisor=${advisor}`;
      const r = run(mk({ phase: 'plan', options: opts(externals, advisor, 'haiku') }));
      assert.equal(r.outcome, 'no-plan', label);
      assert.ok(!r.reason.includes('{{'), label);
      assert.equal(r.reason.includes('external-plan'), externals, `${label}: external critique unchanged`);
      assert.equal(r.reason.includes('advisor-plan-1.md'), advisor, label);
      assert.equal(r.reason.includes('model=haiku'), advisor, label);
      assert.equal(r.reason.includes(FALLBACK), advisor && externals, label);
      const entries = advisorEntries(r);
      assert.equal(entries.length, 1, label);
      assert.equal(entries[0].slot, 'plan');
      assert.equal(entries[0].reason, !advisor ? 'off' : externals ? 'fallback' : 'no-external', label);
    }
  }
  // the transitions that do not consult the advisor render no placeholder of it
  const ready = run(mk({ phase: 'plan' }), { planExists: true, planText: '- [ ] a\n' });
  assert.equal(ready.outcome, 'ready');
  assert.ok(!ready.reason.includes('advisor') && !ready.reason.includes('{{'));
  assert.deepEqual(advisorEntries(ready), []);
});

test('the advisor of the fix reads every failed attempt of the step; a pass forgets them', () => {
  let s = mk({ phase: 'review', counters: { iterations: 4 } });
  const r1 = run(s, REJECT_REVIEW);
  assert.deepEqual(r1.state.priorReviews, ['review-4.json']);
  s = { ...r1.state, phase: 'review', counters: { ...r1.state.counters, iterations: 6 } };
  const r2 = run(s, REJECT_REVIEW);
  assert.deepEqual(r2.state.priorReviews, ['review-4.json', 'review-6.json']);
  assert.ok(r2.reason.includes('.perseveranza/review-4.json, .perseveranza/review-6.json'), 'both attempts named');
  assert.ok(r2.reason.includes('NOT to propose again an approach that already failed'));
  // a missing outcome counted as a failure leaves no file: the pattern still points at them
  const r3 = run(mk({ phase: 'review', counters: { retries: 1 }, flags: { repeated: true } }));
  assert.equal(r3.outcome, 'missing-twice');
  assert.ok(r3.reason.includes('.perseveranza/review-*.json'));
  // the step passes: the next step starts with a clean record
  const pass = run({ ...r2.state, phase: 'review' }, { artifacts: { review: '{"blocking":0}' } });
  assert.equal(pass.outcome, 'pass');
  assert.deepEqual(pass.state.priorReviews, []);
});

test('the advisor never routes: the same transitions, retries and pauses with it on or off', () => {
  for (const advisor of [true, false]) {
    let s = mk({ phase: 'review', options: { advisor } });
    for (let i = 1; i <= 3; i++) {
      const r = run(s, REJECT_REVIEW);
      assert.equal(r.state.phase, 'implement');
      s = { ...r.state, phase: 'review' };
    }
    const limit = run(s, REJECT_REVIEW);
    assert.equal(limit.outcome, 'fail-limit', 'fixes exhausted: a human, advisor or not');
    assert.deepEqual(advisorEntries(limit), [], 'no hint on a pause');
  }
  assert.ok(!TRANSITIONS.some((t) => /advisor/.test(t.prompt || '') || /advisor/.test(t.outcome)), 'no transition of its own');
});

test('state: an old state.json without the advisor fields loads with the defaults', () => {
  const old = defaultState({ phase: 'review' });
  delete old.options.advisor;
  delete old.options.advisorModel;
  delete old.priorReviews;
  const { state } = loadState(JSON.parse(JSON.stringify(old)));
  assert.equal(state.options.advisor, true);
  assert.equal(state.options.advisorModel, DEFAULT_ADVISOR_MODEL);
  assert.deepEqual(state.priorReviews, []);
  // and the machine drives it without a crash
  const r = run(state, REJECT_REVIEW);
  assert.equal(r.outcome, 'fail');
  // hostile values are coerced, never trusted
  const odd = normalizeState({ phase: 'plan', options: { advisor: 'yes', advisorModel: 'opus; rm -rf /' }, priorReviews: ['review-3.json', '../x', 7, 'review-9.json'] });
  assert.equal(odd.options.advisor, true);
  assert.equal(odd.options.advisorModel, 'opus');
  assert.deepEqual(odd.priorReviews, ['review-3.json', 'review-9.json']);
  const kept = normalizeState({ phase: 'plan', options: { advisor: false, advisorModel: ' claude-opus-4-1 ' } });
  assert.equal(kept.options.advisor, false);
  assert.equal(kept.options.advisorModel, 'claude-opus-4-1');
  // a v1 state migrates with the advisor on
  const v1 = loadState({ phase: 'implement', task: 'legacy', externals: [] });
  assert.equal(v1.migrated, true);
  assert.equal(v1.state.options.advisor, true);
});

test('prompts: the advisor hints declare their placeholders, both packs carry them', () => {
  const it = validatePack(JSON.parse(readFileSync(join(ROOT, 'packs', 'it.json'), 'utf8'))).overrides;
  for (const prompts of [DEFAULT_PROMPTS, it]) {
    for (const key of ['hint-advisor-plan', 'hint-advisor-fix', 'hint-advisor-verify-fix']) {
      assert.equal(typeof prompts[key], 'string', key);
      for (const name of ['advisorFallback', 'advisorRef', 'advisorModel', 'advisorN']) assert.ok(prompts[key].includes(`{{${name}}}`), `${key} lacks {{${name}}}`);
      assert.ok(prompts[key].includes('.perseveranza/notes.md'), key);
    }
    for (const key of ['hint-advisor-fix', 'hint-advisor-verify-fix']) assert.ok(prompts[key].includes('{{priorAttempts}}'), key);
    assert.equal(typeof prompts['hint-advisor-fallback'], 'string');
    assert.ok(prompts['plan-write'].includes('{{extPlanHint}}{{advPlanHint}}'));
    assert.ok(prompts['review-fix'].includes('{{extFixHint}}{{advFixHint}}'));
    assert.ok(prompts['verify-postfix'].includes('{{advFixHint}}'));
  }
  assert.ok(PROMPT_VARS['verify-postfix'].includes('advFixHint'));
  // the Italian pack renders through the machine with no placeholder left
  const r = run(mk({ phase: 'review', counters: { retries: 1 } }), { ...REJECT_REVIEW, overrides: [it] });
  assert.ok(r.reason.includes('advisor-fix-') && r.reason.includes('model=opus') && !r.reason.includes('{{'), r.reason);
});

test('journal and status: the advisor hint is readable, status shows the advisor', () => {
  assert.ok(formatEntry({ ts: '2026-10-01T10:00:00.000Z', type: 'advisor-hint', slot: 'fix', reason: 'no-external', model: 'opus', iteration: 5 }).includes('advisor fix: hint issued (no external model, model opus)'));
  assert.ok(formatEntry({ ts: '2026-10-01T10:00:00.000Z', type: 'advisor-hint', slot: 'plan', reason: 'off' }).includes('advisor plan: off, no hint'));
  const on = summary(normalizeState({ phase: 'review', task: 't', options: { advisorModel: 'sonnet' }, priorReviews: ['review-3.json'] }), '');
  assert.ok(on.includes('Advisor: on (sonnet)'), on);
  assert.ok(on.includes('review-3.json'), on);
  assert.ok(summary(normalizeState({ phase: 'plan', task: 't', options: { advisor: false } }), '').includes('Advisor: off'));
});
