// The loop's verbs from the mod: a typed tool for Claude (mcp__perseveranza__perseveranza) and
// the /pf command for the user. Neither reimplements a verb: both run the CLI
// (src/cli/perseveranza.mjs) with $.process.run, an argument list and no shell, in the
// session's own folder, so a verb has the same code, effects and tests whichever way it
// comes. The CLI journals the way it came (PERSEVERANZA_VIA: `via: 'tool'` or 'command').
//
// The tool, for Claude. A mod's tool runs without a permission prompt, so it runs NOTHING the
// user's Bash permissions would govern: only the verbs that read or move the loop's own state
// (TOOL_VERBS), on a loop of this session (or one no session claimed yet):
//   - `test` (it runs the suite, a shell command) and `ask` (it starts an external agent CLI)
//     are refused: they stay shell commands, run with Bash, where the user's permissions decide;
//   - arm, disarm and a takeover (resume --takeover) are the user's: /pf, or the CLI when the
//     user asks; the tool refuses them, and so does the CLI for a run that says via=tool;
//   - a loop owned by another session: every verb that changes something is refused (taking
//     a loop over is the user's /pf resume --takeover);
//   - its arguments are checked HERE, before any process starts: a closed list of verbs and of
//     arguments, each with its type and its values (Claude Code does not enforce the schema: on
//     2.1.289 a verb outside the enum and an extra argument reached the hook). The words of a
//     loop instruction go as they are ({"verb": "report", "args": "pass"}) or as typed fields
//     ({"verb": "report", "outcome": "pass"}): both read the same way, and disagreeing is an error;
//   - no loop armed in this folder (the bridge's rule, gate.js hasGate): every verb but
//     `status` is refused with the reason, and no node process starts;
//   - no argument is a path: the verb runs in the session's folder and nowhere else;
//   - what it answers is the verb's output, cut to MAX_OUTPUT, with the exit code said in words;
//     a refusal or a failure to start is an error result ({ deny }), never a throw: a broken
//     tool does not break the session, and the CLI stays the named fallback.
// The command, for the user: `/pf <verb> [args]`, the tool's verbs plus arm, disarm, test, ask,
// a takeover and runs; its words split like a shell would split them (quotes) but never given
// to one; a verb that takes no words refuses extra ones (`/pf disarm the alarm` disarms
// nothing). Claude cannot run it (Claude Code refuses a mod's command from the Skill tool:
// "a built-in CLI command, not a skill"), and the verbs that start something or end a loop
// run only for what the user typed (origin composer, bridge or sdk), never for another plugin.
// (Named /pf, not /perseveranza: a registered command replaces the markdown command of the
// same name, and `/perseveranza <task>` stays the markdown one that starts a task.)
import { COMPLEXITIES } from '../../src/core/state.mjs';
import { isObj, errText, READ_ONLY_VERBS } from './core.js';
import { hasGate, setup, readOwner } from './gate.js';
import { toolInput, askGuard } from './tool.js';
import { noteTool, scheduleActivity } from './activity.js';

export const TOOL_NAME = 'perseveranza';
export const COMMAND_NAME = 'pf';
// the verbs Claude may run through the tool: the loop's own state, nothing else
export const TOOL_VERBS = ['status', 'history', 'explain', 'report', 'complexity', 'claim-done', 'pause', 'resume'];
// the verbs that run something the user's Bash permissions govern: never through the tool
export const SHELL_VERBS = ['test', 'ask'];
// the user's: arm and disarm (and a takeover, an argument of resume)
export const USER_VERBS = ['arm', 'disarm'];
// the verbs /pf runs (the user's): the tool's, the shell's, arm and disarm, the archive
export const COMMAND_VERBS = [...TOOL_VERBS, ...SHELL_VERBS, ...USER_VERBS, 'runs'];
// the verbs of the command that act on an armed loop (refused without one, like the tool's)
export const GATED_COMMAND_VERBS = ['report', 'complexity', 'claim-done', 'pause', 'resume', 'test', 'ask'];
// where a run of /pf comes from (command.run's e.origin.kind) when the user typed it: Enter at
// the prompt, the Remote Control bridge, the host of `claude -p`. Another plugin's
// $.command.run reads 'plugin', and the verbs below are not run for it.
export const USER_ORIGINS = ['composer', 'bridge', 'sdk'];
export const ORIGIN_VERBS = ['arm', 'disarm', 'test', 'ask'];
export const MAX_ARGS = 200;
export const MAX_TAIL = 500;
export const MAX_OUTPUT = 20000;
export const MAX_COMMAND_ARGS = 8000;
export const MAX_TOKENS = 64;
// $.process.run allows ten minutes at most: a suite or a provider longer than that is killed
export const LONG_TIMEOUT_MS = 600000;
export const VERB_TIMEOUT_MS = 60000;
export const ARM_TIMEOUT_MS = 180000;

