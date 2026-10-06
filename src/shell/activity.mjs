// The activity record: .perseveranza/activity.json, the loop's heartbeat INSIDE a turn.
// Written by the activity hook (PreToolUse on Agent, PostToolUse on the working tools,
// SubagentStop), read by everything that measures silence. Its own file, not state.json:
// it is written at tool-call rate and must never race the Stop hook or the verbs.
import { readFileSync } from 'node:fs';
import { writeDurable } from './state-file.mjs';
import { join } from 'node:path';
import { normalizeActivity } from '../core/staleness.mjs';

export const ACTIVITY_FILE = 'activity.json';
// PostToolUse fires at every tool call: one write per 30 s is plenty for a heartbeat.
export const ACTIVITY_THROTTLE_MS = 30 * 1000;

export function activityPath(gateDir) { return join(gateDir, ACTIVITY_FILE); }

export function readActivity(gateDir) {
  try { return normalizeActivity(JSON.parse(readFileSync(activityPath(gateDir), 'utf8'))); } catch { return null; }
}

// Every state file goes through writeDurable (state-file.mjs): a temporary read back, the
// rename retried, in place only with a complete temporary. A failed write never empties the
// target. -> { ok, atomic, error } (ok: the text is in the file; atomic: by the rename)
export function writeFileResult(path, text, opts = {}) {
  return writeDurable(path, text, opts);
}

// true only when the rename made it (the callers that only need a best-effort write ignore it)
export function writeAtomic(path, text) {
  return writeDurable(path, text).atomic;
}

export function writeActivity(gateDir, rec) {
  return writeAtomic(activityPath(gateDir), JSON.stringify(rec));
}
