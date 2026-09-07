import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAge, formatAt, staleness, lastSeen, normalizeActivity, describeActivity, releaseOpen, describeLastFire, openStepTitles, noticeKind, sessionNotice, compactNotice, restorePrompt, DEFAULT_STALE_MS, HUD_AGE_MIN_MS } from '../../src/core/staleness.mjs';
import { validatePack } from '../../src/core/prompts.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../src/shell/paths.mjs';
import { mk } from '../helpers/core.mjs';

const H = 3600 * 1000;
const T0 = Date.UTC(2026, 8, 6, 11, 10, 25); // 2026-09-06 11:10:25 UTC, the reported last fire
const IT = validatePack(JSON.parse(readFileSync(join(ROOT, 'packs', 'it.json'), 'utf8'))).overrides;

test('thresholds: thirty minutes stale, ten minutes before the HUD shows an age', () => {
  assert.equal(DEFAULT_STALE_MS, 30 * 60 * 1000);
  assert.equal(HUD_AGE_MIN_MS, 10 * 60 * 1000);
});

test('formatAge / formatAt', () => {
  assert.equal(formatAge(0), '0s');
  assert.equal(formatAge(42 * 1000), '42s');
  assert.equal(formatAge(7 * 60 * 1000), '7m');
  assert.equal(formatAge(20 * H + 43 * 60 * 1000), '20h43m');
  assert.equal(formatAge(2 * H), '2h00m');
  assert.equal(formatAge(3 * 24 * H + 5 * H), '3d5h');
  assert.equal(formatAge(-5), '0s');
  assert.equal(formatAt(T0), '2026-09-06 11:10 UTC');
  assert.equal(formatAt(0), '?');
  assert.equal(formatAt(9e15), '?', 'beyond the Date range: no RangeError from a hand-edited state');
  assert.equal(formatAt('nope'), '?');
});

test('staleness: never fired, fresh, stale, custom threshold', () => {
  const never = staleness(mk(), T0);
  assert.deepEqual(never, { claimed: false, paused: false, lastFireAt: 0, seenAt: 0, via: 'fire', ageMs: null, stale: false });
  const s = mk({ owner: { sessionId: '8dd6a127-x', lastFireAt: T0 } });
  assert.equal(staleness(s, T0 + DEFAULT_STALE_MS).stale, false, 'at the threshold: not yet');
  assert.equal(staleness(s, T0 + DEFAULT_STALE_MS + 1).stale, true);
  assert.equal(staleness(s, T0 + 2.5 * H, 3 * H).stale, false);
  assert.equal(staleness(s, T0 + 3 * H, 'garbage').stale, true, 'bad threshold falls back to the default');
  assert.equal(staleness(s, T0 - 1000).ageMs, 0, 'a clock in the past is not negative');
  // paused: a human is expected, however long it takes; the age is still measured
  const paused = staleness(mk({ signals: { paused: true }, owner: { sessionId: 'A', lastFireAt: T0 } }), T0 + 30 * H);
  assert.equal(paused.stale, false);
  assert.equal(paused.paused, true);
  assert.equal(paused.ageMs, 30 * H);
});

