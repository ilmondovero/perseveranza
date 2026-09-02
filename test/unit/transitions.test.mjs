import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRANSITIONS, lookup, outcomesFor, toMarkdown } from '../../src/core/transitions.mjs';
import { PHASES } from '../../src/core/state.mjs';
import { DEFAULT_PROMPTS } from '../../src/core/prompts.mjs';

test('every row points at a real phase (or a sentinel) and a real prompt key', () => {
  for (const r of TRANSITIONS) {
    assert.ok(r.phase === '*' || PHASES.includes(r.phase), `bad phase ${r.phase}`);
    assert.ok(r.next === '=' || r.next === 'disarm' || PHASES.includes(r.next), `bad next ${r.next} for ${r.phase}:${r.outcome}`);
    if (r.prompt) assert.ok(r.prompt in DEFAULT_PROMPTS, `unknown prompt ${r.prompt}`);
  }
});

test('(phase, outcome) pairs are unique', () => {
  const seen = new Set();
  for (const r of TRANSITIONS) {
    const k = `${r.phase}:${r.outcome}`;
    assert.ok(!seen.has(k), `duplicate ${k}`);
    seen.add(k);
  }
});

test('lookup resolves wildcards and "unchanged"', () => {
  assert.equal(lookup('review', 'pass').next, 'implement');
  assert.equal(lookup('implement', 'claim-open').next, 'implement');
  assert.equal(lookup('review', 'claim-first').next, 'cleanup');
  assert.equal(lookup('review', 'nope'), null);
});

test('every phase has at least one outgoing row and the markdown lists all rows', () => {
  for (const p of PHASES) assert.ok(outcomesFor(p).length > 0, p);
  const md = toMarkdown();
  assert.equal(md.split('\n').length, TRANSITIONS.length + 2);
  assert.ok(md.includes('| any | claim-first | cleanup |'));
});
