// The prompt pack: the phase instructions the Stop hook injects, as overridable templates.
//
// Override layers (highest precedence first):
//   1. env OMC_PROMPT_PACK=<path to JSON>
//   2. <project>/.omc-loop/prompts.json        (per-run, dies with disarm)
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
  'hint-ext-framing': ` stating the legitimate context in the prompt (defensive review of YOUR OWN code, authorised project: avoids false policy refusals)`,
  'hint-ext-plan': ` Then ask an external model for an independent critique of the plan with {{askHint}}, passing task and plan; integrate the well-founded remarks (opinions are saved in .omc-loop/external-plan-*.md).`,
  'hint-ext-fix': ` Before retrying, ask an external model for an independent diagnosis with {{askHint}}, describing the problem that keeps failing{{extFraming}}; the diagnosis is saved in .omc-loop/external-fix-*.md.`,
  'hint-ext-verify': ` In addition to the subagent, ask one or more external models to falsify the work with {{askHint}}, passing plan and diff{{extFraming}}. Weigh their findings (saved in .omc-loop/external-verify-*.md); a policy refusal, an error or a provider timeout is NOT a finding: if no external model answers, proceed on the subagent's verdict alone (the closure notes it in the commit).`,
  'hint-security': ` Include a security lens: secrets in code, untrusted input, injection, path traversal.`,
  'hint-commit': ` Then commit the step you just validated as an atomic commit, following the repo's conventions.`,

  // --- plan ---
  'plan-write': `PHASE: plan. .omc-loop/plan.md is missing. FIRST explore the relevant code (modules involved, existing patterns, current tests), THEN write the plan as a markdown checklist ('- [ ] step') with small, verifiable steps — but do NOT split into micro-steps what is one cohesive change (e.g. a helper together with ALL its call sites): every step opens a full review round, so group what only makes sense when verified together.{{extPlanHint}} Then assess the task complexity HONESTLY (a small, well-isolated change is often low, not medium by default) and record it with: {{LOOP}} complexity low|medium|high (it routes the models of the next phases). Finally stop.`,
  'plan-approval': `PHASE: plan approval (--approve-plan). The plan is written and the loop is PAUSED. Present the plan to the user NOW (goal, the numbered steps, main choices and risks) and explain that to approve it and start the implementation they must run: {{LOOP}} resume (they may edit .omc-loop/plan.md by hand first). Do NOT start implementing and do NOT run resume yourself: approval belongs to the user.`,
  'implement-first': `PHASE: implement. Open .omc-loop/plan.md and implement the FIRST unchecked step.{{implHint}} Cover EVERYTHING the step promises, including the edge cases and hostile inputs already described in the spec or in code comments (not just the common case): a review that finds a missing case costs a whole extra round. Do NOT tick the box now: it is ticked only after the review passes. If you need input from the user: run {{LOOP}} pause and then ask.`,

  // --- review ---
  'review-delegate': `PHASE: code review. Delegate to {{reviewerRef}} with model={{reviewModel}} (clean context) the review of the step just implemented, passing in the prompt: the plan step, the list of touched files and the diff (if huge: file list + relevant excerpts). It checks: correctness, edge cases, regressions, security, adequacy of tests. The agent MUST write the verdict to .omc-loop/review.json as {"blocking": <number of blocking issues>, "findings": [{"severity": "critical|warning|suggestion", "desc": "...", "file": "path:line"}]}: that file routes the loop. Do NOT fix anything in this phase: fixes belong to the fix phase, where they get re-reviewed. Only if the agent could not write the file, record the outcome yourself with: {{LOOP}} report pass or: {{LOOP}} report fail. Do NOT edit .omc-loop/state.json by hand.`,
  'review-fix': `PHASE: fix (attempt {{retries}}/{{maxRetries}}). The review left open problems: fix ALL of them staying on the same plan step and run the relevant tests.{{implHint}}{{extFixHint}} Do NOT tick the step.`,
  'review-advance': `PHASE: implement. Review passed: tick the completed step in .omc-loop/plan.md ('- [x]') and append 2-3 lines to .omc-loop/notes.md (decisions taken, traps met).{{commitHint}} If unchecked steps remain, implement the NEXT one; if its complexity clearly differs from the recorded one, update it first with: {{LOOP}} complexity low|medium|high.{{implHint}} If you lost the thread, re-read .omc-loop/plan.md and .omc-loop/notes.md. If instead ALL steps are ticked and the project is complete: FIRST run the suite through the test verb ({{LOOP}} test -- <command>) to get a fresh green proof (a claim-done without a fresh proof is refused and costs a whole round), and IN THE SAME RESPONSE run: {{LOOP}} claim-done (it triggers the final verification). If you need input from the user: {{LOOP}} pause and then ask.`,
  'review-missing-outcome': `PHASE: code review (outcome missing). You did not record the review outcome. Finish it if needed, then run NOW: {{LOOP}} report pass or: {{LOOP}} report fail. A second missing outcome counts as a failed review.`,

  // --- exit ramp: claim-done, cleanup, final verification ---
  'claim-open-steps': `claim-done REFUSED: .omc-loop/plan.md still has {{openSteps}} unchecked step(s). Complete them (each goes through its review like the others) and, only when the plan is entirely '- [x]', declare again: {{LOOP}} claim-done.`,
  'claim-no-fresh-test': `claim-done REFUSED: no proof of a fresh green test. Run NOW: {{testRun}} and, if green, rerun {{LOOP}} claim-done IN THE SAME RESPONSE. If red, fix the failures first.`,
  'claim-stale-test': `claim-done REFUSED: the code changed after the last green test run, so that proof is stale. Run again NOW: {{testRun}} and, if green, rerun {{LOOP}} claim-done IN THE SAME RESPONSE without touching the code in between.`,
  'cleanup': `PHASE: pre-verification cleanup. You declared the project complete: before the final gate do a cleanup pass WITHOUT adding features: remove dead code and duplication, simplify where behaviour stays the same, align style with the rest of the repo, update README/docstrings if behaviour changed. After the cleanup prove the tests are still green with: {{testRun}}. The final verification starts at the next stop.`,
  'final-verify': `PHASE: adversarial final verification. You declared the project complete: now it must be falsified. Delegate to {{verifierRef}} with model={{verifyModel}} (clean context) the verification, passing in the prompt the full plan and the total diff (if huge: file list + relevant excerpts): it must assume the work is WRONG, build edge cases and hostile inputs, REALLY run tests and build, and check every claim against actual execution.{{secHint}}{{extVerifyHint}} Do NOT fix anything in this phase. The agent MUST write the verdict to .omc-loop/verify.json as {"pass": true|false, "findings": [{"severity": "critical|warning", "desc": "...", "file": "path:line"}]}: that file routes the loop. Only if it could not write it, record the outcome yourself with: {{LOOP}} report pass or: {{LOOP}} report fail`,
  'verify-postfix': `PHASE: post-verification fix (rejection {{finalFails}}/{{maxRetries}}). The final verification found defects: fix them all and reopen the affected steps in .omc-loop/plan.md ('- [ ]').{{implHint}} When everything is complete and tested again, rerun the test verb and then: {{LOOP}} claim-done`,
  'verify-missing-outcome': `PHASE: final verification (outcome missing). You did not record the verification outcome. Finish it if needed, then run NOW: {{LOOP}} report pass or: {{LOOP}} report fail. A second missing outcome counts as a rejection.`,

  // --- recovery from an inconsistent state ---
  'phase-recovered': `PHASE: plan (inconsistent state, restored). Check .omc-loop/plan.md: if missing write it as a '- [ ] step' checklist, then stop.`,
};