test('activity: the heartbeat of a turn moves the last sign of life, a foreign session\'s does not', () => {
  const s = mk({ owner: { sessionId: 'A', lastFireAt: T0 } });
  assert.deepEqual(lastSeen(s, null), { at: T0, via: 'fire' });
  assert.deepEqual(lastSeen(s, { at: T0 + H, session: 'A', event: 'tool', tool: 'Bash' }), { at: T0 + H, via: 'activity' });
  assert.deepEqual(lastSeen(s, { at: T0 - H, session: 'A' }), { at: T0, via: 'fire' }, 'older than the fire: the fire wins');
  assert.deepEqual(lastSeen(s, { at: T0 + H, session: 'B' }), { at: T0, via: 'fire' }, 'another session\'s tools are not this loop\'s life');
  assert.deepEqual(lastSeen(mk(), { at: T0 + H, session: 'B' }), { at: T0 + H, via: 'activity' }, 'unclaimed: any activity counts');
  // the transcript: written at every message, the third sign of life, strongest when latest
  assert.deepEqual(lastSeen(s, null, T0 + 2 * H), { at: T0 + 2 * H, via: 'transcript' });
  assert.deepEqual(lastSeen(s, { at: T0 + 3 * H, session: 'A' }, T0 + 2 * H), { at: T0 + 3 * H, via: 'activity' });
  assert.deepEqual(lastSeen(s, { at: T0 + 3 * H, session: 'B' }, T0 + 2 * H), { at: T0 + 2 * H, via: 'transcript' }, 'foreign activity ignored, transcript still counts');
  assert.deepEqual(lastSeen(s, null, T0 - H), { at: T0, via: 'fire' });
  const gen = staleness(s, T0 + 20 * H, DEFAULT_STALE_MS, null, T0 + 20 * H - 5000);
  assert.equal(gen.stale, false); assert.equal(gen.via, 'transcript'); assert.equal(gen.ageMs, 5000);
  assert.equal(noticeKind(s, T0 + 20 * H, DEFAULT_STALE_MS, null, T0 + 20 * H - 5000), 'live');
  assert.ok(sessionNotice(s, { now: T0 + 20 * H, transcriptAt: T0 + 20 * H - 5000 }).includes('last output 5s ago'));
  assert.equal(normalizeActivity({ at: 'x' }), null);
  assert.equal(normalizeActivity(null), null);
  assert.deepEqual(normalizeActivity({ at: 5, delegate: { at: 0 } }).pending, []);
  assert.deepEqual(normalizeActivity({ at: 5, delegate: { at: 3, agent: 'old' } }).pending, [{ at: 3, agent: 'old' }], 'the single-slot shape of the first cut is still read');
  assert.deepEqual(normalizeActivity({ at: 5, pending: [{ at: 9, agent: 'b' }, { at: 2, agent: 'a' }, null, { at: 0 }] }).pending.map((d) => d.agent), ['a', 'b'], 'oldest first, garbage dropped');
  // a fire last night with a tool call ten minutes ago is a live loop
  const live = staleness(s, T0 + 20 * H, DEFAULT_STALE_MS, { at: T0 + 20 * H - 10 * 60 * 1000, session: 'A' });
  assert.equal(live.stale, false);
  assert.equal(live.via, 'activity');
  assert.equal(live.ageMs, 10 * 60 * 1000);
  assert.equal(describeLastFire(s, T0 + 20 * H, DEFAULT_STALE_MS, { at: T0 + 20 * H - 10 * 60 * 1000, session: 'A' }), '20h00m ago (2026-09-06 11:10 UTC)', 'the fire age is still the fire age, just not STALE');
  // the forensic sentence
  const now = T0 + 3 * H;
  assert.equal(describeActivity({ at: T0 + H, event: 'tool', tool: 'Bash' }, now), '2h00m ago (2026-09-06 12:10 UTC, tool Bash)');
  assert.equal(describeActivity({ at: T0 + H, event: 'delegate', agent: 'pf-reviewer', pending: [{ at: T0 + H, agent: 'pf-reviewer' }] }, now), '2h00m ago (2026-09-06 12:10 UTC, delegated to pf-reviewer), not back yet');
  assert.equal(describeActivity({ at: T0 + 2 * H, event: 'tool', tool: 'Read', pending: [{ at: T0 + H, agent: 'pf-reviewer' }] }, now), '1h00m ago (2026-09-06 13:10 UTC, tool Read); pf-reviewer delegated 2h00m ago, not back yet');
  assert.equal(describeActivity({ at: T0 + 2 * H, event: 'delegate', agent: 'b', pending: [{ at: T0 + H, agent: 'a' }, { at: T0 + 2 * H, agent: 'b' }] }, now), '1h00m ago (2026-09-06 13:10 UTC, delegated to b), not back yet; a delegated 2h00m ago, not back yet', 'parallel delegations: all of them');
  assert.equal(describeActivity({ at: T0 + H, event: 'delegate', agent: 'x', pending: [] }, now), '2h00m ago (2026-09-06 12:10 UTC, delegated to x)', 'delegated and already back');
  assert.equal(describeActivity({ at: T0 + H, event: 'subagent-stop', agent: 'pf-reviewer' }, now), '2h00m ago (2026-09-06 12:10 UTC, subagent pf-reviewer finished)');
  assert.equal(describeActivity(null, now), '');
});

