// The prompt pack: the phase instructions the Stop hook injects, as overridable templates.
//
// Override layers (highest precedence first):
//   1. env PERSEVERANZA_PROMPT_PACK=<path to JSON>
//   2. <project>/.perseveranza/prompts.json        (per-run, dies with disarm)
//   3. packs/<lang>.json shipped with the plugin (options.lang, e.g. "it")
//   4. these defaults
// Format: { "prompts": { "<key>": "template with {{placeholder}}" } }
//
// Rules:
//   - placeholders are {{name}}; an unknown one stays LITERAL (typo visible), never a crash;
//   - unknown keys are ignored; an unreadable file falls back to the next layer and is
//     journaled: the hook never breaks because of a bad pack;
//   - the progress header is NOT part of the templates: the hook always prepends it;
//   - a pack changes WHAT is said, never WHERE the loop goes (routing is code).
//
// Pure: no filesystem access here (loading lives in shell/packs.mjs).

export const DEFAULT_PROMPTS = {
  // --- composable hints (enter the phase instructions as {{...}}) ---
  'hint-impl-high': ` The task is high complexity: delegate the implementation to {{executorRef}} with model=opus; you coordinate and check the result.`,
  'hint-ask': `{{LOOP}} ask <provider> {{slot}} -- "<prompt>" (providers: {{extList}}; for long prompts use stdin: ... | {{LOOP}} ask <provider> {{slot}}; ollama-cloud queries every model listed in OLLAMA_MODEL)`,
  // how {{LOOP}} reads when the verbs are a tool of the mod instead of a shell command:
  // "{{LOOP}} report pass" -> 'the `perseveranza` tool ({"verb": ..., "args": ...}): report pass'
  'loop-tool': 'the `perseveranza` tool ({"verb": "<the first word>", "args": "<the words after it, if any>"}):',
  // in tool mode, what goes before the commands the tool does NOT run (the suite of `test`, an
  // external model of `ask`): they stay shell commands, run with Bash under the user's permissions
  'loop-bash': 'the shell command (run it with Bash, the `perseveranza` tool does not run it):',
  // in tool mode, how {{USER}} reads: what the USER types (resume, disarm, a takeover are theirs)
  'loop-user-tool': '(typed by the user) /pf',
  'hint-ext-framing': ` stating the legitimate context in the prompt (defensive review of YOUR OWN code, authorised project: avoids false policy refusals)`,
  'hint-ext-plan': ` Then ask an external model for an independent critique of the plan with {{askHint}}, passing task and plan; integrate the well-founded remarks (opinions are saved in .perseveranza/external-plan-*.md).`,
  'hint-ext-fix': ` Before retrying, ask an external model for an independent diagnosis with {{askHint}}, describing the problem that keeps failing{{extFraming}}; the diagnosis is saved in .perseveranza/external-fix-*.md.`,
  'hint-ext-verify': ` In addition to the subagent, ask one or more external models to falsify the work with {{askHint}}, passing plan and diff{{extFraming}}. Weigh their findings (saved in .perseveranza/external-verify-*.md); a policy refusal, an error or a provider timeout is NOT a finding: if no external model answers, proceed on the subagent's verdict alone (the closure notes it in the commit).`,
  'hint-advisor-fallback': `If no external model gives a usable answer (refusal, error, timeout, empty reply): `,
  'hint-advisor-plan': ` {{advisorFallback}}Before stopping, ask {{advisorRef}} with model={{advisorModel}} (clean context, read-only) for an independent critique of the plan, passing in the prompt the task and the full plan: it writes its opinion (critique, the 3 main risks, what it would change, what it could not check) to .perseveranza/advisor-plan-{{advisorN}}.md and changes nothing. Integrate only the well-founded remarks and explain in .perseveranza/notes.md why you discarded the others. The advisor is consultative: a missing or empty opinion, or an error, is NOT a finding and does NOT block: proceed on your own judgement and note in .perseveranza/notes.md that the opinion is missing.`,
  'hint-advisor-fix': ` {{advisorFallback}}Before retrying, ask {{advisorRef}} with model={{advisorModel}} (clean context, read-only) for an independent diagnosis, passing in the prompt: the task, the plan step, the diff, the latest findings, and EVERY earlier failed attempt on this step ({{priorAttempts}}). Tell it NOT to propose again an approach that already failed, and to say whether the problem is the plan (the step is ill-posed) rather than the implementation. It writes its opinion to .perseveranza/advisor-fix-{{advisorN}}.md and changes nothing. If it says the step is ill-posed, rewrite that step in .perseveranza/plan.md first (it stays '- [ ]') and then retry on the rewritten step. Integrate only the well-founded remarks and explain in .perseveranza/notes.md why you discarded the others. The advisor is consultative: a missing or empty opinion, or an error, is NOT a finding and does NOT block: proceed on your own judgement and note in .perseveranza/notes.md that the opinion is missing.`,
  'hint-advisor-verify-fix': ` {{advisorFallback}}Before fixing, ask {{advisorRef}} with model={{advisorModel}} (clean context, read-only) for an independent diagnosis, passing in the prompt: the task, the full plan, the total diff, the latest findings, and EVERY earlier rejected verification ({{priorAttempts}}). Tell it NOT to propose again a fix that already failed, and to say whether the problem is the plan (a step is ill-posed) rather than the implementation. It writes its opinion to .perseveranza/advisor-fix-{{advisorN}}.md and changes nothing. If it says a step is ill-posed, rewrite that step in .perseveranza/plan.md (reopened, '- [ ]') before fixing. Integrate only the well-founded remarks and explain in .perseveranza/notes.md why you discarded the others. The advisor is consultative: a missing or empty opinion, or an error, is NOT a finding and does NOT block: proceed on your own judgement and note in .perseveranza/notes.md that the opinion is missing.`,
  'hint-security': ` Include a security lens: secrets in code, untrusted input, injection, path traversal.`,
  'hint-commit': ` Then commit the step you just validated as an atomic commit, following the repo's conventions.`,
  'hint-test-green': ` Test proof: the full suite is GREEN for the current work tree, recorded by the test verb at iteration {{testIteration}}{{docsOnlyNote}}. Do NOT rerun it and tell every subagent NOT to: run only the tests targeted at what changes. {{testRun}} reruns the suite only if the code changed since (a run outside the verb proves nothing to the loop).`,
  'hint-test-docs-only': ` (only documentation changed since)`,
  'hint-test-none': ` Test proof: no green full-suite run is recorded for the current work tree. Do not run the full suite at every step and tell subagents to run only targeted tests; the full suite is the gate at claim-done. When you do run it, use {{testRun}}: it is recorded and reused as long as the code does not change, while a run outside the verb proves nothing to the loop.`,
  'hint-verdict-file': ` The findings are saved in {{verdictFile}}: reread them there, do not ask the reviewer again.`,
  'hint-verify-recheck': ` Earlier rounds of this verification rejected the work: their findings are in {{priorVerifyFiles}}. Every verifier must check explicitly that each of those defects is really fixed, and that the fixes introduced no regression.`,
  'hint-lens': ` [lens {{lens}}: writes .perseveranza/{{lensFile}} with requestId {{verdictRequestId}} and "lens": "{{lens}}"; mandate: {{mandate}}]`,
  'lens-general': `the whole adversarial mandate: correctness and edge cases, security, tests, and the plan realised in full`,
  'lens-correctness': `logic, edge cases, hostile inputs, and regressions introduced by the fixes`,
  'lens-security': `secrets in code, untrusted input, injection, path traversal, permissions`,
  'lens-tests': `run targeted tests, look for the cases the tests do not cover, and check that what comments and documentation claim is true`,

  // --- plan ---
  'plan-write': `PHASE: plan. .perseveranza/plan.md is missing. FIRST explore the relevant code (modules involved, existing patterns, current tests), THEN write the plan as a markdown checklist ('- [ ] step') with small, verifiable steps — but do NOT split into micro-steps what is one cohesive change (e.g. a helper together with ALL its call sites): every step opens a full review round, so group what only makes sense when verified together.{{extPlanHint}}{{advPlanHint}} Then assess the task complexity HONESTLY (a small, well-isolated change is often low, not medium by default) and record it with: {{LOOP}} complexity low|medium|high (it routes the models of the next phases). Finally stop.`,
  'plan-approval': `PHASE: plan approval (--approve-plan). The plan is written and the loop is PAUSED. Present the plan to the user NOW (goal, the numbered steps, main choices and risks) and explain that to approve it and start the implementation they must run: {{USER}} resume (they may edit .perseveranza/plan.md by hand first). Do NOT start implementing and do NOT run resume yourself: approval belongs to the user.`,
  'implement-idle': `PHASE: implement (nothing changed). The work tree is byte-for-byte what it was at your previous stop and no test was recorded: the step was NOT implemented. Typical cause: a delegated subagent was still running when your turn ended, or you stopped before writing anything. Do not send nothing to review: finish the current step now (wait for the subagent, check its result on disk) and stop only when the changes exist. If the step truly needs no change, write why in .perseveranza/notes.md and stop: the review follows.`,
  'subagent-running': `PHASE: {{phase}} (a subagent is still running). Your turn ended while a subagent of the loop was still working ({{agents}}): its result is not on disk yet. Do NOT delegate it again and do NOT start anything else: wait for it to finish (its completion notice reaches you on its own), then check its result on disk (the changes of the step, or the verdict file it must write) and stop. Wait {{waits}}/{{maxWaits}}: after that the loop goes on with what is on disk.`,
  'subagent-verdict': `perseveranza: you are about to stop without the verdict the loop asked you for: .perseveranza/{{file}} is {{problem}}. Write it NOW in the format your delegation prompt gives, with "requestId": "{{verdictRequestId}}", then stop. Change nothing else.`,
  'subagent-busy': `perseveranza: the loop's state could not be read just now (state.json held by a sync client or an antivirus, or damaged), so your verdict cannot be checked. Make sure the verdict file your delegation prompt asked for is written as it says, then stop again. Change nothing else.`,
  'hint-verdict-missing': `missing`,
  'hint-verdict-stale': `from an earlier request (another requestId, or written before the request)`,
  'hint-verdict-malformed': `unreadable ({{error}})`,
  'implement-first': `PHASE: implement. Open .perseveranza/plan.md and implement the FIRST unchecked step.{{implHint}}{{testHint}} Cover EVERYTHING the step promises, including the edge cases and hostile inputs already described in the spec or in code comments (not just the common case): a review that finds a missing case costs a whole extra round. Do NOT tick the box now: it is ticked only after the review passes. If you need input from the user: run {{LOOP}} pause and then ask.`,

  // --- review ---
  'review-delegate': `PHASE: code review. Delegate to {{reviewerRef}} with model={{reviewModel}} (clean context) the review of the step just implemented, passing in the prompt: the plan step, the list of touched files, the diff (if huge: file list + relevant excerpts), and verdict request ID {{verdictRequestId}}.{{testHint}} It checks: correctness, edge cases, regressions, security, adequacy of tests. The agent MUST write the verdict to .perseveranza/review.json as {"requestId": "{{verdictRequestId}}", "blocking": <number of blocking issues>, "findings": [{"severity": "critical|warning|suggestion", "desc": "...", "file": "path:line"}]}: that file routes the loop. Do NOT fix anything in this phase: fixes belong to the fix phase, where they get re-reviewed. Only if the agent could not write the file, record the outcome yourself with: {{LOOP}} report pass or: {{LOOP}} report fail. Do NOT edit .perseveranza/state.json by hand.`,
  'review-fix': `PHASE: fix (attempt {{retries}}/{{maxRetries}}). The review left open problems: fix ALL of them staying on the same plan step and run the relevant tests.{{verdictHint}}{{implHint}}{{testHint}}{{extFixHint}}{{advFixHint}} Do NOT tick the step.`,
  'review-advance': `PHASE: implement. Review passed: tick the completed step in .perseveranza/plan.md ('- [x]') and append 2-3 lines to .perseveranza/notes.md (decisions taken, traps met).{{commitHint}} If unchecked steps remain, implement the NEXT one; if its complexity clearly differs from the recorded one, update it first with: {{LOOP}} complexity low|medium|high.{{implHint}} If you lost the thread, re-read .perseveranza/plan.md and .perseveranza/notes.md.{{testHint}} If instead ALL steps are ticked and the project is complete: FIRST run the suite through the test verb ({{testRun}}: it skips the run when a green for this tree is already recorded) to get a green proof for the current tree (a claim-done without it is refused and costs a whole round), and IN THE SAME RESPONSE run: {{LOOP}} claim-done (it triggers the final verification). If you need input from the user: {{LOOP}} pause and then ask.`,
  'review-missing-outcome': `PHASE: code review (outcome missing). You did not record the review outcome. Finish it if needed (an agent you delegate to again gets the verdict request ID {{verdictRequestId}} and copies it into review.json), then run NOW: {{LOOP}} report pass or: {{LOOP}} report fail. A second missing outcome counts as a failed review.`,

  // --- exit ramp: claim-done, cleanup, final verification ---
  'claim-open-steps': `claim-done REFUSED: .perseveranza/plan.md still has {{openSteps}} unchecked step(s). Complete them (each goes through its review like the others) and, only when the plan is entirely '- [x]', declare again: {{LOOP}} claim-done.`,
  'claim-no-fresh-test': `claim-done REFUSED: no proof of a fresh green test. Run NOW: {{testRun}} and, if green, rerun {{LOOP}} claim-done IN THE SAME RESPONSE. If red, fix the failures first.`,
  'claim-stale-test': `claim-done REFUSED: the code changed after the last green test run, so that proof is stale. Run again NOW: {{testRun}} and, if green, rerun {{LOOP}} claim-done IN THE SAME RESPONSE without touching the code in between.`,
  'claim-unverifiable-tree': `claim-done REFUSED: the last green test carries a snapshot of the work tree, but the Stop hook could not recompute it within its deadline (or could not read the tree). This is NOT a code change. Usual cause: large untracked directories that git does not ignore (build output, node_modules, data, caches): add them to .gitignore, and make sure git works in this project. Then run again: {{testRun}} and, if green, rerun {{LOOP}} claim-done IN THE SAME RESPONSE.`,
  'cleanup': `PHASE: pre-verification cleanup. You declared the project complete: before the final gate do a cleanup pass WITHOUT adding features: remove dead code and duplication, simplify where behaviour stays the same, align style with the rest of the repo, update README/docstrings if behaviour changed. After the cleanup prove the tests are still green with: {{testRun}} (it does not rerun the suite when only documentation changed, or nothing did).{{testHint}} The final verification starts at the next stop.`,
  'final-verify': `PHASE: adversarial final verification. You declared the project complete: now it must be falsified. Delegate to {{verifierRef}} with model={{verifyModel}} (clean context) the verification, passing in the prompt the full plan, the total diff (if huge: file list + relevant excerpts), and verdict request ID {{verdictRequestId}}: it must assume the work is WRONG, build edge cases and hostile inputs, REALLY run targeted tests and the build, and check every claim against actual execution.{{testHint}}{{secHint}}{{priorVerifyHint}}{{extVerifyHint}} Do NOT fix anything in this phase. The agent MUST write the verdict to .perseveranza/verify.json as {"requestId": "{{verdictRequestId}}", "pass": true|false, "findings": [{"severity": "critical|warning", "desc": "...", "file": "path:line"}]}: that file routes the loop. Only if it could not write it, record the outcome yourself with: {{LOOP}} report pass or: {{LOOP}} report fail`,
  'final-verify-lenses': `PHASE: adversarial final verification, by lenses. You declared the project complete: now it must be falsified. In ONE message and in the FOREGROUND (not in the background: the turn must not end before every verdict is written), delegate one verifier per lens to {{verifierRef}} with model={{verifyModel}} (clean context each), passing each one the full plan, the total diff (if huge: file list + relevant excerpts), its lens, its file and verdict request ID {{verdictRequestId}}:{{lensList}} Every verifier must assume the work is WRONG within its lens, build edge cases and hostile inputs, REALLY run targeted tests and the build, and check every claim against actual execution.{{testHint}}{{secHint}}{{priorVerifyHint}}{{extVerifyHint}} Do NOT fix anything in this phase. Each agent MUST write ITS OWN file as {"requestId": "{{verdictRequestId}}", "lens": "<its lens>", "pass": true|false, "findings": [{"severity": "critical|warning", "desc": "...", "file": "path:line"}]}: together those files route the loop, and only a critical finding rejects the work. If the agents could not write them, only a rejection can be recorded by hand ({{LOOP}} report fail): a pass is never self-declared here, it needs every lens file`,
  'verify-postfix': `PHASE: post-verification fix (rejection {{finalFails}}/{{maxRetries}}). The final verification found defects: fix them all and reopen the affected steps in .perseveranza/plan.md ('- [ ]').{{verdictHint}}{{implHint}}{{testHint}}{{advFixHint}} When everything is complete and tested again, run {{testRun}} and then: {{LOOP}} claim-done`,
  'verify-missing-outcome': `PHASE: final verification (outcome missing). You did not record the verification outcome. Finish it if needed (an agent you delegate to again gets the verdict request ID {{verdictRequestId}} and copies it into verify.json), then run NOW: {{LOOP}} report pass or: {{LOOP}} report fail. A second missing outcome counts as a rejection.`,
  'verify-missing-lenses': `PHASE: final verification (lenses missing). The verdicts of the lens(es) {{missingLenses}} are missing for request {{verdictRequestId}}; the lenses that already wrote stay valid for this round: do NOT ask them again. In ONE message and in the FOREGROUND delegate to {{verifierRef}} with model={{verifyModel}} only the missing ones:{{lensList}} Each one writes its own file with that requestId and its lens. Only a rejection can be recorded by hand ({{LOOP}} report fail): a pass is never self-declared here, it needs every lens file. A second missing outcome counts as a rejection.`,
  'verify-pass-open': `PHASE: implement. The final verification passed, but .perseveranza/plan.md has {{openSteps}} unchecked step(s): nothing was committed. Implement the FIRST unchecked step now; each step goes through its review as usual.{{implHint}}{{testHint}} When ALL steps are ticked, run {{testRun}} and IN THE SAME RESPONSE: {{LOOP}} claim-done (a new final verification follows).`,
  'verify-pass-stale': `PHASE: implement. The final verification passed, but that pass does not cover the current work, so nothing was committed: the code changed after the verification was requested, or the last recorded suite run is not a green run on the code the verifier judged (red, missing, or run on older code). Code is not changed during a verification: a fix belongs here. If nobody edited the code, look for build or test output that git does not ignore (the verifier's own runs rewrite it) and add it to .gitignore. Make the suite green on the current tree with {{testRun}} and IN THE SAME RESPONSE run: {{LOOP}} claim-done (a new final verification of the current tree follows).{{testHint}}`,

  // --- recovery from an inconsistent state ---
  'phase-recovered': `PHASE: plan (inconsistent state, restored). Check .perseveranza/plan.md: if missing write it as a '- [ ] step' checklist, then stop.`,

  // --- SessionStart notices: a session learns about a loop it does not own (or lost track of) ---
  'hint-paused': ` (PAUSED)`,
  'hint-steps': `{{done}}/{{total}} steps done`,
  'hint-no-plan': `no plan yet`,
  'hint-last-fire': `last fire {{age}} ago ({{at}})`,
  'hint-armed-at': `armed {{age}} ago ({{at}}), never fired`,
  'hint-last-instruction': `, last instruction \`{{lastPrompt}}\``,
  'hint-last-activity': `last activity {{age}} ago ({{at}}: {{what}})`,
  'hint-last-transcript': `last output {{age}} ago ({{at}})`,
  'hint-restore-pending': ` A delegation was pending and never returned ({{agents}}): check its result on disk before delegating again.`,
  'hint-act-tool': `tool {{tool}}`,
  'hint-act-delegate': `delegated to {{agent}}, not back yet`,
  'hint-act-subagent-stop': `subagent {{agent}} finished`,
  'hint-act-pending': `; {{agent}} delegated {{age}} ago and not back yet`,
  'hint-owner-session': `session {{id}}`,
  'hint-owner-none': `no session (never claimed)`,
  'session-abandoned': `perseveranza: a loop armed in this project belongs to {{owner}} and looks ABANDONED: phase \`{{phase}}\`, {{when}}, {{steps}}{{lastInstr}}. Task: {{task}}. Do NOT take it over silently and do NOT touch .perseveranza/ or continue its work. Ask the user whether to resume it from this session ({{USER}} resume --takeover, then continue the phase above and let the Stop hook drive) or stop it ({{USER}} disarm, which archives the run). Until they decide, do nothing else in this repository.`,
  'session-live': `perseveranza: a loop in this project is driven by another session ({{owner}}, phase \`{{phase}}\`, {{when}}, {{steps}}). This session ({{sessionId}}) does not drive it: do not touch .perseveranza/ and do not work on its task. If the user says that session is gone, {{USER}} resume --takeover hands the loop to this one.`,
  'session-released': `perseveranza: a loop in this project was released by session {{from}} ({{USER}} resume --takeover) and is waiting for a claim: phase \`{{phase}}\`, {{when}}, {{steps}}. Task: {{task}}. The next Stop of the session that continues the work takes it over: do that ONLY if the user asks this session to continue the task; otherwise do not touch .perseveranza/.`,
  'session-fresh': `perseveranza: a loop was just armed in this project ({{when}}) and no session has fired yet: phase \`{{phase}}\`, {{steps}}. Task: {{task}}. It belongs to the session that armed it: do not touch .perseveranza/ and do not work on its task from here unless the user says so.`,
  'session-waiting': `perseveranza: a loop in this project is PAUSED and waits for a human: owner {{owner}}, phase \`{{phase}}\`, {{when}}, {{steps}}. Task: {{task}}. It is not abandoned. Do not touch .perseveranza/ and do not work on its task. If the user wants to continue it from this session: read .perseveranza/ESCALATION.md if present, then {{USER}} resume --takeover and let the Stop hook drive.`,
  'session-restore': `perseveranza: the previous turn of this session was interrupted by the watchdog after {{silence}} without a sign of life, and the session was restored. Task: {{task}}. Phase \`{{phase}}\`.{{what}} RECONCILE FIRST, READ-ONLY: edits, writes and delegations are refused until you do. Inspect .perseveranza/plan.md, .perseveranza/notes.md, git status, git diff, git log, and the process table for commands the interrupted turn may have left running. Then write .perseveranza/reconcile.json as {"disposition": "complete|partial|uncertain", "running": ["<command still running>"], "next": "implement|review", "summary": "<one line>"}: complete = the step's work is on disk and only needs its review; partial = continue the step from what exists, without redoing it; uncertain = you cannot tell, or a command is still running (a human decides). Do not implement anything in this turn: write the file and stop. The Stop hook drives from there.`,
  'reconcile-missing': `RECONCILIATION (after a restore): .perseveranza/reconcile.json is missing or invalid{{error}}. Inspect the work on disk, read-only, and write it NOW as {"disposition": "complete|partial|uncertain", "running": [], "next": "implement|review", "summary": "..."}; then stop. A second miss pauses the loop for a human.`,
  'reconcile-implement': `PHASE: implement (after reconciliation: the step was partial). Continue the CURRENT step from what is on disk: do not redo edits that already exist, do not repeat commands that already ran, check .perseveranza/notes.md and the diff first.{{implHint}}{{testHint}} Do NOT tick the box: it is ticked only after the review passes. If you need input from the user: {{LOOP}} pause and then ask.`,
  'session-compact': `perseveranza: this session drives an armed loop (phase \`{{phase}}\`, {{steps}}). Task: {{task}}. If the context lost the phase instruction, run {{LOOP}} status and continue the current phase; the Stop hook injects the next instruction when the turn ends.`,
};

