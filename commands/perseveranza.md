---
description: Arm the perseveranza feedback loop (plan -> implement -> review -> adversarial final verification) and start the task
argument-hint: <task description> [--max N] [--commit] [--external off] [--check] [--test "cmd"] [--no-git-finish] [--no-push] [--approve-plan] [--budget-tokens N] [--verifiers lenses] [--advisor on|off] [--advisor-model name] [--lang en]
---

Enable "perseveranza" mode for the task below and start working on it.

How to run the loop's verbs: when this session has the `perseveranza` tool
(`mcp__perseveranza__perseveranza`, registered by the perseveranza mod), use it for the loop's
own verbs: the first word is `verb`, the words after it go whole in `args`:
`{"verb": "status"}`, `{"verb": "complexity", "args": "low"}`, `{"verb": "report", "args": "pass"}`,
`{"verb": "claim-done"}`, `{"verb": "pause"}`. The tool does NOT run the
test suite (`test`) nor the external models (`ask`): those are ALWAYS shell commands run with
Bash, `node "${CLAUDE_PLUGIN_ROOT}/src/cli/perseveranza.mjs" test ...` / `... ask ...`, where the
user's permissions decide. The same shell command is the explicit fallback for the loop's verbs
when the tool is not there or fails to start. `arm` is always the shell command (step 1);
`resume`, `disarm` and taking over a loop of another session (`resume --takeover`) are the
user's: a paused loop (a plan to approve, an escalation) waits for a human, so they type
`/pf resume`, `/pf disarm` or `/pf resume --takeover` (or ask you to run the shell command).
Never resume a loop on your own, with the tool or with Bash. While the loop is paused, `report`
and `claim-done` are refused too: wait for the user's `/pf resume`.

Task requested by the user:

$ARGUMENTS

Steps to run NOW, in order:

1. If the text above contains flags (`--max N`, `--commit`, `--external off`, `--check`,
   `--test "cmd"`, `--no-git-finish`, `--no-push`, `--approve-plan`, `--budget-tokens N`,
   `--verifiers <lenses>`, `--advisor on|off`, `--advisor-model <name>`, `--lang xx`),
   REMOVE them from the task description and pass them to the command; otherwise keep the
   defaults. Escape double quotes inside the task. If the project has a test suite and the
   user did not pass `--test`, find it yourself (package.json, Makefile, pytest...) and pass
   it. The injected instructions are in Italian by default (`packs/it.json`); pass
   `--lang en` only if the user writes in English and did not set a language in the
   config. Arm the loop:

   node "${CLAUDE_PLUGIN_ROOT}/src/cli/perseveranza.mjs" arm "<task without flags>" [--max N] [--commit] [--external off] [--test "npm test"] [--lang en]

   (`--commit` = atomic commit after every validated step; `--external off` = no comparison
   with external models, which are otherwise auto-detected: codex, agy, grok, cursor, claude
   (clean context but same vendor: prefer the others when available), ollama-cloud;
   `--check` = probe the detected providers now and keep only those that answer (arm
   otherwise reports what the last `providers check` found: detected means installed, not
   reachable);
   `--test` = the suite command, claim-done will require a fresh green run; `--no-git-finish`
   = no automatic commit+push at the end; `--no-push` = local commit only at the end;
   `--approve-plan` = after the plan phase the loop PAUSES presenting the plan to the user
   and restarts only when they run `/pf resume`; `--budget-tokens N` = token cap in addition to
   the iteration cap; `--max N` = iteration cap, otherwise adaptive from the number of steps;
   `--verifiers correctness,security,tests` = the final verification split into lenses, one
   verifier per lens, among general, correctness, security, tests (default auto: those three
   at complexity high, otherwise the single general verifier); `--advisor off` = no internal
   advisor (default on); `--advisor-model <name>` = its model (default `PERSEVERANZA_ADVISOR_MODEL`,
   else opus).)
   If the command says the loop is ALREADY armed, do not force it: show the user
   `status` and ask whether to `disarm` first. If it says the perseveranza mod is not
   running in this session, show the user its message (the causes and how to go on) and stop:
   do NOT add `--no-mod-check` unless the user asks for it (without the mod nothing drives
   the loop).