// The tool's typed arguments: the verb each belongs to and its JSON schema. `args` (the words
// after the verb, as a loop instruction writes them) is the other way to say the same.
export const TOOL_ARGS = {
  args: { verbs: TOOL_VERBS, schema: { type: 'string', maxLength: MAX_ARGS, description: 'the words after the verb in the loop instruction, as written: "pass" for `report pass`, "low" for `complexity low`, "--tail 20" for `history --tail 20`; leave it out when the verb has none' } },
  outcome: { verbs: ['report'], schema: { type: 'string', enum: ['pass', 'fail'], description: 'report: the outcome (the same as args "pass" or "fail")' } },
  level: { verbs: ['complexity'], schema: { type: 'string', enum: [...COMPLEXITIES], description: 'complexity: the task complexity (the same as args "low", "medium" or "high")' } },
  tail: { verbs: ['history'], schema: { type: 'integer', minimum: 1, maximum: MAX_TAIL, description: 'history: only the last N entries (the same as args "--tail N")' } },
};

export function toolSchema() {
  const properties = { verb: { type: 'string', enum: TOOL_VERBS, description: 'the verb: the first word after "the `perseveranza` tool" in a loop instruction' } };
  for (const [k, a] of Object.entries(TOOL_ARGS)) properties[k] = a.schema;
  return { type: 'object', properties, required: ['verb'], additionalProperties: false };
}

// What Claude reads about the tool: the exact forms, and what it does not do.
export function toolDescription(cli) {
  return [
    'The verbs of the perseveranza loop armed in this project (.perseveranza/), for the instructions that say "the `perseveranza` tool": the first word is "verb", the words after it go whole in "args".',
    'Exactly: `report pass` -> {"verb": "report", "args": "pass"}; `report fail` -> {"verb": "report", "args": "fail"}; `complexity low` -> {"verb": "complexity", "args": "low"}; `claim-done` -> {"verb": "claim-done"}; `pause`, `resume`, `status`, `explain` -> {"verb": "<it>"}; `history --tail 20` -> {"verb": "history", "args": "--tail 20"}.',
    'It answers with the verb\'s output and its exit code; a verb that refuses (claim-done without a green test, a verb without an armed loop) says why.',
    `It does NOT run the suite (test) or an external model (ask): those are shell commands, run with Bash: ${cli} test --if-needed -- <the suite>, ${cli} ask <provider> <slot> -- "<prompt>".`,
    'arm, disarm and taking over a loop of another session (resume --takeover) are the user\'s: they type /pf arm|disarm|resume --takeover.',
    `Only if this tool is missing or cannot start, run the same verb as a shell command: ${cli} <verb> <args>.`,
  ].join(' ');
}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const NUMBER = /^\d{1,6}$/;

function asInt(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && NUMBER.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isInteger(n) ? n : null;
}

// A run's id as `runs list` prints it, <project>/<stamp>, or the stamp alone: each part the
// archive's own characters (archive.mjs safe(): letters, digits, '.', '_', '-'), not starting
// with a dot (so never '.' or '..'), one '/' at most, never '\', ':' or a leading '/'. The CLI
// only looks the id up among the listed runs; this keeps the words of /pf to what it can match.
const RUN_PART = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/;
export function isRunId(id) {
  if (typeof id !== 'string') return false;
  const parts = id.split('/');
  return parts.length <= 2 && parts.every((p) => RUN_PART.test(p));
}

