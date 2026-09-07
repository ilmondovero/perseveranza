import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewVerdict, parseVerifyVerdict } from '../../src/core/verdicts.mjs';

test('review: well-formed pass and fail', () => {
  const pass = parseReviewVerdict('{"blocking":0,"findings":[]}');
  assert.equal(pass.ok, true);
  assert.equal(pass.blocking, 0);
  const fail = parseReviewVerdict('{"blocking":2,"findings":[{"severity":"critical","desc":"a"},{"severity":"critical","desc":"b"}]}');
  assert.equal(fail.ok, true);
  assert.equal(fail.blocking, 2);
  assert.equal(fail.findings.length, 2);
});

test('review: findings optional, severity case-insensitive, desc/file normalised', () => {
  const r = parseReviewVerdict('{"blocking":0}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
  const r2 = parseReviewVerdict('{"blocking":0,"findings":[{"severity":"Warning","description":"x","file":"a.js:3"}]}');
  assert.equal(r2.findings[0].severity, 'warning');
  assert.equal(r2.findings[0].desc, 'x');
  assert.equal(r2.findings[0].file, 'a.js:3');
});

test('review: the stricter reading wins when blocking under-counts critical findings', () => {
  const r = parseReviewVerdict('{"blocking":0,"findings":[{"severity":"critical","desc":"boom"}]}');
  assert.equal(r.ok, true);
  assert.equal(r.blocking, 1);
  assert.equal(r.declaredBlocking, 0);
  assert.equal(r.notes.length, 1);
});

test('review: malformed inputs are errors, never a pass', () => {
  for (const bad of ['', '   ', 'not json', '[]', '{}', '{"blocking":null}', '{"blocking":false}', '{"blocking":""}', '{"blocking":[]}', '{"blocking":"0"}', '{"blocking":"many"}', '{"blocking":-1}', '{"blocking":1.5}',
    '{"blocking":0,"findings":"x"}', '{"blocking":0,"findings":[{"severity":"fatal"}]}', '{"blocking":0,"findings":[1]}']) {
    const r = parseReviewVerdict(bad);
    assert.equal(r.ok, false, `expected error for ${JSON.stringify(bad)}`);
    assert.ok(typeof r.error === 'string' && r.error.length > 0);
  }
});

test('verify: well-formed pass and fail', () => {
  assert.equal(parseVerifyVerdict('{"pass":true,"findings":[]}').pass, true);
  assert.equal(parseVerifyVerdict('{"pass":false,"findings":[{"severity":"critical","desc":"x"}]}').pass, false);
});

test('verify: pass=true with a critical finding becomes a rejection', () => {
  const r = parseVerifyVerdict('{"pass":true,"findings":[{"severity":"critical","desc":"x"}]}');
  assert.equal(r.ok, true);
  assert.equal(r.pass, false);
  assert.equal(r.declaredPass, true);
  assert.equal(r.notes.length, 1);
});

test('verify: malformed inputs are errors', () => {
  for (const bad of ['', '{}', '{"pass":"yes"}', '{"pass":1}', 'null', '{"pass":true,"findings":[{"severity":"nope"}]}']) {
    assert.equal(parseVerifyVerdict(bad).ok, false, `expected error for ${JSON.stringify(bad)}`);
  }
});

test('reconcile.json: disposition and next validated, running listed, defaults derived', async () => {
  const { parseReconcile } = await import('../../src/core/verdicts.mjs');
  assert.equal(parseReconcile('').ok, false);
  assert.equal(parseReconcile('[]').ok, false);
  assert.ok(parseReconcile('{"disposition":"done"}').error.includes('disposition must be one of'));
  assert.ok(parseReconcile('{"disposition":"partial","next":"cleanup"}').error.includes('next must be implement or review'));
  assert.ok(parseReconcile('{"disposition":"partial","running":"npm test"}').error.includes('running is not an array'));
  const c = parseReconcile('{"disposition":"Complete","summary":"step 4 edits are on disk"}');
  assert.deepEqual([c.ok, c.disposition, c.next, c.running, c.summary], [true, 'complete', 'review', [], 'step 4 edits are on disk']);
  const p = parseReconcile('{"disposition":"partial"}');
  assert.equal(p.next, 'implement');
  const u = parseReconcile('{"disposition":"uncertain","running":["node server.js", 42]}');
  assert.deepEqual([u.ok, u.disposition, u.running], [true, 'uncertain', ['node server.js', '42']]);
  const odd = parseReconcile('{"disposition":"complete","next":"implement"}');
  assert.equal(odd.next, 'implement');
  assert.ok(odd.notes[0].includes('complete but next=implement'));
  const pr = parseReconcile('{"disposition":"partial","next":"review"}');
  assert.equal(pr.next, 'implement', 'a partial step is continued, never reviewed as is');
  assert.ok(pr.notes[0].includes('partial but next=review'));
});
