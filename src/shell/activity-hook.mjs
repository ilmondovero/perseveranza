#!/usr/bin/env node
// The activity hook: PreToolUse (Agent), PostToolUse (working tools) and SubagentStop.
// The Stop hook sees the loop only between turns; this one sees it DURING a turn, so a
// review delegated at 11:10 and never returned is visible as such, in real time, instead
// of looking like a session that simply died. It writes .omc-loop/activity.json (throttled)
// and journals delegations and subagent returns. DORMANT without state.json; silent for a
// session that does not own the loop; never throws, always exits 0, and does the dormant
// check before importing anything beyond the filesystem: it runs at tool-call rate in every
// project. It prints exactly one thing, ever: a PreToolUse deny while the loop is being
// reconciled after a kill-and-restore (signals.interrupted), when the tool would mutate.
// Prompt instructions alone do not make an agent read-only; a refused tool does.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const GATE = '.omc-loop';

// Commands a reconciling session may run: inspection only. EVERY segment of the command
// (split on pipes, newlines, `&` and `;`) must be an inspection command or a pure filter;
// redirection and substitution outside quotes are refused. `git branch` only as a listing
// (a name would create one); no `find` (its actions delete and execute); no scriptblocks.
const READ_ONLY_CMD = /^\s*(git\s+(status|diff|log|show|rev-parse|stash\s+list|ls-files|blame)\b|git\s+branch(\s+(-a|-r|-v|-vv|-l|--all|--list|--show-current|--contains\s+\S+))*\s*$|ls\b|dir\b|cat\b|type\b|head\b|tail\b|wc\b|grep\b|rg\b|awk\b|sed\s+-n\b|tasklist\b|ps\b|pwd\b|echo\b|Get-(Process|ChildItem|Content|CimInstance|Location|Item)\b|node\s+("[^"]*omc-loop\.mjs"|\S*omc-loop\.mjs)\s+(status|history|explain|runs|pause|disarm)\b)/i;
const FILTER_CMD = /^\s*(grep|rg|findstr|head|tail|sort|uniq|wc|cut|awk|sed\s+-n|Select-String|Select-Object|Sort-Object|Format-List|Format-Table|Measure-Object|Out-String)\b/i;
const CMD_UNSAFE = /[<>]|`|\$\(|\$\{|\btee\b|-delete\b|-exec\b|-execdir\b|-ok\b|\{[^}]*\}/;
const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task']);
const RECONCILE_FILE = /[\\/]\.omc-loop[\\/]reconcile\.json$|^\.omc-loop[\\/]reconcile\.json$/;

// -> the reason to refuse, or null when the tool may run. Pure: unit-tested directly.
export function reconcileDecision(tool, input) {
  const file = String((input && (input.file_path || input.path || input.notebook_path)) || '').trim();
  if ((tool === 'Write' || tool === 'Edit') && RECONCILE_FILE.test(file)) return null; // the one write the reconciliation exists to produce
  if (MUTATING_TOOLS.has(tool)) return `perseveranza: the loop is being reconciled after a restore; ${tool} is refused until .omc-loop/reconcile.json is written (that file is the only write allowed). Inspect read-only (git status/diff/log, plan, notes, process table), write the file, stop.`;
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = String(input && input.command || '');
    const unquoted = cmd.replace(/"[^"]*"|'[^']*'/g, '""'); // a `<` inside a git format string is not a redirection
    const segments = cmd.split(/\|{1,2}|&{1,2}|;|\r?\n/);
    const ok = !CMD_UNSAFE.test(unquoted) && segments.every((seg, i) => (i === 0 ? READ_ONLY_CMD.test(seg) : READ_ONLY_CMD.test(seg) || FILTER_CMD.test(seg)));
    if (!ok) return `perseveranza: the loop is being reconciled after a restore; only read-only commands run until .omc-loop/reconcile.json is written (git status/diff/log/show/blame, ls, cat, grep, tasklist/ps, the status/history verbs, piped into filters). This command is refused.`;
  }
  return null;
}

function main() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  let evt = null;
  try { evt = raw ? JSON.parse(raw) : null; } catch { /* malformed */ }
  const cwd = evt && typeof evt.cwd === 'string' && evt.cwd ? evt.cwd : process.cwd();
  const gateDir = join(cwd, GATE);
  if (!existsSync(join(gateDir, 'state.json'))) return null;
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
  if (owner && owner !== session) return null; // another session's tools (or no session at all): not this loop's life
  const kind = evt && typeof evt.hook_event_name === 'string' ? evt.hook_event_name : '';
  const tool = evt && typeof evt.tool_name === 'string' ? evt.tool_name : '';
  const isAgentTool = tool === 'Agent' || tool === 'Task';
  const input = evt && evt.tool_input && typeof evt.tool_input === 'object' ? evt.tool_input : {};
  if (kind === 'PreToolUse' && state.signals.interrupted) {
    const why = reconcileDecision(tool, input);
    if (why) {
      // the deny is built first and returned whatever else fails: a journaling error must not
      // turn into a permission
      const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } });
      try { appendJournal(gateDir, { type: 'activity', event: 'refused', tool, session: session.slice(0, 8), why: 'reconciling' }); } catch { /* the deny still goes out */ }
      return deny;
    }
  }
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
    if (!isAgentTool) return null;
    const agent = name(input.subagent_type || input.name || input.description);
    pending.push({ at: now, agent });
    act.writeActivity(gateDir, { ...base, event: 'delegate', agent });
    appendJournal(gateDir, { type: 'activity', event: 'delegate', agent, session: session.slice(0, 8), pending: pending.length });
    return null;
  }
  if (kind === 'SubagentStop') {
    const named = evt && (evt.agent_type || evt.subagent_type) ? name(evt.agent_type || evt.subagent_type) : '';
    const done = settle(named);
    const agent = named || (done ? done.agent : 'subagent');
    act.writeActivity(gateDir, { ...base, event: 'subagent-stop', agent });
    appendJournal(gateDir, { type: 'activity', event: 'subagent-stop', agent, session: session.slice(0, 8), pending: pending.length });
    return null;
  }
  // PostToolUse: the heartbeat. A returned Agent call closes its delegation (the oldest).
  if (isAgentTool) settle(name(input.subagent_type || input.name || input.description));
  else if (prev && now - prev.at < act.ACTIVITY_THROTTLE_MS) return null;
  act.writeActivity(gateDir, { ...base, event: 'tool' });
  return null;
}

function isMainModule() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] || '.')).href; }
  catch { return false; }
}

if (isMainModule()) {
  Promise.resolve().then(main).catch(() => null).then((out) => {
    // the deny must reach Claude Code whole: flush before exiting
    if (out) process.stdout.write(out, () => process.exit(0));
    else process.exit(0);
  });
}
