// The signs of life of a loop, read from disk: the activity record of the turn and the
// last write to the session transcript (and to the transcripts of its subagents, which
// live in <transcript dir>/<session id>/subagents/). One reader for every surface that
// measures silence: status, HUD, disarm, resume, SessionStart, the watchdog, the Stop hook.
import { statSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { readActivity } from './activity.mjs';

const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };

// Latest write among the transcript and the subagent transcripts of the session. 0 if unknown.
export function transcriptAt(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return 0;
  let at = mtime(transcriptPath);
  const sub = join(dirname(transcriptPath), basename(transcriptPath).replace(/\.jsonl$/, ''), 'subagents');
  try {
    for (const f of readdirSync(sub)) if (f.endsWith('.jsonl')) at = Math.max(at, mtime(join(sub, f)));
  } catch { /* no subagents */ }
  return at;
}

// -> { activity, transcriptAt }: what lastSeen() needs beside the state.
export function readLife(gateDir, state) {
  const activity = readActivity(gateDir);
  const owner = state && state.owner ? state.owner : {};
  // the activity record's transcript is a fallback only when it is the owner's (or nobody's yet)
  const fromActivity = activity && activity.transcript && (!owner.sessionId || !activity.session || activity.session === owner.sessionId) ? activity.transcript : '';
  const path = owner.transcriptPath || fromActivity;
  return { activity, transcriptAt: transcriptAt(path) };
}