2. Check it is armed: the `perseveranza` tool with `{"verb": "status"}`, or (fallback)

   node "${CLAUDE_PLUGIN_ROOT}/src/cli/perseveranza.mjs" status

3. PLAN PHASE: FIRST explore the relevant code (modules involved, existing patterns, current
   tests), THEN write the plan to `.perseveranza/plan.md` as a markdown checklist (`- [ ] step`)
   with small, verifiable steps. If arm detected external models (line "External models for
   the second opinion"), submit the plan to one of them for an independent critique with the
   `ask` verb (it saves the opinion in `.perseveranza/external-plan-*.md`), always as a shell
   command with Bash (the tool does not run it)

   node "${CLAUDE_PLUGIN_ROOT}/src/cli/perseveranza.mjs" ask <provider> plan -- "<task + plan>"

   and integrate the well-founded remarks. If arm printed `Internal advisor: on` and there is
   no external model (or none of them gives a usable answer), ask the `pf-advisor` agent
   (`perseveranza:pf-advisor` from the plugin) with the model arm printed, in a clean context,
   for a critique of task + plan: it writes `.perseveranza/advisor-plan-0.md` and changes nothing.
   Integrate only the well-founded remarks and write in `.perseveranza/notes.md` why you
   discarded the others; a missing, empty or failed opinion is NOT a finding and does NOT
   block: proceed on your own judgement and note that it is missing. Then assess the task complexity and record it:
   the tool with `{"verb": "complexity", "args": "low|medium|high"}`, or (fallback)

   node "${CLAUDE_PLUGIN_ROOT}/src/cli/perseveranza.mjs" complexity low|medium|high

   (criterion: low = small, localised change; medium = standard multi-file feature; high =
   architecture, wide refactor, delicate domain. Default if you do not record it: medium.)
   Finally STOP (end the response without implementing). From here on the Stop hook drives
   the phases, injecting the next instruction at the end of every response and routing on
   the outcomes you record.

Complexity routes the models of the phases (hints for the subagents):

   | phase                        | low         | medium      | high                        |
   |------------------------------|-------------|-------------|-----------------------------|
   | code review (subagent)       | haiku       | sonnet      | opus                        |
   | final verification (subagent)| sonnet      | opus        | opus                        |
   | implement                    | in session  | in session  | delegated to executor, opus |

How the loop works (feedback):

- implement -> code review (delegated to a subagent with a clean context): the reviewer
  writes the verdict to `.perseveranza/review.json` (`{"requestId": "<ID from the phase prompt>", "blocking": N, "findings": [...]}`) and
  that file routes the loop; only if it is missing, you record the outcome with
  `report pass|fail`. A missing outcome is asked for once, then counts as a failed review.
  - blocking > 0 -> back to fixing the SAME step, and the fix gets re-reviewed (after the
    configured number of fixes, default 3, the loop pauses and notifies the user); the
    consumed verdict is kept as `.perseveranza/review-<n>.json`: reread the findings there;
  - blocking = 0 -> tick the step in `plan.md` (`- [x]`) and move to the next.
- To run the test suite ALWAYS use the dedicated verb (the script runs the command and
  records the real exit code: the proof is not self-declared), as a shell command with Bash
  (the tool does not run it, in any mode):
  node "${CLAUDE_PLUGIN_ROOT}/src/cli/perseveranza.mjs" test --if-needed -- <command>
  `--if-needed` skips the run when a green is already recorded for the current tree (or when
  only documentation changed since): the suite runs ONCE per tree, not once per agent. Per
  step run only the tests targeted at the change, and tell the subagents (executor,
  reviewer, verifier) to do the same: the full suite is the gate at claim-done. Every phase
  instruction carries the current "Test proof" so nobody reruns a suite that is already
  green on record. The verb records which tests failed; a red that does not reproduce on the
  same tree is journaled as non-reproducible (a flaky test: do not chase it as a bug).
- With `--commit`, after every passed review you commit the validated step (atomic commit).
- If a fix fails twice (or the final verification rejects the work twice), the next phase
  includes an independent diagnosis from an external model (if detected) and from the internal
  advisor `pf-advisor` (the fallback when no external answers; off with `--advisor off`). The
  advisor gets every attempt that already failed on the step, must not propose one again, and
  says whether the step itself is ill-posed: then rewrite the step in `plan.md` before
  retrying. It advises, it never routes: a missing opinion blocks nothing.
- When ALL steps are ticked and the project is complete: run the test verb and, in the same
  response, the tool with `{"verb": "claim-done"}`, or (fallback)
  node "${CLAUDE_PLUGIN_ROOT}/src/cli/perseveranza.mjs" claim-done
  The claim is ACCEPTED only with a green test run for the current tree (when a suite is
  known): run in this iteration, or earlier if the code did not change since (documentation
  edits do not count as code). -> first a cleanup round (only at the first claim:
  dead code, duplication, docs), then the adversarial final verification (independent
  subagent + falsification by an external model if detected; security lens for high
  complexity): the verifier writes `.perseveranza/verify.json` (`{"requestId": "<ID from the
  phase prompt>", "pass": true|false, "findings": [...]}`); `fail` sends you back to fix.
  `pass` closes the loop only if the plan is still fully ticked, the last recorded suite
  run is green on the code the verifier judged, and that code (everything git does not
  ignore, docs aside) did not change after the verification was requested: do not touch the
  code while it runs, and keep build/test output in .gitignore. Otherwise nothing is
  committed and you are sent back to implement, with a new claim-done that asks for a new
  verification.
- At closure, if the directory is inside a git repo, the hook itself runs `git add -A`
  (excluding `.perseveranza/`), commit `perseveranza: <task>` and `git push`, verified on facts
  (clean tree, HEAD not ahead of upstream). If the closure cannot be confirmed the loop
  pauses in phase git-finish and tells the user what to fix; their `/pf resume` retries. The run
  (journal, plan, notes, opinions) is archived in `~/.perseveranza/runs/` (verb `runs`).
- If you need input from the user: run `pause`, then ask; the user resumes the loop with
  `/pf resume` when they have answered (resuming is theirs: the tool does not run it).
- If you stop with a delegated subagent still running, the next Stop sees a work tree
  identical to the previous one and asks you (once) to finish the step instead of
  reviewing nothing: wait for the subagent and check its result on disk before stopping.
- Budget: iterations (adaptive from the plan, or `--max`) and optionally tokens
  (`--budget-tokens`); at the cap the loop stops by itself.
- Manual interruption at any time: the user types `/pf disarm` (it runs at once, even
  while you work; `/pf` is the mod's command for the user, `/pf help` lists its verbs), or
  node "${CLAUDE_PLUGIN_ROOT}/src/cli/perseveranza.mjs" disarm
  (emergency kill switch, faster and from any session: create the file `.perseveranza/STOP` or
  set `PERSEVERANZA_KILL=1` -> at the first Stop the loop disarms itself)

Rules:
- NEVER edit `.perseveranza/state.json` by hand: use only the verbs `report`, `complexity`,
  `claim-done`, `pause` (`resume` is the user's: `/pf resume`).
- The loop files you manage are `.perseveranza/plan.md` (step checklist) and `.perseveranza/notes.md`
  (2-3 lines per completed step: decisions, traps — the memory that survives context
  compaction; re-read it if you lose the thread).
- At every new step, if its complexity clearly differs from the recorded one, update it
  with the `complexity` verb before implementing.
- The review uses the `pf-reviewer` agent, the final verification `pf-verifier`, high
  complexity implementation `pf-executor`, the second opinion `pf-advisor` (shipped with the plugin; `perseveranza:pf-*`, from
  the marketplace or from a manual install alike; fall back to generic subagents if
  absent). Pass them step/plan, touched files and diff in the prompt (if huge: list +
  excerpts): they start from an empty context, do not make them dig.
- The transition history is in `.perseveranza/journal.jsonl` (verb `history` renders it;
  `explain` shows the transition table and the next possible outcomes).