// The words of a verb that takes few -> { argv } | { error }. Pure. Used by the tool (every verb
// it runs) and by /pf (every verb but arm, test and ask, whose words are the CLI's to check).
//   opts.user: the user's command (resume --takeover and disarm --no-archive are allowed)
export function verbArgs(verb, tokens, opts = {}) {
  const t = Array.isArray(tokens) ? tokens : [];
  const none = (allowed = []) => (t.every((w) => allowed.includes(w)) && new Set(t).size === t.length ? { argv: [verb, ...t] } : { error: `${verb} takes ${allowed.length ? `only ${allowed.join(', ')}` : 'no words'} (given: ${t.join(' ').slice(0, 80)})` });
  switch (verb) {
    case 'status': return none(['--json']);
    case 'explain': return none(['--markdown']);
    case 'claim-done': case 'pause': return none();
    case 'resume': return none(opts.user ? ['--takeover'] : []);
    case 'disarm': return none(['--no-archive']);
    case 'report':
      return t.length === 1 && ['pass', 'fail'].includes(t[0]) ? { argv: ['report', t[0]] } : { error: 'report takes one word: pass or fail' };
    case 'complexity':
      return t.length === 1 && COMPLEXITIES.includes(t[0]) ? { argv: ['complexity', t[0]] } : { error: `complexity takes one word: ${COMPLEXITIES.join(', ')}` };
    case 'history': {
      const argv = ['history'];
      let tail = false;
      let json = false;
      for (let i = 0; i < t.length; i++) {
        const w = t[i];
        const n = w === '--tail' ? asInt(t[++i]) : NUMBER.test(w) && !opts.user ? asInt(w) : null;
        if ((w === '--tail' || NUMBER.test(w)) && n !== null && !tail) {
          if (n < 1 || n > MAX_TAIL) return { error: `history: the tail must be a whole number from 1 to ${MAX_TAIL}` };
          argv.push('--tail', String(n));
          tail = true;
        } else if (w === '--json' && !json) { argv.push('--json'); json = true; } else return { error: `history takes --tail N and --json (given: ${t.join(' ').slice(0, 80)})` };
      }
      return { argv };
    }
    case 'runs': {
      if (t.length === 0 || (t.length === 1 && t[0] === 'list')) return { argv: ['runs', ...t] };
      if (t[0] === 'show' && isRunId(t[1]) && (t.length === 2 || (t.length === 3 && t[2] === '--all'))) return { argv: ['runs', ...t] };
      return { error: 'runs takes: list | show <id> [--all]' };
    }
    default: return { error: `unknown verb "${String(verb).slice(0, 40)}"` };
  }
}