test('releaseOpen: only a released loop, only within the window', () => {
  const rel = (over) => mk({ owner: { sessionId: null, lastFireAt: T0, releasedFrom: 'A', releasedAt: T0 + H, ...over } });
  assert.equal(releaseOpen(rel(), T0 + H + 60 * 1000), true);
  assert.equal(releaseOpen(rel(), T0 + H + DEFAULT_STALE_MS), true, 'at the edge: still open');
  assert.equal(releaseOpen(rel(), T0 + H + DEFAULT_STALE_MS + 1), false);
  assert.equal(releaseOpen(rel(), T0 + 5 * H, 10 * H), true, 'custom window');
  assert.equal(releaseOpen(rel({ releasedAt: 0 }), T0 + H), false, 'released without a time (old state): closed');
  assert.equal(releaseOpen(rel({ sessionId: 'B' }), T0 + H), false, 'claimed: nothing to open');
  assert.equal(releaseOpen(mk(), T0), false);
});

test('describeLastFire', () => {
  assert.equal(describeLastFire(mk(), T0), 'never');
  const s = mk({ owner: { sessionId: 'A', lastFireAt: T0 } });
  assert.equal(describeLastFire(s, T0 + 5 * 60 * 1000), '5m ago (2026-09-06 11:10 UTC)');
  assert.equal(describeLastFire(s, T0 + 20 * H + 43 * 60 * 1000), '20h43m ago (2026-09-06 11:10 UTC)  STALE');
  const paused = mk({ signals: { paused: true }, owner: { sessionId: 'A', lastFireAt: T0 } });
  assert.equal(describeLastFire(paused, T0 + 20 * H), '20h00m ago (2026-09-06 11:10 UTC)  (paused)');
});

test('openStepTitles: first three open steps, long titles cut, fences ignored like the gate', () => {
  const plan = '- [x] done\n- [ ] alpha\n  - [ ] beta nested\n* [ ] gamma\n- [ ] delta\n```\n- [ ] not a step\n```\n';
  const r = openStepTitles(plan);
  assert.equal(r.count, 4);
  assert.deepEqual(r.shown, ['alpha', 'beta nested', 'gamma']);
  const long = openStepTitles(`- [ ] ${'x'.repeat(80)}\n`);
  assert.equal(long.shown[0], `${'x'.repeat(57)}...`);
  assert.deepEqual(openStepTitles(''), { count: 0, shown: [] });
});

