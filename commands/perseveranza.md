---
description: Arm the perseveranza feedback loop (plan -> implement -> review -> adversarial final verification) and start the task
argument-hint: <task description> [--max N] [--commit] [--external off] [--check] [--test "cmd"] [--no-git-finish] [--no-push] [--approve-plan] [--budget-tokens N] [--lang en]
---

Enable "perseveranza" mode for the task below and start working on it.

Task requested by the user:

$ARGUMENTS

Steps to run NOW, in order:

1. If the text above contains flags (`--max N`, `--commit`, `--external off`, `--check`,
   `--test "cmd"`, `--no-git-finish`, `--no-push`, `--approve-plan`, `--budget-tokens N`,
   `--lang xx`),
   REMOVE them from the task description and pass them to the command; otherwise keep the
   defaults. Escape double quotes inside the task. If the project has a test suite and the
   user did not pass `--test`, find it yourself (package.json, Makefile, pytest...) and pass
   it. The injected instructions are in Italian by default (`packs/it.json`); pass
   `--lang en` only if the user writes in English and did not set a language in the
   config. Arm the loop:

   node "${CLAUDE_PLUGIN_ROOT}/src/cli/omc-loop.mjs" arm "<task without flags>" [--max N] [--commit] [--external off] [--test "npm test"] [--lang en]

   (`--commit` = atomic commit after every validated step; `--external off` = no comparison
   with external models, which are otherwise auto-detected: codex, agy, grok, cursor, claude
   (clean context but same vendor: prefer the others when available), ollama-cloud;
   `--check` = probe the detected providers now and keep only those that answer (arm
   otherwise reports what the last `providers check` found: detected means installed, not
   reachable);
   `--test` = the suite command, claim-done will require a fresh green run; `--no-git-finish`
   = no automatic commit+push at the end; `--no-push` = local commit only at the end;
   `--approve-plan` = after the plan phase the loop PAUSES presenting the plan to the user
   and restarts only when they run `resume`; `--budget-tokens N` = token cap in addition to
   the iteration cap; `--max N` = iteration cap, otherwise adaptive from the number of steps.)
   If the command says the loop is ALREADY armed, do not force it: show the user
   `status` and ask whether to `disarm` first.

2. Check it is armed:

   node "${CLAUDE_PLUGIN_ROOT}/src/cli/omc-loop.mjs" status

3. PLAN PHASE: FIRST explore the relevant code (modules involved, existing patterns, current
   tests), THEN write the plan to `.omc-loop/plan.md` as a markdown checklist (`- [ ] step`)
   with small, verifiable steps. If arm detected external models (line "External models for
   the second opinion"), submit the plan to one of them for an independent critique with the
   `ask` verb (it saves the opinion in `.omc-loop/external-plan-*.md`):

   node "${CLAUDE_PLUGIN_ROOT}/src/cli/omc-loop.mjs" ask <provider> plan -- "<task + plan>"

   and integrate the well-founded remarks. Then assess the task complexity and record it:

   node "${CLAUDE_PLUGIN_ROOT}/src/cli/omc-loop.mjs" complexity low|medium|high

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
  writes the verdict to `.omc-loop/review.json` (`{"blocking": N, "findings": [...]}`) and
  that file routes the loop; only if it is missing, you record the outcome with
  `report pass|fail`. A missing outcome is asked for once, then counts as a failed review.
  - blocking > 0 -> back to fixing the SAME step, and the fix gets re-reviewed (after the
    configured number of fixes, default 3, the loop pauses and notifies the user); the
    consumed verdict is kept as `.omc-loop/review-<n>.json`: reread the findings there;
  - blocking = 0 -> tick the step in `plan.md` (`- [x]`) and move to the next.
- To run the test suite ALWAYS use the dedicated verb (the script runs the command and
  records the real exit code: the proof is not self-declared):
  node "${CLAUDE_PLUGIN_ROOT}/src/cli/omc-loop.mjs" test --if-needed -- <command>
  `--if-needed` skips the run when a green is already recorded for the current tree (or when
  only documentation changed since): the suite runs ONCE per tree, not once per agent. Per
  step run only the tests targeted at the change, and tell the subagents (executor,
  reviewer, verifier) to do the same: the full suite is the gate at claim-done. Every phase
  instruction carries the current "Test proof" so nobody reruns a suite that is already
  green on record. The verb records which tests failed; a red that does not reproduce on the
  same tree is journaled as non-reproducible (a flaky test: do not chase it as a bug).
- With `--commit`, after every passed review you commit the validated step (atomic commit).
- If a fix fails twice, the next phase includes an independent diagnosis from an external
  model (if detected).
- When ALL steps are ticked and the project is complete: run the test verb and, in the same
  response,
  node "${CLAUDE_PLUGIN_ROOT}/src/cli/omc-loop.mjs" claim-done
  The claim is ACCEPTED only with a green test run for the current tree (when a suite is
  known): run in this iteration, or earlier if the code did not change since (documentation
  edits do not count as code). -> first a cleanup round (only at the first claim:
  dead code, duplication, docs), then the adversarial final verification (independent
  subagent + falsification by an external model if detected; security lens for high
  complexity): the verifier writes `.omc-loop/verify.json` (`{"pass": true|false,
  "findings": [...]}`); `pass` closes the loop, `fail` sends you back to fix.
- At closure, if the directory is inside a git repo, the hook itself runs `git add -A`
  (excluding `.omc-loop/`), commit `perseveranza: <task>` and `git push`, verified on facts
  (clean tree, HEAD not ahead of upstream). If the closure cannot be confirmed the loop
  pauses in phase git-finish and tells the user what to fix; `resume` retries. The run
  (journal, plan, notes, opinions) is archived in `~/.perseveranza/runs/` (verb `runs`).
- If you need input from the user: run `pause`, then ask; when the user answers, run
  `resume` and continue.
- If you stop with a delegated subagent still running, the next Stop sees a work tree
  identical to the previous one and asks you (once) to finish the step instead of
  reviewing nothing: wait for the subagent and check its result on disk before stopping.
- Budget: iterations (adaptive from the plan, or `--max`) and optionally tokens
  (`--budget-tokens`); at the cap the loop stops by itself.
- Manual interruption at any time:
  node "${CLAUDE_PLUGIN_ROOT}/src/cli/omc-loop.mjs" disarm
  (emergency kill switch, faster and from any session: create the file `.omc-loop/STOP` or
  set `OMC_LOOP_KILL=1` -> at the first Stop the loop disarms itself)

Rules:
- NEVER edit `.omc-loop/state.json` by hand: use only the verbs `report`, `complexity`,
  `claim-done`, `pause`, `resume`.
- The loop files you manage are `.omc-loop/plan.md` (step checklist) and `.omc-loop/notes.md`
  (2-3 lines per completed step: decisions, traps — the memory that survives context
  compaction; re-read it if you lose the thread).
- At every new step, if its complexity clearly differs from the recorded one, update it
  with the `complexity` verb before implementing.
- The review uses the `pf-reviewer` agent, the final verification `pf-verifier`, high
  complexity implementation `pf-executor` (shipped with the plugin; `perseveranza:pf-*` from
  the plugin or the plain name from a manual install; fall back to generic subagents if
  absent). Pass them step/plan, touched files and diff in the prompt (if huge: list +
  excerpts): they start from an empty context, do not make them dig.
- The transition history is in `.omc-loop/journal.jsonl` (verb `history` renders it;
  `explain` shows the transition table and the next possible outcomes).