// The tool's input (tool.call's event) -> { verb, argv } | { error, shell?, user? }. Pure.
export function validateToolInput(e) {
  if (!isObj(e)) return { error: 'the input is not an object' };
  const input = toolInput(e);
  if (typeof input.verb !== 'string' || !input.verb.trim()) return { error: `"verb" is missing: one of ${TOOL_VERBS.join(', ')}` };
  // "report pass" in the verb: the first word is the verb, the rest its words
  const head = splitArgs(input.verb);
  if (head.error) return { error: `"verb": ${head.error}` };
  const [verb, ...inVerb] = head.tokens;
  if (SHELL_VERBS.includes(verb)) return { error: `"${verb}" does not run through the perseveranza tool`, shell: verb };
  if (USER_VERBS.includes(verb)) return { error: `"${verb}" is the user's, not the tool's`, user: verb };
  if (!TOOL_VERBS.includes(verb)) return { error: `unknown verb "${verb.slice(0, 40)}": one of ${TOOL_VERBS.join(', ')}` };
  let tokens = inVerb;
  for (const k of Object.keys(input)) {
    if (k === 'verb') continue;
    // own keys only: "constructor" or "__proto__" is not an argument
    const spec = Object.prototype.hasOwnProperty.call(TOOL_ARGS, k) ? TOOL_ARGS[k] : null;
    if (k === 'takeover') return { error: 'a takeover is the user\'s', user: 'resume --takeover' };
    if (!spec) return { error: `unknown argument "${k.slice(0, 40)}" (the tool takes: verb, ${Object.keys(TOOL_ARGS).join(', ')})` };
    if (!spec.verbs.includes(verb)) return { error: `"${k}" is not an argument of ${verb}` };
  }
  if (input.args !== undefined && input.args !== null && input.args !== '') {
    if (typeof input.args !== 'string') return { error: '"args" must be a string (the words after the verb)' };
    if (input.args.length > MAX_ARGS) return { error: `"args" is longer than ${MAX_ARGS} characters` };
    const sp = splitArgs(input.args);
    if (sp.error) return { error: `"args": ${sp.error}` };
    tokens = [...tokens, ...sp.tokens];
  }
  if (verb === 'resume' && tokens.includes('--takeover')) return { error: 'a takeover is the user\'s', user: 'resume --takeover' };
  // a typed field says the same as the words, or is the only one to say it
  const typed = (k, word) => {
    if (input[k] === undefined) return null;
    if (tokens.length === 0) { tokens = word; return null; }
    return tokens.length === word.length && tokens.every((w, i) => w === word[i]) ? null : `"${k}" and the words disagree (${k}: ${String(input[k]).slice(0, 20)}, words: ${tokens.join(' ').slice(0, 60)})`;
  };
  if (input.outcome !== undefined && !['pass', 'fail'].includes(input.outcome)) return { error: '"outcome" must be one of pass, fail' };
  if (input.level !== undefined && !COMPLEXITIES.includes(input.level)) return { error: `"level" must be one of ${COMPLEXITIES.join(', ')}` };
  let conflict = null;
  if (input.outcome !== undefined) conflict = typed('outcome', [input.outcome]);
  if (input.level !== undefined) conflict = typed('level', [input.level]);
  if (input.tail !== undefined) {
    const n = asInt(input.tail);
    if (n === null || n < 1 || n > MAX_TAIL) return { error: `"tail" must be a whole number from 1 to ${MAX_TAIL}` };
    if (tokens.length) conflict = `"tail" and the words both say what to show (words: ${tokens.join(' ').slice(0, 60)})`;
    else tokens = ['--tail', String(n)];
  }
  if (conflict) return { error: conflict };
  const a = verbArgs(verb, tokens);
  return a.error ? { error: a.error } : { verb, argv: a.argv };
}

// A valid tool call -> what the CLI runs: { argv (after the CLI path), stdin, timeoutMs }. Pure.
export function toolRun({ argv }) {
  return { argv, stdin: '', timeoutMs: VERB_TIMEOUT_MS };
}

// The words after /pf, split as a shell would split them (double quotes with \" and \\,
// single quotes literal), never handed to one. -> { tokens } | { error }. Pure.
export function splitArgs(text) {
  const s = String(text ?? '');
  if (s.length > MAX_COMMAND_ARGS) return { error: `the arguments are longer than ${MAX_COMMAND_ARGS} characters` };
  if (CONTROL.test(s.replace(/[\r\n]/g, ' '))) return { error: 'the arguments hold control characters' };
  const tokens = [];
  let cur = '';
  let has = false;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null; else cur += c;
    } else if (quote === '"') {
      if (c === '\\' && (s[i + 1] === '"' || s[i + 1] === '\\')) { cur += s[i + 1]; i++; } else if (c === '"') quote = null; else cur += c;
    } else if (c === '"' || c === "'") { quote = c; has = true; } else if (/\s/.test(c)) {
      if (has) { tokens.push(cur); cur = ''; has = false; }
    } else { cur += c; has = true; }
  }
  if (quote) return { error: `a ${quote === '"' ? 'double' : 'single'} quote is not closed` };
  if (has) tokens.push(cur);
  if (tokens.length > MAX_TOKENS) return { error: `more than ${MAX_TOKENS} words` };
  return { tokens };
}