test('noticeKind: released (window) > waiting (paused) > fresh/abandoned (never fired) > stale/live', () => {
  const armed = new Date(T0).toISOString();
  const released = mk({ armedAt: armed, owner: { sessionId: null, releasedFrom: 'A', lastFireAt: T0, releasedAt: T0 + 30 * H } });
  assert.equal(noticeKind(released, T0 + 30 * H + 60 * 1000), 'released');
  assert.equal(noticeKind(released, T0 + 30 * H + DEFAULT_STALE_MS + 1), 'abandoned', 'the window closed: nobody should claim it by accident');
  assert.equal(noticeKind(mk({ armedAt: armed, owner: { sessionId: null, releasedFrom: 'A', lastFireAt: T0 } }), T0 + H), 'abandoned', 'released by an older engine, no time: closed');
  const paused = mk({ armedAt: armed, signals: { paused: true }, owner: { sessionId: 'A', lastFireAt: T0 } });
  assert.equal(noticeKind(paused, T0 + 30 * H), 'waiting', 'a pause is a human\'s choice, however long');
  assert.equal(noticeKind(paused, T0 + 60 * 1000), 'waiting');
  assert.equal(noticeKind(mk({ armedAt: armed }), T0 + 5 * 60 * 1000), 'fresh', 'armed five minutes ago, first Stop still to come');
  assert.equal(noticeKind(mk({ armedAt: armed }), T0 + 3 * H), 'abandoned', 'armed three hours ago and nobody ever fired');
  assert.equal(noticeKind(mk({ armedAt: null }), T0), 'abandoned', 'no arm time at all: cannot be called fresh');
  const owned = mk({ armedAt: armed, owner: { sessionId: 'A', lastFireAt: T0 } });
  assert.equal(noticeKind(owned, T0 + 60 * 1000), 'live');
  assert.equal(noticeKind(owned, T0 + 3 * H), 'abandoned');
  assert.equal(noticeKind(owned, T0 + 3 * H, 4 * H), 'live');
});

test('sessionNotice: abandoned asks the user; live, released and fresh only inform', () => {
  const s = mk({ task: 'ship it', phase: 'review', armedAt: new Date(T0 - H).toISOString(), owner: { sessionId: '8dd6a127-full', lastFireAt: T0 } });
  const plan = '- [x] a\n- [x] b\n- [ ] c\n';
  const stale = sessionNotice(s, { planText: plan, now: T0 + 20 * H + 43 * 60 * 1000, sessionId: 'new-sess', LOOP: 'LOOP', lastPrompt: 'review-delegate' });
  assert.ok(stale.includes('belongs to session 8dd6a127 and looks ABANDONED'));
  assert.ok(stale.includes('phase `review`'));
  assert.ok(stale.includes('last fire 20h43m ago (2026-09-06 11:10 UTC)'));
  assert.ok(stale.includes('2/3 steps done'));
  assert.ok(stale.includes('last instruction `review-delegate`'));
  assert.ok(stale.includes('Task: ship it.'));
  assert.ok(stale.includes('LOOP resume --takeover'));
  assert.ok(stale.includes('LOOP disarm'));
  assert.ok(stale.includes('do nothing else in this repository'));
  assert.ok(!stale.includes('{{'), 'every placeholder resolved');
  const live = sessionNotice(s, { planText: plan, now: T0 + 60 * 1000, sessionId: 'new-sess', LOOP: 'LOOP' });
  assert.ok(!live.includes('ABANDONED'));
  assert.ok(live.includes('driven by another session (session 8dd6a127, phase `review`, last fire 1m ago'));
  assert.ok(live.includes('This session (new-sess)'));
  assert.ok(live.includes('resume --takeover'));
  const paused = sessionNotice(mk({ phase: 'plan', signals: { paused: true }, owner: { sessionId: 'A', lastFireAt: T0 } }), { now: T0 + 3 * H });
  assert.ok(paused.includes('phase `plan (PAUSED)`'));
  assert.ok(paused.includes('no plan yet'));
  const released = sessionNotice(mk({ task: 't', phase: 'implement', owner: { sessionId: null, releasedFrom: 'A-long-id', lastFireAt: T0, releasedAt: T0 + 30 * H } }), { now: T0 + 30 * H, LOOP: 'LOOP' });
  assert.ok(released.includes('released by session A-long-i'));
  assert.ok(released.includes('waiting for a claim: phase `implement`, last fire 1d6h ago'));
  assert.ok(!released.includes('ABANDONED'));
  const fresh = sessionNotice(mk({ task: 't', armedAt: new Date(T0).toISOString() }), { now: T0 + 90 * 1000 });
  assert.ok(fresh.includes('just armed in this project (armed 1m ago (2026-09-06 11:10 UTC), never fired)'));
  assert.ok(fresh.includes('no session has fired yet'));
  const old = sessionNotice(mk({ task: 't', armedAt: new Date(T0).toISOString() }), { now: T0 + 5 * H });
  assert.ok(old.includes('belongs to no session (never claimed) and looks ABANDONED'));
  assert.ok(old.includes('armed 5h00m ago'));
  const waiting = sessionNotice(mk({ task: 't', phase: 'implement', signals: { paused: true }, owner: { sessionId: 'A', lastFireAt: T0 } }), { now: T0 + 30 * H, LOOP: 'LOOP' });
  assert.ok(waiting.includes('is PAUSED and waits for a human: owner session A, phase `implement (PAUSED)`, last fire 1d6h ago'), waiting);
  assert.ok(waiting.includes('It is not abandoned'));
  assert.ok(waiting.includes('ESCALATION.md'));
  assert.ok(waiting.includes('LOOP resume --takeover'));
});

