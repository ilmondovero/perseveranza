import { rmSync } from 'node:fs';
import { gate, requireState, saveState, signal } from '../shared.mjs';
import { describeLastFire, formatAge, DEFAULT_STALE_MS } from '../../core/staleness.mjs';
import { appendJournal } from '../../shell/journal.mjs';
import { parseTimeoutMs } from '../../shell/util.mjs';
import { readLife } from '../../shell/life.mjs';

//   resume              close the pause: retry counters reset, ESCALATION.md removed
//   resume --takeover   release the owner session: for a while (OMC_LOOP_STALE_MS) the next
//                       Stop in this project, whichever session it comes from, claims the
//                       loop from its current phase. The only way another session takes a
//                       loop over; nothing does it implicitly. A takeover of a loop that was
//                       NOT paused is a recovery, not a pause closing: the retry budget and
//                       the hand-off note are kept.
export function run({ argv, cwd, env = process.env }) {
  const paths = gate(cwd);
  const s = requireState(paths);
  const takeover = argv.includes('--takeover');
  const staleMs = parseTimeoutMs(env.OMC_LOOP_STALE_MS, DEFAULT_STALE_MS);
  const closingPause = s.signals.paused === true;
  if (closingPause) s.signals.resumedAt = Date.now(); // the next fire marks the gap as a pause
  s.signals.paused = false;
  s.flags.repeated = false;
  if (closingPause || !takeover) {
    s.counters.retries = 0;
    s.counters.finalFails = 0;
  }
  if (takeover && s.owner.sessionId) {
    const from = s.owner.sessionId;
    s.owner.releasedFrom = from;
    s.owner.sessionId = null;
    appendJournal(paths.gateDir, { type: 'session', event: 'released', from: from.slice(0, 8), ageMs: s.owner.lastFireAt > 0 ? Math.max(0, Date.now() - s.owner.lastFireAt) : null });
  }
  if (takeover && s.owner.releasedFrom) s.owner.releasedAt = Date.now(); // (re)opens the window
  saveState(paths, s);
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