// /pf's words -> { verb, argv, stdin, timeoutMs } | { help } | { error }. Pure.
// arm, test and ask take the CLI's own words (the CLI checks them); every other verb is checked
// here, word by word (verbArgs): `/pf disarm the legacy alarm` disarms nothing.
export function commandRun(text) {
  const sp = splitArgs(text);
  if (sp.error) return { error: sp.error };
  const [verb = 'status', ...rest] = sp.tokens;
  if (verb === 'help' || verb === '--help' || verb === '-h') return { help: true };
  if (!COMMAND_VERBS.includes(verb)) return { error: `unknown verb "${verb.slice(0, 40)}"`, unknown: true };
  const timeoutMs = verb === 'test' || verb === 'ask' ? LONG_TIMEOUT_MS : verb === 'arm' ? ARM_TIMEOUT_MS : VERB_TIMEOUT_MS;
  if (verb === 'arm' || verb === 'test' || verb === 'ask') return { verb, argv: [verb, ...rest], stdin: '', timeoutMs };
  const a = verbArgs(verb, rest, { user: true });
  if (a.error) return { error: a.error };
  return { verb, argv: a.argv, stdin: '', timeoutMs };
}

export function commandHelp() {
  return [
    `/pf <verb> [args]: the perseveranza loop's verbs, run here and now (even while Claude is working).`,
    `  status | history [--tail N] [--json] | explain | runs [list | show <id>]`,
    `  arm "<task>" [--complexity low|medium|high] [--test "cmd"] [--max N] [--no-push] ... (the CLI's flags)   disarm [--no-archive]`,
    `  report pass|fail | complexity low|medium|high | claim-done | pause | resume [--takeover] | test [--if-needed] -- <cmd> | ask <provider> <slot> -- <prompt>`,
    `To start a task with Claude (it arms the loop and writes the plan): /perseveranza <task>.`,
  ].join('\n');
}

// The verb's run -> the text Claude (or the user) reads: the exit said in words, then the output,
// cut to MAX_OUTPUT (the head and the tail: a verdict is at its end).
export function formatRun(verb, r) {
  const code = Number.isInteger(r.exitCode) ? r.exitCode : 1;
  const out = [String(r.stdout || '').trimEnd(), r.stderr && String(r.stderr).trim() ? `[stderr]\n${String(r.stderr).trimEnd()}` : ''].filter(Boolean).join('\n');
  const head = `perseveranza ${verb}: ${code === 0 ? 'done' : 'FAILED or REFUSED'} (exit ${code})${r.isStdoutTruncated ? ' [output truncated by Claude Code]' : ''}`;
  return `${head}\n${cut(out, MAX_OUTPUT)}`.trimEnd();
}

export function cut(text, max) {
  const t = String(text || '');
  if (t.length <= max) return t;
  const keepHead = Math.floor(max / 5);
  const keepTail = max - keepHead;
  return `${t.slice(0, keepHead)}\n[... ${t.length - max} characters cut ...]\n${t.slice(-keepTail)}`;
}

// an exit code Claude Code can take (0..255); anything else, a failure
export const exitCodeOf = (r) => (Number.isInteger(r.exitCode) && r.exitCode >= 0 && r.exitCode <= 255 ? r.exitCode : 1);

export const cliPath = (root) => `${String(root).replace(/[\\/]+$/, '')}/src/cli/perseveranza.mjs`;
// the CLI as the fallback a loop instruction names
export const cliCommand = (root) => `node "${cliPath(root)}"`;

// One run of the CLI: [node, cli, ...argv], no shell. -> { exitCode, stdout, stderr } | { error }
export async function runCli(io, mod, cwd, run, via, extraEnv = {}) {
  try {
    await setup(io, mod);
    const r = await io.run([mod.node, cliPath(io.root()), ...run.argv], { cwd, env: { PERSEVERANZA_VIA: via, ...extraEnv }, stdin: run.stdin || '', timeoutMs: run.timeoutMs });
    if (!r || typeof r !== 'object') return { error: 'no result from the process' };
    return r;
  } catch (err) { return { error: errText(err) }; }
}

const noLoop = (cwd, verb) => `perseveranza: no loop is armed in ${cwd} (.perseveranza/state.json is missing), so there is nothing to ${verb}. Only status runs without one; the user arms a loop with /pf arm "<task>" or /perseveranza <task>.`;
const short = (id) => String(id || '').slice(0, 8) || 'unknown';