// Placeholders each key may use. `prompts validate` flags anything else.
export const PROMPT_VARS = {
  'hint-impl-high': ['executorRef'],
  'hint-ask': ['LOOP', 'slot', 'extList'],
  'hint-ext-framing': [],
  'hint-ext-plan': ['askHint'],
  'hint-ext-fix': ['askHint', 'extFraming'],
  'hint-ext-verify': ['askHint', 'extFraming'],
  'hint-security': [],
  'hint-commit': [],
  'plan-write': ['extPlanHint', 'LOOP'],
  'plan-approval': ['LOOP'],
  'implement-first': ['implHint', 'LOOP'],
  'review-delegate': ['reviewerRef', 'reviewModel', 'LOOP'],
  'review-fix': ['retries', 'maxRetries', 'implHint', 'extFixHint'],
  'review-advance': ['commitHint', 'implHint', 'LOOP'],
  'review-missing-outcome': ['LOOP'],
  'claim-open-steps': ['openSteps', 'LOOP'],
  'claim-no-fresh-test': ['testRun', 'LOOP'],
  'claim-stale-test': ['testRun', 'LOOP'],
  'cleanup': ['testRun'],
  'final-verify': ['verifierRef', 'verifyModel', 'secHint', 'extVerifyHint', 'LOOP'],
  'verify-postfix': ['finalFails', 'maxRetries', 'implHint', 'LOOP'],
  'verify-missing-outcome': ['LOOP'],
  'phase-recovered': [],
};

export const PROMPT_KEYS = Object.keys(DEFAULT_PROMPTS);

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

// Validate a parsed pack object. Never throws.
// -> { overrides, unknownKeys, badPlaceholders: [{key, placeholder}], error }
export function validatePack(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { overrides: {}, unknownKeys: [], badPlaceholders: [], error: 'pack is not an object' };
  const src = raw.prompts && typeof raw.prompts === 'object' && !Array.isArray(raw.prompts) ? raw.prompts : null;
  if (!src) return { overrides: {}, unknownKeys: [], badPlaceholders: [], error: 'missing "prompts" object' };
  const overrides = {};
  const unknownKeys = [];
  const badPlaceholders = [];
  for (const [k, v] of Object.entries(src)) {
    if (!(k in DEFAULT_PROMPTS)) { unknownKeys.push(k); continue; }
    if (typeof v !== 'string') { badPlaceholders.push({ key: k, placeholder: null, reason: 'not a string' }); continue; }
    const allowed = PROMPT_VARS[k] || [];
    for (const m of v.matchAll(PLACEHOLDER)) {
      if (!allowed.includes(m[1])) badPlaceholders.push({ key: k, placeholder: m[1], reason: `not available for "${k}" (allowed: ${allowed.join(', ') || 'none'})` });
    }
    overrides[k] = v;
  }
  return { overrides, unknownKeys, badPlaceholders, error: null };
}

// Keys a pack does NOT override (used to check that a language pack is complete).
export function missingKeys(overrides) {
  return PROMPT_KEYS.filter((k) => typeof overrides?.[k] !== 'string');
}