test('sessionNotice: with an activity record the notice says what the turn was doing', () => {
  const s = mk({ task: 'ship it', phase: 'review', owner: { sessionId: 'A', lastFireAt: T0 } });
  const act = { at: T0 + 10 * 60 * 1000, session: 'A', event: 'delegate', agent: 'pf-reviewer', pending: [{ at: T0 + 10 * 60 * 1000, agent: 'pf-reviewer' }] };
  const en = sessionNotice(s, { now: T0 + 20 * H, LOOP: 'LOOP', activity: act });
  assert.ok(en.includes('ABANDONED'));
  assert.ok(en.includes('last activity 19h50m ago (2026-09-06 11:20 UTC: delegated to pf-reviewer, not back yet)'), en);
  const it = sessionNotice(s, { now: T0 + 20 * H, LOOP: 'LOOP', activity: act, layers: [IT] });
  assert.ok(it.includes("ultima attivita' 19h50m fa (2026-09-06 11:20 UTC: delegato a pf-reviewer, non ancora tornato)"), it);
  const pend = sessionNotice(s, { now: T0 + 20 * H, activity: { at: T0 + H, session: 'A', event: 'tool', tool: 'Read', pending: [{ at: T0 + 10 * 60 * 1000, agent: 'pf-reviewer' }, { at: T0 + H, agent: 'pf-executor' }] } });
  assert.ok(pend.includes('tool Read; pf-reviewer delegated 19h50m ago and not back yet; pf-executor delegated 19h00m ago and not back yet'), pend);
  // never fired but the arming turn is alive: fresh, not live-by-nobody
  const arming = mk({ task: 't', armedAt: new Date(T0).toISOString() });
  assert.equal(noticeKind(arming, T0 + 3 * H, DEFAULT_STALE_MS, { at: T0 + 3 * H - 60 * 1000, session: 'X' }), 'fresh');
  assert.equal(noticeKind(arming, T0 + 3 * H, DEFAULT_STALE_MS, { at: T0 + 10 * 60 * 1000, session: 'X' }), 'abandoned');
  assert.ok(sessionNotice(arming, { now: T0 + 3 * H, activity: { at: T0 + 3 * H - 60 * 1000, session: 'X', event: 'tool', tool: 'Bash' } }).includes('just armed in this project (last activity 1m ago'));
  const alive = sessionNotice(s, { now: T0 + 20 * H, activity: { at: T0 + 20 * H - 60 * 1000, session: 'A', event: 'tool', tool: 'Bash' } });
  assert.ok(alive.includes('driven by another session') && alive.includes('last activity 1m ago'), 'the fire is old, the turn is alive');
  assert.equal(noticeKind(s, T0 + 20 * H, DEFAULT_STALE_MS, { at: T0 + 20 * H - 60 * 1000, session: 'A' }), 'live');
});