// The tool's refusals that name another way: the shell for test and ask, the user for the rest.
function toolRefusal(v, cli) {
  if (v.shell) return `perseveranza tool: "${v.shell}" does not run through this tool, which runs nothing the user's Bash permissions would govern. Run it as a shell command with Bash: ${cli} ${v.shell === 'test' ? 'test --if-needed -- <the suite>' : 'ask <provider> <slot> -- "<prompt>"'}. Nothing was run.`;
  if (v.user) return `perseveranza tool: ${v.user === 'resume --takeover' ? 'taking a loop over (resume --takeover)' : `"${v.user}"`} is the user's decision, not the tool's: ask the user to type /pf ${v.user}${v.user === 'resume --takeover' ? '' : ' ...'}. Nothing was run.`;
  return `perseveranza tool: ${v.error}. Nothing was run.`;
}

// tool.call of the tool -> { result } | { deny }. Never throws.
//   1. the arguments, checked here (nothing runs for a call that is not valid);
//   2. the gate: no loop armed, no process (status excepted);
//   3. for a verb that changes something: the loop must be this session's, or nobody's yet
//      (read with $.fs.read; unreadable: refused, the CLI with Bash stays);
//   4. the reconciliation guard of a restored loop (op 'tool-check'): the same rule as a Bash
//      call of the CLI; fail-open like the guard;
//   5. the verb, through the CLI; the call counts as the turn's activity (the heartbeat).
export async function serveTool(io, mod, e) {
  try {
    let cli = 'node <perseveranza>/src/cli/perseveranza.mjs';
    try { cli = cliCommand(io.root()); } catch { /* the placeholder */ }
    const v = validateToolInput(e);
    if (v.error) return { deny: toolRefusal(v, cli) };
    const cwd = await io.cwd();
    // the gate before any process: no loop, no node (status says so itself)
    if (v.verb !== 'status' && !(await hasGate(io, cwd, true))) return { deny: noLoop(cwd, v.verb) };
    let session = '';
    let now = 0;
    try { session = (await io.sessionId()) || ''; now = await io.now(); } catch { /* the record goes without them */ }
    // a call of this tool is a tool call of the session too: its sign of life kept fresh
    await refreshAlive(io, mod, session);
    if (!READ_ONLY_VERBS.includes(v.verb)) {
      const owner = await readOwner(io, cwd);
      if (owner === null) return { deny: `perseveranza tool: the loop's owner could not be read (.perseveranza/state.json), so ${v.verb} is not run through the tool. Run it as a shell command with Bash: ${cli} ${v.argv.join(' ')}. Nothing was run.` };
      if (owner && owner !== session) return { deny: `perseveranza tool: the loop in this folder belongs to session ${short(owner)}, not to this one (${short(session)}): the tool does not act on another session's loop. Do not touch .perseveranza/; if the user wants this session to take it over, they type /pf resume --takeover. Nothing was run.` };
      const why = await askGuard(io, mod, cwd, session, e.tool, { verb: v.verb });
      if (why) return { deny: why };
    }
    scheduleActivity(io, mod, noteTool(mod, e, now, session), now);
    const r = await runCli(io, mod, cwd, toolRun(v), 'tool');
    if (r.error) return { deny: `perseveranza tool: the ${v.verb} verb could not run (${r.error}). Run it as a shell command instead: ${cli} ${v.argv.join(' ')}` };
    return { result: formatRun(v.verb, r) };
  } catch (err) {
    return { deny: `perseveranza tool failed (${errText(err)}). Run the verb as a shell command instead: node <perseveranza>/src/cli/perseveranza.mjs <verb> ...` };
  }
}