// Placeholders each key may use. `prompts validate` flags anything else.
export const PROMPT_VARS = {
  'hint-impl-high': ['executorRef'],
  'hint-ask': ['LOOP', 'slot', 'extList'],
  'loop-tool': [],
  'loop-bash': [],
  'loop-user-tool': [],
  'hint-ext-framing': [],
  'hint-ext-plan': ['askHint'],
  'hint-ext-fix': ['askHint', 'extFraming'],
  'hint-ext-verify': ['askHint', 'extFraming'],
  'hint-advisor-fallback': [],
  'hint-advisor-plan': ['advisorFallback', 'advisorRef', 'advisorModel', 'advisorN'],
  'hint-advisor-fix': ['advisorFallback', 'advisorRef', 'advisorModel', 'advisorN', 'priorAttempts'],
  'hint-advisor-verify-fix': ['advisorFallback', 'advisorRef', 'advisorModel', 'advisorN', 'priorAttempts'],
  'hint-security': [],
  'hint-commit': [],
  'hint-test-green': ['testIteration', 'docsOnlyNote', 'testRun'],
  'hint-test-docs-only': [],
  'hint-test-none': ['testRun'],
  'hint-verdict-file': ['verdictFile'],
  'hint-verify-recheck': ['priorVerifyFiles'],
  'hint-lens': ['lens', 'lensFile', 'verdictRequestId', 'mandate'],
  'lens-general': [],
  'lens-correctness': [],
  'lens-security': [],
  'lens-tests': [],
  'plan-write': ['extPlanHint', 'advPlanHint', 'LOOP'],
  'plan-approval': ['LOOP', 'USER'],
  'implement-first': ['implHint', 'testHint', 'LOOP'],
  'implement-idle': [],
  'subagent-running': ['phase', 'agents', 'waits', 'maxWaits'],
  'subagent-verdict': ['file', 'problem', 'verdictRequestId'],
  'subagent-busy': [],
  'hint-verdict-missing': [],
  'hint-verdict-stale': [],
  'hint-verdict-malformed': ['error'],
  'review-delegate': ['reviewerRef', 'reviewModel', 'verdictRequestId', 'testHint', 'LOOP'],
  'review-fix': ['retries', 'maxRetries', 'verdictHint', 'implHint', 'testHint', 'extFixHint', 'advFixHint'],
  'review-advance': ['commitHint', 'implHint', 'testHint', 'testRun', 'LOOP'],
  'review-missing-outcome': ['verdictRequestId', 'LOOP'],
  'claim-open-steps': ['openSteps', 'LOOP'],
  'claim-no-fresh-test': ['testRun', 'LOOP'],
  'claim-stale-test': ['testRun', 'LOOP'],
  'claim-unverifiable-tree': ['testRun', 'LOOP'],
  'cleanup': ['testRun', 'testHint'],
  'final-verify': ['verifierRef', 'verifyModel', 'verdictRequestId', 'testHint', 'secHint', 'priorVerifyHint', 'extVerifyHint', 'LOOP'],
  'final-verify-lenses': ['verifierRef', 'verifyModel', 'verdictRequestId', 'lensList', 'testHint', 'secHint', 'priorVerifyHint', 'extVerifyHint', 'LOOP'],
  'verify-postfix': ['finalFails', 'maxRetries', 'verdictHint', 'implHint', 'testHint', 'advFixHint', 'testRun', 'LOOP'],
  'verify-missing-outcome': ['verdictRequestId', 'LOOP'],
  'verify-missing-lenses': ['missingLenses', 'verdictRequestId', 'verifierRef', 'verifyModel', 'lensList', 'LOOP'],
  'verify-pass-open': ['openSteps', 'implHint', 'testHint', 'testRun', 'LOOP'],
  'verify-pass-stale': ['testHint', 'testRun', 'LOOP'],
  'phase-recovered': [],
  'hint-paused': [],
  'hint-steps': ['done', 'total'],
  'hint-no-plan': [],
  'hint-last-fire': ['age', 'at'],
  'hint-armed-at': ['age', 'at'],
  'hint-last-instruction': ['lastPrompt'],
  'hint-last-activity': ['age', 'at', 'what'],
  'hint-last-transcript': ['age', 'at'],
  'hint-restore-pending': ['agents'],
  'session-restore': ['silence', 'task', 'phase', 'what', 'LOOP'],
  'reconcile-missing': ['error'],
  'reconcile-implement': ['implHint', 'testHint', 'LOOP'],
  'hint-act-tool': ['tool'],
  'hint-act-delegate': ['agent'],
  'hint-act-subagent-stop': ['agent'],
  'hint-act-pending': ['agent', 'age'],
  'hint-owner-session': ['id'],
  'hint-owner-none': [],
  'session-abandoned': ['owner', 'phase', 'when', 'steps', 'lastInstr', 'task', 'LOOP', 'USER'],
  'session-live': ['owner', 'phase', 'when', 'steps', 'sessionId', 'LOOP', 'USER'],
  'session-released': ['from', 'phase', 'when', 'steps', 'task', 'LOOP', 'USER'],
  'session-fresh': ['when', 'phase', 'steps', 'task'],
  'session-waiting': ['owner', 'phase', 'when', 'steps', 'task', 'LOOP', 'USER'],
  'session-compact': ['phase', 'steps', 'task', 'LOOP'],
};

