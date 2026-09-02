import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderProgress, formatTokens } from '../../src/hud/render.mjs';
import { mk } from '../helpers/core.mjs';

test('formatTokens', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(12345), '12k');
  assert.equal(formatTokens(2_500_000), '2.50M');
});

test('renderProgress: phase, bar, iterations, tokens, retries', () => {
  const s = mk({ phase: 'implement', counters: { iterations: 3, retries: 1 }, limits: { maxIterations: 10 }, usage: { inputTokens: 1000, outputTokens: 500 } });
  const out = renderProgress(s, '- [x] a\n- [ ] b\n');
  assert.ok(out.startsWith('▸impl'));
  assert.ok(out.includes('1/2'));
  assert.ok(out.includes('it3/10'));
  assert.ok(out.includes('1.5k tok'));
  assert.ok(out.includes('↻1/3'));
});

test('renderProgress: paused and git-finish wording, marker with version', () => {
  const s = mk({ phase: 'git-finish', signals: { paused: true } });
  const out = renderProgress(s, '', { marker: true, version: '2.0.0' });
  assert.ok(out.includes('⟳ PRS v2.0.0'));
  assert.ok(out.includes('git: closure not confirmed'));
  assert.ok(renderProgress(mk({ phase: 'review', signals: { paused: true } })).includes('PAUSED rev'));
});