// command.run of /pf -> { text, exitCode }. Never throws.
export async function serveCommand(io, mod, e) {
  try {
    const c = commandRun(isObj(e) ? e.args : '');
    if (c.help) return { text: commandHelp(), exitCode: 0 };
    if (c.error) return { text: `perseveranza: ${c.error}. Nothing was run.\n${commandHelp()}`, exitCode: 2 };
    // what starts something or ends a loop runs only for what the user typed
    const origin = isObj(e) && isObj(e.origin) && typeof e.origin.kind === 'string' ? e.origin.kind : '';
    const sensitive = ORIGIN_VERBS.includes(c.verb) || (c.verb === 'resume' && c.argv.includes('--takeover'));
    if (sensitive && !USER_ORIGINS.includes(origin)) return { text: `perseveranza: /pf ${c.verb} runs only when the user types it (this run came from ${origin ? `"${origin.slice(0, 40)}"` : 'an unknown origin'}). Nothing was run.`, exitCode: 1 };
    const cwd = await io.cwd();
    if (GATED_COMMAND_VERBS.includes(c.verb) && !(await hasGate(io, cwd, true))) return { text: noLoop(cwd, c.verb), exitCode: 1 };
    const extra = {};
    if (c.verb === 'arm') {
      // arm checks that the mod is alive in this session: it is (this is the mod), so its sign
      // of life is written first, and arm gets the session id Claude Code gives Bash
      let session = '';
      try { session = (await io.sessionId()) || ''; } catch { /* arm says what it misses */ }
      if (session) { await writeAlive(io, mod, session, cwd); extra.CLAUDE_CODE_SESSION_ID = session; }
    }
    const r = await runCli(io, mod, cwd, c, 'command', extra);
    if (r.error) return { text: `perseveranza: the ${c.verb} verb could not run (${r.error}). From a terminal: ${cliCommand(io.root())} ${c.verb} ...`, exitCode: 1 };
    return { text: formatRun(c.verb, r), exitCode: exitCodeOf(r) };
  } catch (err) {
    return { text: `perseveranza: the command failed (${errText(err)}).`, exitCode: 1 };
  }
}

// The mod's sign of life for `arm` (src/shell/mod-alive.mjs): <home>/mod-alive/<session>.json,
// home as Node's: PERSEVERANZA_HOME, else ~/.perseveranza (USERPROFILE, else HOME: the order of
// os.homedir() on Windows). Written with $.fs.write (no process); if that is refused, through
// the bridge. Only where the mod can drive a loop: $.process.run is "CLI only" (the types), and
// no call says whether this session has it, so the surface does (cliSurface). -> true when written.
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export async function aliveHome(io) {
  const get = async (f) => { try { const v = await f(); return typeof v === 'string' ? v.trim() : ''; } catch { return ''; } };
  const own = await get(io.perseveranzaHome);
  if (own) return own.replace(/[\\/]+$/, '');
  const base = (await get(io.userProfile)) || (await get(io.home));
  return base ? `${base.replace(/[\\/]+$/, '')}/.perseveranza` : '';
}

// Does this session run where $.process.run is? The CLI: `claude` draws on the terminal
// ($.session.surfaces() lists 'terminal' first), `claude -p` and the SDK draw nowhere (empty).
// A session drawn only by the Desktop app or the VS Code extension is not the CLI the types
// promise $.process.run to: no sign of life there, so `arm` keeps the CLI's words (shell mode).
// A surfaces() that fails says nothing: no sign of life either (arm refuses, --no-mod-check).
export async function cliSurface(io) {
  try {
    const s = await io.surfaces();
    return Array.isArray(s) && (s.length === 0 || s.includes('terminal'));
  } catch { return false; }
}

