#!/usr/bin/env node
// The verbs: how Claude (and you) talk to the loop. One file per verb in ./verbs/.
//
//   arm "<task>" [--max N] [--max-retries N] [--complexity low|medium|high] [--commit]
//                [--external off] [--test "cmd"] [--no-git-finish] [--no-push]
//                [--approve-plan] [--budget-tokens N] [--lang xx] [--force]
//   test -- <command>          run the suite HERE and record the real exit code
//   report pass|fail           outcome of the current phase (review / final verification)
//   complexity low|medium|high task complexity (routes the models)
//   claim-done                 declare the project complete -> triggers the final verification
//   ask <provider> <slot> -- <prompt>   ask an external model, save the opinion
//   pause | resume             suspend / resume the loop
//   status                     human-readable summary
//   history [--tail N] [--json] the run journal
//   explain [--markdown]       the transition table and the next possible outcomes
//   providers [list|check [id]] external providers and their liveness
//   runs [list|show <id>]      the archive of past runs
//   prompts validate [file] | keys | show <key>
//   config                     effective local configuration (never prints the key)
//   hud on|off|status          live statusline
//   disarm [--no-archive]      stop and remove the loop
import { VerbError } from './shared.mjs';

export const VERBS = ['arm', 'test', 'report', 'complexity', 'claim-done', 'ask', 'pause', 'resume', 'status', 'history', 'explain', 'providers', 'runs', 'prompts', 'config', 'hud', 'disarm'];

async function main() {
  const [verb = 'status', ...rest] = process.argv.slice(2);
  if (!VERBS.includes(verb)) {
    console.log(`Unknown verb: ${verb}. Verbs: ${VERBS.join(', ')}.`);
    return 1;
  }
  const mod = await import(`./verbs/${verb}.mjs`);
  const code = await mod.run({ argv: rest, rawArgv: process.argv, cwd: process.cwd(), env: process.env });
  return Number.isInteger(code) ? code : 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  if (e instanceof VerbError) { console.log(e.message); process.exit(e.code); }
  console.error(`perseveranza: ${e && e.stack || e}`);
  process.exit(1);
});
