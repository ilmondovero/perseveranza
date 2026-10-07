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
  assert.ok(DEFAULT_PROMPTS['review-advance'].includes('{{testRun}}'));
  assert.ok(DEFAULT_PROMPTS['hint-test-green'].includes('{{testRun}}'));
  assert.ok(DEFAULT_PROMPTS['hint-verdict-file'].includes('{{verdictFile}}'));
  assert.ok(DEFAULT_PROMPTS['review-delegate'].includes('.perseveranza/review.json'));
  assert.ok(DEFAULT_PROMPTS['final-verify'].includes('.perseveranza/verify.json'));
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

// A real run (3.0.1, Windows, Git Bash): the reviewer wrote review.json, the Stop took it at
// once (renamed review-2.json), the reviewer read it back, found nothing, ran `pwd` (Git Bash:
// /tmp/claude/...) and wrote there with the Write tool, which resolved it to C:\tmp\claude\...,
// outside the project: denied. The prompts hand the judges a relative path; the agents are told
// to write once, not to look for the file again, and not to build its path from shell output.
test('the judges write their verdict once, by the relative path, never from pwd', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ROOT } = await import('../../src/shell/paths.mjs');
  for (const [agent, file] of [['pf-reviewer', 'review.json'], ['pf-verifier', 'verify.json']]) {
    const text = readFileSync(join(ROOT, 'agents', `${agent}.md`), 'utf8').replace(/\s+/g, ' ');
    assert.ok(text.includes(`Write \`.perseveranza/${file}\` (relative to the current working directory)`), agent);
    assert.ok(text.includes('Write it ONCE, with the Write tool and the relative path above, as your last action.'), agent);
    assert.ok(text.includes('Do not read it back, look for it or write it again'), agent);
    assert.ok(text.includes('a verdict you no longer find was received, not lost'), agent);
    assert.ok(/Never build its path from `pwd` or other shell output: in Git Bash on Windows `pwd` prints a POSIX path/.test(text), agent);
  }
  for (const key of ['review-delegate', 'final-verify']) {
    const p = DEFAULT_PROMPTS[key];
    assert.match(p, /\.perseveranza\/(review|verify)\.json/, key);
    // no absolute path and no placeholder that could carry one into the verdict's path
    assert.doesNotMatch(p, /[A-Za-z]:[\/]|\/tmp\/|\{\{(cwd|gateDir|root)\}\}/, key);
  }
});