test('sessionNotice and compactNotice speak the language of the pack', () => {
  const s = mk({ task: 'spedire', phase: 'review', owner: { sessionId: 'A', lastFireAt: T0 } });
  const it = sessionNotice(s, { planText: '- [x] a\n- [ ] b\n', now: T0 + 3 * H, LOOP: 'LOOP', lastPrompt: 'review-fix', layers: [IT] });
  assert.ok(it.includes('sembra ABBANDONATO'));
  assert.ok(it.includes('fase `review`'));
  assert.ok(it.includes('ultimo fire 3h00m fa (2026-09-06 11:10 UTC)'));
  assert.ok(it.includes('1/2 passi fatti'));
  assert.ok(it.includes('ultima istruzione `review-fix`'));
  assert.ok(it.includes('LOOP resume --takeover'), 'the verbs survive translation');
  assert.ok(!it.includes('{{'));
  const paused = sessionNotice({ ...s, signals: { ...s.signals, paused: true } }, { now: T0 + 3 * H, LOOP: 'LOOP', layers: [IT] });
  assert.ok(paused.includes('IN PAUSA e aspetta un umano'));
  assert.ok(paused.includes('fase `review (IN PAUSA)`'));
  assert.ok(!paused.includes('{{'));
  const project = { 'session-live': 'CUSTOM {{owner}} {{when}}' };
  const live = sessionNotice(s, { now: T0 + 60 * 1000, layers: [project, IT] });
  assert.equal(live, 'CUSTOM sessione A ultimo fire 1m fa (2026-09-06 11:10 UTC)', 'the project layer wins, its hints still come from the pack');
  const c = compactNotice(mk({ task: 'spedire', phase: 'implement' }), { planText: '- [x] a\n- [ ] b\n', LOOP: 'LOOP', layers: [IT] });
  assert.ok(c.includes('questa sessione guida un loop armato (fase `implement`, 1/2 passi fatti)'));
  assert.ok(c.includes('LOOP status'));
});

test('restorePrompt: what a restored session is told, in the language of the pack', () => {
  const s = mk({ task: 'ship it', phase: 'review' });
  const en = restorePrompt(s, { silentMs: 31 * 60 * 1000, LOOP: 'LOOP', activity: { at: 1, pending: [{ at: 1, agent: 'pf-reviewer' }] } });
  assert.ok(en.includes('interrupted by the watchdog after 31m without a sign of life'), en);
  assert.ok(en.includes('Task: ship it. Phase `review`.'));
  assert.ok(en.includes('A delegation was pending and never returned (pf-reviewer)'));
  assert.ok(en.includes('LOOP status'));
  assert.ok(en.includes('do not blindly repeat'));
  assert.ok(!en.includes('{{'));
  const plain = restorePrompt(s, { silentMs: 60_000 });
  assert.ok(!plain.includes('delegation'));
  const it = restorePrompt(s, { silentMs: 31 * 60 * 1000, LOOP: 'LOOP', layers: [IT], activity: { at: 1, pending: [{ at: 1, agent: 'a' }, { at: 2, agent: 'b' }] } });
  assert.ok(it.includes('interrotto dalla sentinella dopo 31m'), it);
  assert.ok(it.includes('non e\' mai tornata (a, b)'));
  assert.ok(it.includes('LOOP status'));
});

test('compactNotice reminds the owner of the phase and the status verb', () => {
  const s = mk({ task: 'ship it', phase: 'implement' });
  const t = compactNotice(s, { planText: '- [x] a\n- [ ] b\n', LOOP: 'LOOP' });
  assert.ok(t.includes('this session drives an armed loop (phase `implement`, 1/2 steps done)'));
  assert.ok(t.includes('LOOP status'));
  assert.ok(compactNotice(mk({ signals: { paused: true } })).includes('(PAUSED)'));
});
