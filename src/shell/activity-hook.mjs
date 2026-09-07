#!/usr/bin/env node
// The activity hook: PreToolUse (Agent), PostToolUse (working tools) and SubagentStop.
// The Stop hook sees the loop only between turns; this one sees it DURING a turn, so a
// review delegated at 11:10 and never returned is visible as such, in real time, instead
// of looking like a session that simply died. It writes .omc-loop/activity.json (throttled)
// and journals delegations and subagent returns. DORMANT without state.json; silent for a
// session that does not own the loop; never throws, never prints, always exits 0, and does
// the dormant check before importing anything beyond the filesystem: it runs at tool-call
// rate in every project.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const GATE = '.omc-loop';

function main() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  let evt = null;
  try { evt = raw ? JSON.parse(raw) : null; } catch { /* malformed */ }
  const cwd = evt && typeof evt.cwd === 'string' && evt.cwd ? evt.cwd : process.cwd();
  const gateDir = join(cwd, GATE);
  if (!existsSync(join(gateDir, 'state.json'))) return;
  return armed(evt, gateDir);
}

async function armed(evt, gateDir) {
  const [{ loadState }, act, { appendJournal }] = await Promise.all([
    import('../core/state.mjs'), import('./activity.mjs'), import('./journal.mjs'),
  ]);
  let state = null;
  try { state = loadState(JSON.parse(readFileSync(join(gateDir, 'state.json'), 'utf8'))).state; } catch { /* unreadable */ }
  if (!state) return;
  const session = evt && typeof evt.session_id === 'string' ? evt.session_id : '';
  const owner = state.owner.sessionId;
  if (owner && session && owner !== session) return; // another session's tools: not this loop's life
  const kind = evt && typeof evt.hook_event_name === 'string' ? evt.hook_event_name : '';
  const tool = evt && typeof evt.tool_name === 'string' ? evt.tool_name : '';
  const isAgentTool = tool === 'Agent' || tool === 'Task';
  const input = evt && evt.tool_input && typeof evt.tool_input === 'object' ? evt.tool_input : {};
  const now = Date.now();
  const prev = act.readActivity(gateDir);
  const name = (v) => String(v || 'subagent').slice(0, 120); // a description can be a whole prompt
  // pending: the subagents launched and not back yet, oldest first (parallel delegations
  // are the house pattern: one slot would lose all but the last)
  const pending = prev ? prev.pending.slice() : [];
  const transcript = evt && typeof evt.transcript_path === 'string' ? evt.transcript_path : (prev ? prev.transcript : '');
  const base = { at: now, session, event: 'tool', tool, agent: '', pending, transcript };
  // the one that came back: by name if known, else the oldest
  const settle = (agent) => {
    const i = agent ? pending.findIndex((d) => d.agent === agent) : -1;
    if (i >= 0) return pending.splice(i, 1)[0];
    return pending.shift() || null;
  };

  if (kind === 'PreToolUse') {
    if (!isAgentTool) return;
    const agent = name(input.subagent_type || input.name || input.description);
    pending.push({ at: now, agent });
    act.writeActivity(gateDir, { ...base, event: 'delegate', agent });
    appendJournal(gateDir, { type: 'activity', event: 'delegate', agent, session: session.slice(0, 8), pending: pending.length });
    return;
  }
  if (kind === 'SubagentStop') {
    const named = evt && (evt.agent_type || evt.subagent_type) ? name(evt.agent_type || evt.subagent_type) : '';
    const done = settle(named);
    const agent = named || (done ? done.agent : 'subagent');
    act.writeActivity(gateDir, { ...base, event: 'subagent-stop', agent });
    appendJournal(gateDir, { type: 'activity', event: 'subagent-stop', agent, session: session.slice(0, 8), pending: pending.length });
    return;
  }
  // PostToolUse: the heartbeat. A returned Agent call closes its delegation (the oldest).
  if (isAgentTool) settle(name(input.subagent_type || input.name || input.description));
  else if (prev && now - prev.at < act.ACTIVITY_THROTTLE_MS) return;
  act.writeActivity(gateDir, { ...base, event: 'tool' });
}

Promise.resolve().then(main).catch(() => { /* never break a tool call */ }).finally(() => process.exit(0));