//   opts.bridge false: no fallback through the bridge (a refresh never starts a process)
export async function writeAlive(io, mod, session, cwd, opts = {}) {
  if (typeof session !== 'string' || !SESSION_ID_RE.test(session)) return false;
  if (!(await cliSurface(io))) {
    try { await io.log(`perseveranza: no sign of life for session ${session.slice(0, 8)}: this session is not drawn by the CLI (Desktop, VS Code), where the mod cannot run the loop; \`arm\` here keeps the CLI's words (--no-mod-check)`); } catch { /* best effort */ }
    return false;
  }
  let at = 0;
  try { at = await io.now(); } catch { /* 0 */ }
  const info = { session, at, claudeCode: mod.hello ? mod.hello.claudeCode : undefined, plugin: mod.pluginName || undefined, cwd: typeof cwd === 'string' ? cwd.slice(0, 300) : undefined };
  const home = await aliveHome(io);
  if (home) {
    try { await io.write(`${home}/mod-alive/${session}.json`, JSON.stringify(info)); mod.alive[session] = at; return true; } catch { /* the bridge below */ }
  }
  if (opts.bridge === false) return false;
  try {
    await setup(io, mod);
    const r = await io.run([mod.node, mod.bridge], { cwd: typeof cwd === 'string' && cwd ? cwd : undefined, stdin: JSON.stringify({ op: 'alive', cwd: cwd || '.', facts: info }), timeoutMs: 8000 });
    const a = JSON.parse(String(r.stdout || '').trim());
    if (a && a.ok === true) { mod.alive[session] = at; return true; }
  } catch { /* said below */ }
  try { await io.log(`perseveranza: could not write the sign of life of session ${session.slice(0, 8)}: \`arm\` in this session will refuse (--no-mod-check arms anyway)`); } catch { /* best effort */ }
  return false;
}

// The sign of life kept fresh while the session works: written at its start only, a long-lived
// session's file would grow older than every `claude -p` child started after it, and a prune by
// count would take it (seen by the verification of phase 3: a REPL session lost its file, and
// its `arm` refused). So every tool call of the session (the Bash call that runs `arm`
// included: the hook runs before the tool) rewrites it, at most once per ALIVE_REFRESH_MS, with
// $.fs.write only (no process). A prune never takes a file younger than a day (mod-alive.mjs),
// so a session that called a tool in the last day always has its file. Never throws.
export const ALIVE_REFRESH_MS = 10 * 60 * 1000;
export async function refreshAlive(io, mod, session) {
  try {
    if (typeof session !== 'string' || !SESSION_ID_RE.test(session)) return false;
    const now = await io.now();
    const last = mod.alive[session];
    if (typeof last === 'number' && now - last < ALIVE_REFRESH_MS) return false;
    // tried once per window, written or not (a Desktop session would log at every call)
    mod.alive[session] = now;
    let cwd;
    try { cwd = await io.cwd(); } catch { /* the file goes without it */ }
    return await writeAlive(io, mod, session, cwd, { bridge: false });
  } catch { return false; }
}

// The signs of life pile up (one per session, `claude -p` children included) and the mod cannot
// delete a file ($.fs has no unlink): at a session start it lists them ($.fs.list, no process)
// and, only past ALIVE_PRUNE_AT files or with one older than ALIVE_MAX_AGE_MS, asks the bridge
// to prune (op 'alive', facts.prune: its own files only, the newest ALIVE_KEEP and every file
// younger than ALIVE_PROTECT_MS kept, never this
// session's). Once per process. Never throws. -> true when the bridge was asked.
export const ALIVE_PRUNE_AT = 200;
export const ALIVE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
export async function pruneAliveIfNeeded(io, mod, session, cwd) {
  if (mod.alivePruned) return false;
  mod.alivePruned = true;
  try {
    const home = await aliveHome(io);
    if (!home) return false;
    const entries = await io.list(`${home}/mod-alive`);
    if (!Array.isArray(entries)) return false;
    let now = 0;
    try { now = await io.now(); } catch { return false; }
    const own = entries.filter((x) => isObj(x) && x.kind === 'file' && typeof x.name === 'string' && /\.json$/.test(x.name) && SESSION_ID_RE.test(x.name.slice(0, -5)));
    const old = own.some((x) => typeof x.mtimeMs === 'number' && x.mtimeMs > 0 && now - x.mtimeMs > ALIVE_MAX_AGE_MS);
    if (own.length <= ALIVE_PRUNE_AT && !old) return false;
    await setup(io, mod);
    await io.run([mod.node, mod.bridge], { cwd: typeof cwd === 'string' && cwd ? cwd : undefined, stdin: JSON.stringify({ op: 'alive', cwd: cwd || '.', facts: { prune: true, session } }), timeoutMs: 8000 });
    return true;
  } catch { return false; }
}
