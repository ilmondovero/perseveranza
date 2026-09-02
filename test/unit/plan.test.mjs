import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countOpenSteps, countDoneSteps, stepCounts } from '../../src/core/plan.mjs';

test('markers -, *, + and indentation are counted', () => {
  const txt = '- [ ] a\n* [ ] b\n+ [ ] c\n  - [ ] indented\n\t* [ ] tab\n';
  assert.equal(countOpenSteps(txt), 5);
  assert.equal(countDoneSteps(txt), 0);
});

test('spaces inside the box', () => {
  assert.equal(countDoneSteps('- [x ]\n- [ x ]\n'), 2);
  assert.equal(countOpenSteps('- [  ]\n'), 1);
  assert.equal(countDoneSteps('- [  ]\n'), 0);
});

test('checkboxes inside closed ``` fences are not counted', () => {
  const txt = '- [ ] real\n```\n- [ ] fake\n- [x] fake2\n```\n';
  assert.equal(countOpenSteps(txt), 1);
  assert.equal(countDoneSteps(txt), 0);
});

test('an unclosed fence hides everything until EOF', () => {
  assert.equal(countOpenSteps('```\n- [ ] leaked'), 0);
  assert.equal(countOpenSteps('- [ ] real\n```\n- [ ] leaked'), 1);
});

test('~~~ fences and inline backticks', () => {
  assert.equal(countOpenSteps('~~~\n- [ ] x\n~~~'), 0);
  assert.equal(countOpenSteps('- [ ] use `[ ]` here\n- [x] done\n'), 1);
  assert.equal(countDoneSteps('- [ ] use ``` inline\n- [x] done\n'), 1);
});

test('links are not checkboxes; BOM and non-strings are tolerated', () => {
  assert.equal(countOpenSteps('* [a](b)\n'), 0);
  assert.equal(countOpenSteps('﻿- [ ] first\n'), 1);
  assert.equal(countOpenSteps(null), 0);
  assert.equal(countDoneSteps(undefined), 0);
  assert.equal(countOpenSteps(42), 0);
});

test('stepCounts totals', () => {
  assert.deepEqual(stepCounts('- [x] a\n- [ ] b\n- [ ] c\n'), { done: 1, open: 2, total: 3 });
  assert.deepEqual(stepCounts(''), { done: 0, open: 0, total: 0 });
});
