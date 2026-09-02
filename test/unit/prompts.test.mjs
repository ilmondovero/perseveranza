import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROMPTS, PROMPT_VARS, PROMPT_KEYS, renderPrompt, validatePack, missingKeys } from '../../src/core/prompts.mjs';

test('renderPrompt interpolates, keeps unknown placeholders literal, unknown key -> empty', () => {
  assert.equal(renderPrompt('claim-open-steps', { openSteps: 2, LOOP: 'L' }), DEFAULT_PROMPTS['claim-open-steps'].replace('{{openSteps}}', '2').replaceAll('{{LOOP}}', 'L'));
  assert.ok(renderPrompt('claim-open-steps', { LOOP: 'L' }).includes('{{openSteps}}'));
  assert.equal(renderPrompt('nope', {}), '');
});

test('renderPrompt honours layers in order (first layer that has the key wins)', () => {
  const hi = { cleanup: 'HI {{testRun}}' };
  const lo = { cleanup: 'LO {{testRun}}', 'phase-recovered': 'LOW ONLY' };
  assert.equal(renderPrompt('cleanup', { testRun: 'T' }, [hi, lo]), 'HI T');
  assert.equal(renderPrompt('phase-recovered', {}, [hi, lo]), 'LOW ONLY');
  assert.equal(renderPrompt('cleanup', { testRun: 'T' }, [{}, lo]), 'LO T');
  assert.equal(renderPrompt('cleanup', { testRun: 'T' }, lo), 'LO T'); // single object accepted
});

test('every default template uses only its declared placeholders', () => {
  for (const key of PROMPT_KEYS) {
    const allowed = PROMPT_VARS[key];
    assert.ok(Array.isArray(allowed), `PROMPT_VARS missing for ${key}`);
    for (const m of DEFAULT_PROMPTS[key].matchAll(/\{\{([a-zA-Z0-9_-]+)\}\}/g)) {
      assert.ok(allowed.includes(m[1]), `${key} uses undeclared placeholder {{${m[1]}}}`);
    }
  }
  assert.deepEqual(Object.keys(PROMPT_VARS).sort(), [...PROMPT_KEYS].sort());
});

test('the operative verbs are in the defaults (the pack may reword, the verbs must stay)', () => {
  assert.ok(DEFAULT_PROMPTS['plan-write'].includes('{{LOOP}} complexity low|medium|high'));
  assert.ok(DEFAULT_PROMPTS['review-advance'].includes('{{LOOP}} claim-done'));
  assert.ok(DEFAULT_PROMPTS['review-advance'].includes('{{LOOP}} test --'));
  assert.ok(DEFAULT_PROMPTS['review-delegate'].includes('.omc-loop/review.json'));
  assert.ok(DEFAULT_PROMPTS['final-verify'].includes('.omc-loop/verify.json'));
  assert.ok(DEFAULT_PROMPTS['review-missing-outcome'].includes('report pass'));
});

test('validatePack: unknown keys, bad placeholders, non-strings, malformed roots', () => {
  const v = validatePack({ prompts: { cleanup: 'x {{testRun}} {{bogus}}', nope: 'y', 'plan-write': 42 } });
  assert.equal(v.error, null);
  assert.deepEqual(v.unknownKeys, ['nope']);
  assert.deepEqual(Object.keys(v.overrides), ['cleanup']);
  assert.equal(v.badPlaceholders.length, 2);
  assert.equal(v.badPlaceholders[0].placeholder, 'bogus');
  assert.equal(validatePack(null).error, 'pack is not an object');
  assert.equal(validatePack({}).error, 'missing "prompts" object');
  assert.equal(validatePack({ prompts: [] }).error, 'missing "prompts" object');
});

test('missingKeys lists what a pack does not cover', () => {
  assert.equal(missingKeys({}).length, PROMPT_KEYS.length);
  const full = Object.fromEntries(PROMPT_KEYS.map((k) => [k, 'x']));
  assert.deepEqual(missingKeys(full), []);
});
