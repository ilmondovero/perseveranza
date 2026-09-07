// The activity record: .omc-loop/activity.json, the loop's heartbeat INSIDE a turn.
// Written by the activity hook (PreToolUse on Agent, PostToolUse on the working tools,
// SubagentStop), read by everything that measures silence. Its own file, not state.json:
// it is written at tool-call rate and must never race the Stop hook or the verbs.
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeActivity } from '../core/staleness.mjs';

export const ACTIVITY_FILE = 'activity.json';
// PostToolUse fires at every tool call: one write per 30 s is plenty for a heartbeat.
export const ACTIVITY_THROTTLE_MS = 30 * 1000;

export function activityPath(gateDir) { return join(gateDir, ACTIVITY_FILE); }

export function readActivity(gateDir) {
  try { return normalizeActivity(JSON.parse(readFileSync(activityPath(gateDir), 'utf8'))); } catch { return null; }
}

// Atomic-ish: a temp file (named by pid: concurrent hooks never share one) renamed over
// the target, so a reader never sees a torn JSON. When the rename is refused (a sync client
// holding the target open, the Windows/Drive case archive.mjs defends against too) the text
// is written in place and the temp file is removed.
export function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
    return true;
  } catch {
    try { writeFileSync(path, text); } catch { /* best-effort */ }
    try { unlinkSync(tmp); } catch { /* already gone */ }
    return false;
  }
}

export function writeActivity(gateDir, rec) {
  return writeAtomic(activityPath(gateDir), JSON.stringify(rec));
}