export const PROMPT_KEYS = Object.keys(DEFAULT_PROMPTS);

// Placeholders a key should keep: without the request id, the agents a prompt delegates to
// write verdicts the loop can only date by the file clock. A warning, not an error: such a
// verdict still counts when written after the request.
export const PROMPT_EXPECTED = {
  'review-delegate': ['verdictRequestId'],
  'final-verify': ['verdictRequestId'],
  'final-verify-lenses': ['verdictRequestId', 'lensList'],
  'verify-missing-lenses': ['lensList'],
};

const PLACEHOLDER = /\{\{([a-zA-Z0-9_-]+)\}\}/g;

// Pure rendering: template (first layer that has the key, else default) + variables.
// A placeholder without a variable stays literal; an unknown key renders ''.
// `layers` is ordered highest precedence first.
export function renderPrompt(key, vars = {}, layers = []) {
  const list = Array.isArray(layers) ? layers : [layers];
  let tpl;
  for (const layer of list) {
    if (layer && typeof layer[key] === 'string') { tpl = layer[key]; break; }
  }
  if (tpl === undefined) tpl = DEFAULT_PROMPTS[key];
  if (typeof tpl !== 'string') return '';
  return tpl.replace(PLACEHOLDER, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m);
}

// What {{LOOP}} renders as: the shell command of the verbs (mode 'shell', the default), or
// the mod's `perseveranza` tool (mode 'tool'), worded by the pack like any prompt.
export const LOOP_MODES = ['shell', 'tool'];
export function loopVar(mode, shellLoop, layers = []) {
  return mode === 'tool' ? renderPrompt('loop-tool', {}, layers) : shellLoop || 'node perseveranza.mjs';
}

