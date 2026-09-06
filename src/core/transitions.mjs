// The transition table: phase x outcome -> next phase + prompt key.
// This is DATA. The machine looks transitions up here; the `explain` verb prints it; a
// packaging test checks the README reproduces it. Irregular effects (counters, pauses,
// git closure) stay in machine.mjs, but every "where do we go next" lives in this table.

export const TRANSITIONS = [
  // phase          outcome           next             prompt key / action              note
  { phase: 'plan',         outcome: 'no-plan',        next: 'plan',         prompt: 'plan-write',            note: 'asked once; a second miss still goes to implement' },
  { phase: 'plan',         outcome: 'approval',       next: 'plan',         prompt: 'plan-approval',         note: 'pause; --approve-plan, once' },
  { phase: 'plan',         outcome: 'ready',          next: 'implement',    prompt: 'implement-first',       note: 'adaptive budget set here when --max was not given' },
  { phase: 'implement',    outcome: 'idle',           next: 'implement',    prompt: 'implement-idle',        note: 'asked once: the tree did not change since the previous stop and no test ran' },
  { phase: 'implement',    outcome: 'always',         next: 'review',       prompt: 'review-delegate',       note: 'drops a stale review.json' },
  { phase: 'review',       outcome: 'pass',           next: 'implement',    prompt: 'review-advance',        note: 'retries reset' },
  { phase: 'review',       outcome: 'fail',           next: 'implement',    prompt: 'review-fix',            note: 'retries++; findings kept in review-<n>.json; external diagnosis from the 2nd fix' },
  { phase: 'review',       outcome: 'fail-limit',     next: 'review',       prompt: null,                    note: 'pause + escalation (fixes exhausted)' },
  { phase: 'review',       outcome: 'missing',        next: 'review',       prompt: 'review-missing-outcome', note: 'asked once' },
  { phase: 'review',       outcome: 'missing-twice',  next: 'implement',    prompt: 'review-fix',            note: 'counts as a failed review' },
  { phase: '*',            outcome: 'claim-open',     next: '=',            prompt: 'claim-open-steps',      note: 'claim-done refused: unchecked steps' },
  { phase: '*',            outcome: 'claim-no-test',  next: '=',            prompt: 'claim-no-fresh-test',   note: 'claim-done refused: no green test for this iteration or this tree' },
  { phase: '*',            outcome: 'claim-stale',    next: '=',            prompt: 'claim-stale-test',      note: 'claim-done refused: code changed after the test' },
  { phase: '*',            outcome: 'claim-unverifiable', next: '=',        prompt: 'claim-unverifiable-tree', note: 'claim-done refused: the work tree could not be snapshotted within the hook deadline' },
  { phase: '*',            outcome: 'claim-first',    next: 'cleanup',      prompt: 'cleanup',               note: 'once per run' },
  { phase: '*',            outcome: 'claim-again',    next: 'final-verify', prompt: 'final-verify',          note: 'drops a stale verify.json' },
  { phase: 'cleanup',      outcome: 'always',         next: 'final-verify', prompt: 'final-verify',          note: '' },
  { phase: 'final-verify', outcome: 'pass',           next: 'git-finish',   prompt: null,                    note: 'commit+push within the deadline, archive, disarm, notify' },
  { phase: 'final-verify', outcome: 'fail',           next: 'implement',    prompt: 'verify-postfix',        note: 'finalFails++; findings kept in verify-<n>.json' },
  { phase: 'final-verify', outcome: 'fail-limit',     next: 'final-verify', prompt: null,                    note: 'pause + escalation' },
  { phase: 'final-verify', outcome: 'missing',        next: 'final-verify', prompt: 'verify-missing-outcome', note: 'asked once' },
  { phase: 'final-verify', outcome: 'missing-twice',  next: 'implement',    prompt: 'verify-postfix',        note: 'counts as a failed verification' },
  { phase: 'git-finish',   outcome: 'retry',          next: 'git-finish',   prompt: null,                    note: 'after resume: retry the closure' },
  { phase: '*',            outcome: 'budget',         next: 'disarm',       prompt: null,                    note: 'iterations or tokens exhausted: archive, disarm, notify' },
  { phase: '*',            outcome: 'kill',           next: 'disarm',       prompt: null,                    note: 'STOP file or OMC_LOOP_KILL: before any other check' },
  { phase: '*',            outcome: 'unknown-phase',  next: 'plan',         prompt: 'phase-recovered',       note: 'tampered state: restart from the plan' },
];

// Lookup. Claim/kill/budget rows use phase '*'; next '=' means "unchanged".
export function lookup(phase, outcome) {
  const row = TRANSITIONS.find((r) => (r.phase === phase || r.phase === '*') && r.outcome === outcome);
  if (!row) return null;
  return { ...row, next: row.next === '=' ? phase : row.next };
}

export function outcomesFor(phase) {
  return TRANSITIONS.filter((r) => r.phase === phase || r.phase === '*');
}

// Markdown rendering shared by `explain --markdown` and the README test.
export function toMarkdown() {
  const lines = ['| phase | outcome | next | action |', '|---|---|---|---|'];
  for (const r of TRANSITIONS) {
    const action = [r.prompt ? `\`${r.prompt}\`` : null, r.note || null].filter(Boolean).join('; ');
    lines.push(`| ${r.phase === '*' ? 'any' : r.phase} | ${r.outcome} | ${r.next === '=' ? 'unchanged' : r.next} | ${action} |`);
  }
  return lines.join('\n');
}
