import { rmSync } from 'node:fs';
import { gate, requireState, changeState, signal } from '../shared.mjs';
import { describeLastFire, formatAge, DEFAULT_STALE_MS } from '../../core/staleness.mjs';
import { appendJournal } from '../../shell/journal.mjs';
import { parseTimeoutMs } from '../../shell/util.mjs';
import { readLife } from '../../shell/life.mjs';

//   resume              close the pause: retry counters reset, ESCALATION.md removed
//   resume --takeover   release the owner session: for a while (PERSEVERANZA_STALE_MS) the next
//                       Stop in this project, whichever session it comes from, claims the
//                       loop from its current phase. The only way another session takes a
//                       loop over; nothing does it implicitly. A takeover of a loop that was
//                       NOT paused is a recovery, not a pause closing: the retry budget and
//                       the hand-off note are kept.
export function run({ argv, cwd, env = process.env }) {
  const paths = gate(cwd);
  requireState(paths);
  const takeover = argv.includes('--takeover');
  const staleMs = parseTimeoutMs(env.PERSEVERANZA_STALE_MS, DEFAULT_STALE_MS);
  // decided on the state reread right before the write (changeState): a Stop may have saved
  let closingPause = false;
  let released = null;
  const s = changeState(paths, (st) => {
    closingPause = st.signals.paused === true;
    released = null;
    if (closingPause) st.signals.resumedAt = Date.now(); // the next fire marks the gap as a pause
    st.signals.paused = false;
    st.flags.repeated = false;
    if (closingPause || !takeover) {
      st.counters.retries = 0;
      st.counters.finalFails = 0;
      st.counters.staleGates = 0;
    }
    if (takeover && st.owner.sessionId) {
      released = { from: st.owner.sessionId, lastFireAt: st.owner.lastFireAt };
      st.owner.releasedFrom = st.owner.sessionId;
      st.owner.sessionId = null;
    }
    if (takeover && st.owner.releasedFrom) st.owner.releasedAt = Date.now(); // (re)opens the window
  });
  if (released) appendJournal(paths.gateDir, { type: 'session', event: 'released', from: released.from.slice(0, 8), ageMs: released.lastFireAt > 0 ? Math.max(0, Date.now() - released.lastFireAt) : null });
  // the escalation hand-off belongs to the pause just closed: remove it so none goes stale
  if (closingPause || !takeover) { try { rmSync(paths.escalationPath, { force: true }); } catch { /* already gone */ } }
  signal(paths, 'resume', takeover ? '--takeover' : '');
  if (takeover) {
    const kept = closingPause ? 'retry counters reset' : 'retry counters and ESCALATION.md kept';
    console.log(`perseveranza RESUMED, owner released: within ${formatAge(staleMs)} the next Stop in this project claims the loop in phase ${s.phase}, from whichever session runs it (${kept}). Run it from the session that will continue the work.`);
  } else {
    console.log('perseveranza RESUMED (retry counters reset).');
    if (s.owner.sessionId) {
      console.log(`  owner session ${s.owner.sessionId.slice(0, 8)}, last fire ${(() => { const l = readLife(paths.gateDir, s); return describeLastFire(s, Date.now(), staleMs, l.activity, l.transcriptAt); })()}. If that session is gone, resume --takeover hands the loop to the session that runs it.`);
    }
  }
  return 0;
}
