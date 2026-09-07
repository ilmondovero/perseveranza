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

test('renderProgress: age of the last fire only with a clock and past ten minutes, STALE in red past the threshold', () => {
  const now = 1_800_000_000_000;
  const s = mk({ phase: 'review', owner: { sessionId: 'A', lastFireAt: now - 15 * 60 * 1000 } });
  assert.ok(!renderProgress(s, '').includes('⏱'), 'no clock, no age (the injected header stays stable)');
  assert.ok(renderProgress(s, '', { now }).includes('⏱15m'));
  const quiet = mk({ phase: 'review', owner: { sessionId: 'A', lastFireAt: now - 5 * 60 * 1000 } });
  assert.ok(!renderProgress(quiet, '', { now }).includes('⏱'), 'a live loop keeps the statusline quiet');
  const dead = mk({ phase: 'review', owner: { sessionId: 'A', lastFireAt: now - 20 * 3600 * 1000 } });
  const out = renderProgress(dead, '', { now, color: true });
  assert.ok(out.includes('\x1b[1;31m⏱20h00m STALE\x1b[0m'), out);
  assert.ok(!renderProgress(dead, '', { now, staleMs: 30 * 3600 * 1000 }).includes('STALE'));
  assert.ok(!renderProgress(mk(), '', { now }).includes('⏱'), 'never fired: nothing');
  const paused = mk({ phase: 'review', signals: { paused: true }, owner: { sessionId: 'A', lastFireAt: now - 20 * 3600 * 1000 } });
  const p = renderProgress(paused, '', { now });
  assert.ok(p.includes('⏱20h00m') && !p.includes('STALE'), p);
});