// What {{USER}} renders as, in the instructions that hand a verb to the user (approving a plan,
// resuming or disarming a loop, taking one over): in shell mode the same as {{LOOP}} (the CLI,
// unchanged); in tool mode the user's /pf command, which the model cannot run (Claude Code
// refuses a mod's command from the Skill tool) and the tool refuses (takeover, disarm).
export function userVar(mode, shellLoop, layers = []) {
  return mode === 'tool' ? renderPrompt('loop-user-tool', {}, layers) : loopVar('shell', shellLoop, layers);
}

// How the instructions name a verb the tool does not run (test, ask): always the CLI, a shell
// command run with Bash where the user's permissions decide; in tool mode said as such.
export function bashVar(mode, shellLoop, layers = []) {
  const cli = loopVar('shell', shellLoop, layers);
  return mode === 'tool' ? `${renderPrompt('loop-bash', {}, layers)} ${cli}` : cli;
}

// The mode the instructions of one stop (or notice) are rendered in: the tool only when the run
// was armed for it (state.options.loopMode, set by `arm` when the mod was alive) AND the driver
// of this stop has it (the mod says so in its facts). A run armed from a terminal, or a stop
// driven without the mod (a settings hook wired by hand to src/shell/stop.mjs), speaks the shell command:
// the CLI works everywhere, the tool only where the mod registered it.
export function effectiveLoopMode(armed, driver) {
  return armed === 'tool' && driver === 'tool' ? 'tool' : 'shell';
}

