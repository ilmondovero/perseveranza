#!/usr/bin/env node
// The verbs: how Claude (and you) talk to the loop. One file per verb in ./verbs/.
//
//   arm "<task>" [--max N] [--max-retries N] [--complexity low|medium|high] [--commit]
//                [--external off] [--test "cmd"] [--no-git-finish] [--no-push]
//                [--approve-plan] [--budget-tokens N] [--lang xx] [--force]
//                [--ignore <path>[,<path>]] (untracked files there are not the work)
//   test -- <command>          run the suite HERE and record the real exit code
//   report pass|fail           outcome of the current phase (review / final verification)
//   complexity low|medium|high task complexity (routes the models)
//   claim-done                 declare the project complete -> triggers the final verification
//   ask <provider> <slot> -- <prompt>   ask an external model, save the opinion
//   pause | resume [--takeover] suspend / resume the loop (--takeover: release the owner session)
//   status                     human-readable summary
//   history [--tail N] [--json] the run journal
//   explain [--markdown]       the transition table and the next possible outcomes
//   providers [list|check [id]] external providers and their liveness
//   runs [list|show <id>]      the archive of past runs
//   prompts validate [file] | keys | show <key>
//   config                     effective local configuration (never prints the key)
//   hud on|off|status          live statusline
//   disarm [--no-archive]      stop and remove the loop
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { VerbError } from './shared.mjs';
import { setJournalVia, JOURNAL_VIAS } from '../shell/journal.mjs';

export const VERBS = ['arm', 'test', 'report', 'complexity', 'claim-done', 'ask', 'pause', 'resume', 'status', 'history', 'explain', 'providers', 'runs', 'prompts', 'config', 'hud', 'disarm'];

// The verbs the mod's tool may run (hooks/lib/verbs.js TOOL_VERBS; a test keeps the lists
// equal). A run that says it came from the tool (PERSEVERANZA_VIA=tool) and asks for anything
// else is refused here too, as a second wall behind the mod's own check: the tool runs without
// a permission prompt, so it must not reach the suite (test), an external agent (ask), arm,
// disarm, resume (a pause waits for a human: a plan to approve, an escalation; a takeover is
// a resume too), or any verb that is not the loop's own state. Checked before the verb is
// known to exist: a run from the tool gets exit 2 for every verb outside the list.
export const TOOL_VIA_VERBS = ['status', 'history', 'explain', 'report', 'complexity', 'claim-done', 'pause'];
export function toolViaRefusal(via, verb, rest = []) {
  if (via !== 'tool') return null;
  if (TOOL_VIA_VERBS.includes(verb)) return null;
  const v = String(verb).slice(0, 40);
  const why = v === 'test' || v === 'ask' ? 'run it as a shell command with Bash.'
    : v === 'resume' ? (rest.includes('--takeover')
      ? 'taking a loop over (resume --takeover) is the user\'s decision, not the tool\'s: the user types /pf resume --takeover.'
      : 'resuming a paused loop is the user\'s decision, not the tool\'s (a plan to approve, an escalation): the user types /pf resume.')
      : 'it is the user\'s, or a shell command run with Bash.';
  return `perseveranza: "${v}" does not run through the perseveranza tool (it runs: ${TOOL_VIA_VERBS.join(', ')}): ${why} Nothing was run.`;
}

async function main() {
  // the mod runs the verbs with PERSEVERANZA_VIA=tool (its tool) or command (/pf): the
  // journal says so. Taken out of the environment here, so that nothing this verb starts (the
  // suite of `test`, a provider of `ask`) inherits it.
  const via = JOURNAL_VIAS.includes(process.env.PERSEVERANZA_VIA) ? process.env.PERSEVERANZA_VIA : null;
  setJournalVia(via);
  delete process.env.PERSEVERANZA_VIA;
  const [verb = 'status', ...rest] = process.argv.slice(2);
  const refused = toolViaRefusal(via, verb, rest);
  if (refused) { console.log(refused); return 2; }
  if (!VERBS.includes(verb)) {
    console.log(`Unknown verb: ${verb}. Verbs: ${VERBS.join(', ')}.`);
    return 1;
  }
  const mod = await import(`./verbs/${verb}.mjs`);
  const code = await mod.run({ argv: rest, rawArgv: process.argv, cwd: process.cwd(), env: process.env, via });
  return Number.isInteger(code) ? code : 0;
}

// run only as the entry point: importing this module (tests, tooling) must not execute a verb
function isMainModule() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] || '.')).href; }
  catch { return false; }
}

if (isMainModule()) main().then((code) => process.exit(code)).catch((e) => {
  if (e instanceof VerbError) { console.log(e.message); process.exit(e.code); }
  console.error(`perseveranza: ${e && e.stack || e}`);
  process.exit(1);
});
