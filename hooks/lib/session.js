// The start of a session.
//   session.start (once per process, before the first prompt): the Claude Code version the mod
//     runs on. One older than MIN_CLAUDE_CODE (or unreadable) is said under the prompt
//     ($.ui.status) and, where a loop is armed, in the journal (mod-start), which `status` shows.
//     A loop armed later gets the line at its first stop.
//   classic.SessionStart (startup, resume, clear, compact): the notice of session-start.mjs for
//     a loop this session does not own (or for the owner after a compaction), as additional
//     context. Not prompt.context: that event has neither the session id nor the source, and the
//     classic event's additionalContext reaches the model (verified on 2.1.289).
//   Both also leave the mod's sign of life for `arm` (verbs.js writeAlive: a /clear or a resume
//     brings a new session id, and classic.SessionStart has it), and session.start registers the
//     `perseveranza` tool and the /pf command (registered there, they are listed from the first
//     turn); at most once per process it also has the old signs of life pruned (pruneAliveIfNeeded).
// Both fail-open: nothing they do may hold a session back. A tool that could not be registered
// leaves the loop's instructions in the shell's words (the stop says loopMode 'shell').
import { QUICK_TIMEOUT_MS, MAX_HELLO_TRIES, OWN_TOOL, isObj, versionCheck, errText } from './core.js';
import { call, hasGate, skipped } from './gate.js';
import { TOOL_NAME, COMMAND_NAME, toolSchema, toolDescription, cliCommand, writeAlive, pruneAliveIfNeeded } from './verbs.js';

export const COMMAND_SPEC = {
  name: COMMAND_NAME,
  description: 'perseveranza loop verbs, run now: status, arm, disarm, report, claim-done, pause, resume, test, ask... (/perseveranza <task> starts a task)',
  argumentHint: '<verb> [args]: status | arm "<task>" [flags] | disarm | resume [--takeover] | help',
  // status and disarm must answer while Claude works (a runaway loop is stopped mid-turn); the
  // flag is the command's, not a verb's: every verb runs at once, as the user typed it
  immediate: true,
};

// The tool for Claude and the command for the user. Each registration on its own: a failure of
// one (a name taken, an older Claude Code) leaves the other, and is said in the debug log.
export async function registerVerbs(io, mod) {
  try { mod.pluginName = String((await io.pluginName()) || ''); } catch { /* '' */ }
  let root = '';
  try { root = io.root(); } catch { /* the description names the CLI without it */ }
  try {
    const r = await io.registerTool({ name: TOOL_NAME, description: toolDescription(cliCommand(root || '<perseveranza>')), inputSchema: toolSchema() });
    mod.toolName = r && typeof r.tool === 'string' && r.tool ? r.tool : OWN_TOOL;
  } catch (err) {
    mod.toolName = null;
    try { await io.log(`perseveranza: the perseveranza tool could not be registered (${errText(err)}): the loop's instructions name the CLI`); } catch { /* best effort */ }
  }
  try {
    const c = await io.registerCommand(COMMAND_SPEC);
    mod.commandName = c && typeof c.command === 'string' ? c.command : COMMAND_NAME;
  } catch (err) {
    mod.commandName = null;
    try { await io.log(`perseveranza: /${COMMAND_NAME} could not be registered (${errText(err)}): the CLI runs the verbs`); } catch { /* best effort */ }
  }
}

// how the instructions may name the verbs in this process: the tool, once registered
export const loopModeOf = (mod) => (mod.toolName ? 'tool' : 'shell');

export async function checkVersion(io, mod) {
  let v = null;
  try { v = await io.version(); } catch { /* unreadable: said as such */ }
  mod.hello = versionCheck(v);
  if (!mod.hello.ok) {
    try { await io.status(`perseveranza: Claude Code ${mod.hello.claudeCode} - ${mod.hello.problem}`); } catch { /* best effort */ }
  }
  return mod.hello;
}

// The mod-start line, once per process, in the journal of the loop in cwd (none yet: the first
// stop of a live loop sends it). At most MAX_HELLO_TRIES tries per process.
// The session goes with it: the bridge journals only for the loop's owner (op 'journal').
export async function sendHello(io, mod, cwd, session = '') {
  if (mod.helloSent || mod.helloTries >= MAX_HELLO_TRIES) return mod.helloSent;
  mod.helloTries += 1;
  if (!mod.hello) await checkVersion(io, mod);
  const r = await call(io, mod, 'journal', { cwd, event: { session_id: typeof session === 'string' ? session : '' }, facts: { lines: [{ type: 'mod-start', ...mod.hello }] }, timeoutMs: QUICK_TIMEOUT_MS });
  if (r.answer && r.answer.ok === true && r.answer.journaled > 0) mod.helloSent = true;
  return mod.helloSent;
}

export async function onSessionStart(io, mod, e) {
  await checkVersion(io, mod);
  await registerVerbs(io, mod);
  const cwd = isObj(e) && typeof e.cwd === 'string' ? e.cwd : '';
  let session = isObj(e) && typeof e.session_id === 'string' ? e.session_id : '';
  if (!session) { try { session = (await io.sessionId()) || ''; } catch { /* '' */ } }
  if (await writeAlive(io, mod, session, cwd)) await pruneAliveIfNeeded(io, mod, session, cwd);
  if (!(await hasGate(io, cwd, false))) return;
  await sendHello(io, mod, cwd, session);
}

// -> the notice, or null
export async function sessionNotice(io, mod, e) {
  if (!isObj(e)) return null;
  if (typeof e.transcript_path === 'string' && e.transcript_path) mod.transcript = e.transcript_path;
  const cwd = typeof e.cwd === 'string' ? e.cwd : '';
  // the id of this session as Bash will see it (CLAUDE_CODE_SESSION_ID): after a /clear, a new one
  if (typeof e.session_id === 'string' && e.session_id) await writeAlive(io, mod, e.session_id, cwd);
  if (!(await hasGate(io, cwd, false))) return null;
  const r = await call(io, mod, 'session-start', { cwd, event: e, facts: { loopMode: loopModeOf(mod) }, timeoutMs: QUICK_TIMEOUT_MS });
  if (!r.answer || r.answer.ok !== true) {
    await skipped(io, mod, cwd, 'classic.SessionStart', r.error || String(r.answer && r.answer.error));
    return null;
  }
  return typeof r.answer.context === 'string' && r.answer.context ? r.answer.context : null;
}