// Where a key's template comes from: the index of the first layer that has it, the number of
// layers for a shipped default, Infinity for no template at all. A pack that customises the
// single-verifier prompt and knows nothing of the lenses outranks the default lens prompt:
// the machine then keeps the pack's wording (and reads its verify.json as the whole round).
export function templateLayer(key, layers = []) {
  const list = Array.isArray(layers) ? layers : [layers];
  const i = list.findIndex((layer) => layer && typeof layer[key] === 'string');
  if (i >= 0) return i;
  return typeof DEFAULT_PROMPTS[key] === 'string' ? list.length : Infinity;
}

// Validate a parsed pack object. Never throws.
// -> { overrides, unknownKeys, badPlaceholders: [{key, placeholder}], missingPlaceholders: [{key, placeholder}], error }
export function validatePack(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { overrides: {}, unknownKeys: [], badPlaceholders: [], missingPlaceholders: [], error: 'pack is not an object' };
  const src = raw.prompts && typeof raw.prompts === 'object' && !Array.isArray(raw.prompts) ? raw.prompts : null;
  if (!src) return { overrides: {}, unknownKeys: [], badPlaceholders: [], missingPlaceholders: [], error: 'missing "prompts" object' };
  const overrides = {};
  const unknownKeys = [];
  const badPlaceholders = [];
  const missingPlaceholders = [];
  for (const [k, v] of Object.entries(src)) {
    if (!(k in DEFAULT_PROMPTS)) { unknownKeys.push(k); continue; }
    if (typeof v !== 'string') { badPlaceholders.push({ key: k, placeholder: null, reason: 'not a string' }); continue; }
    const allowed = PROMPT_VARS[k] || [];
    for (const m of v.matchAll(PLACEHOLDER)) {
      if (!allowed.includes(m[1])) badPlaceholders.push({ key: k, placeholder: m[1], reason: `not available for "${k}" (allowed: ${allowed.join(', ') || 'none'})` });
    }
    for (const name of PROMPT_EXPECTED[k] || []) {
      if (!v.includes(`{{${name}}}`)) missingPlaceholders.push({ key: k, placeholder: name });
    }
    overrides[k] = v;
  }
  return { overrides, unknownKeys, badPlaceholders, missingPlaceholders, error: null };
}

// Keys a pack does NOT override (used to check that a language pack is complete).
export function missingKeys(overrides) {
  return PROMPT_KEYS.filter((k) => typeof overrides?.[k] !== 'string');
}
