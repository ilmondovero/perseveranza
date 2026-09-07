# Notes for code review (v2)

Invariants and traps of the project. **Read before reviewing changes to `src/`.** The
history of decisions is in `../CHANGELOG.md`; the design the v2 comes from is in
`PIANO-V2.md`.

## Core vs shell (`src/core/`, `src/shell/`)

- The core is **pure**: no `node:fs`, no processes, no clock. `step(state, event, ctx)` and
  `finishProject(state, gitResult, ctx)` return `{ state, effects, outcome }`. Every fact
  the core needs comes in through `ctx` (plan text, verdict text, pack layers, fingerprint,
  usage); every side effect goes out as an **effect** the shell executes in order
  (`shell/effects.mjs`). A new side effect is a new effect type, never a `fs` import in the core.
- The transition table (`core/transitions.mjs`) is **data**: the machine looks the next
  phase up there, `explain` prints it, a packaging test checks both READMEs reproduce it
  (`npm run explain -- --markdown`, paste between the `transitions:start/end` markers).
  A new outcome = a new row + a unit test proving `step()` reaches it (`machine.test.mjs`
  has a coverage test over the whole table).
- Pre-state checks (kill switch, corrupt state) live in `shell/stop.mjs`: they need no
  state and must work even when `state.json` is garbage.

## The Stop hook (`src/shell/stop.mjs`)

- Must **never throw** and must answer within the **deadline**: `hooks.json` declares
  120 s; the shell keeps an 8 s margin and hands the remaining time to git (push capped at
  45 s). A closure that runs out of time pauses in `git-finish` by decision, not by kill.
- Do NOT allow-stop on `stop_hook_active === true`: the loop's own continuations carry it,
  and allowing the stop freezes the loop (the v1 1.11.2 regression). No speculative
  stop-reason guards either: the payload **keys** are journaled at every fire (`fire`
  entry) so any new guard is written on evidence.
- Per-session scoping: the first session to fire **claims** the loop; others let Claude
  stop without touching the state, however long the owner has been silent. The takeover is
  explicit only: `resume --takeover` releases the owner (`owner.releasedFrom`,
  `owner.releasedAt`), and within the stale window the next fire of any session claims it
  (journal `session takeover`); past the window the release is closed and the fire is a
  foreign session again. A paused loop is never stale (`signals.paused`). The implicit 6 h takeover of
  1.12–2.1 was removed after a real orphaned loop: a session opened for something else
  would have found itself driving the review of a half-done step.
  The scoping check runs before pause/budget so a foreign session never disarms anything.
- Silence is a first-class fact (`core/staleness.mjs`, pure): `owner.lastFireAt` is
  compared with the clock by `status`, the HUD, the `disarm` recap and the `SessionStart`
  hook (`shell/session-start.mjs`, the only code path that runs outside a Stop of the
  owner). Past `OMC_LOOP_STALE_MS` (30 min) the loop is `STALE`, the next fire journals a
  `gap` (kept in `summary.json`), and a new session is told to ask the user rather than
  act. The notice never touches the state.
- The turn itself has a heartbeat (`shell/activity-hook.mjs` on PreToolUse/Agent,
  PostToolUse on the working tools, SubagentStop): `.omc-loop/activity.json` is its own
  file, written atomically (temp + rename) and throttled to one write per 30 s, so it never
  races state.json; the pending delegations (`pending`, a list) survive the tools that run beside them
  and closes on SubagentStop or on the Agent call's PostToolUse. The hook does the dormant
  check before importing anything beyond `node:fs`: it runs at tool-call rate in every
  project. `core/staleness.mjs` measures the silence from `lastSeen` (fire or owner
  activity, never a foreign session's); the `gap` starts there too.
- The watchdog (`shell/watchdog.mjs`) is a detached process spawned by the Stop hook (not
  for a foreign session, not after disarm) and by `arm`; `.omc-loop/watchdog.json` holds
  the newest pid, written atomically (a torn pid file would read as "nobody owns it" and
  let every watchdog speak); `spawnWatchdog` does not spawn while the incumbent is alive
  (`process.kill(pid, 0)`), so one process per loop is the budget, whatever the fire rate.
  It exits on pause, disarm and after 48 h; naps are capped at 1 h so a clock jump cannot
  strand it. Detached children of a hook survive the hook on Windows: the update refresh
  (`update.mjs`, same spawn shape) completes its fetch after the Stop hook exited. `decide()` is pure
  over the gate and unit-testable; the e2e test runs it synchronously with a 1 s threshold
  and also spawns the real detached one once to prove it journals.
- Kill and restore (`shell/restore.mjs`, behind `OMC_LOOP_RESTORE=1`) was tested by hand
  before it was written, on Windows, with a real session: `taskkill /T` on a session mid
  command left a valid transcript, Claude Code closed the interrupted turn itself
  ("Continue from where you left off" / "No response requested"), and `claude -r <id>
  "<prompt>"` reopened the same id and ran the prompt. Three facts came out of that test and
  are encoded: strip `CLAUDE_CODE_CHILD_SESSION` (and the dead session's messaging
  socket/token) or the child does not save its transcript; pass the prompt as one argument,
  never through a shell's quoting; launch from the project directory. The Stop hook records
  the Claude Code process (pid + start time, a CIM walk up the tree starting ABOVE the hook,
  matching only the native binary or node running the npm package's cli.js: the shipped
  plugin lives under ~/.claude/plugins/, so "anything with claude in it" would match the
  hook itself; only when the flag is on) and the transcript path. The watchdog alerts at
  the stale threshold and restores only after a second one (`OMC_LOOP_RESTORE_AFTER_MS`,
  default twice: a session waiting on a human writes nothing either, the alert is the
  human's chance); it refuses to kill a pid whose start time or command line no longer
  match (fail closed: no start time means not proven), refuses a blind relaunch when no
  process was recorded (two processes on one session id), restores at most 3 times per run
  counted on the whole journal, restores a session whose recorded process is already gone
  without killing anything, and spawns the next watchdog itself so the restored session is
  watched before its first Stop. The third sign of life is the
  transcript (`shell/life.mjs`: the session file and `<session>/subagents/*.jsonl`), so a
  model generating for an hour is never silent; the `test` verb beats while the suite runs.

## Proofs, not words

- `claim-done` is accepted only with: plan fully ticked (`core/plan.mjs` is the ONLY
  checkbox counter, fence-aware) and a green `test` run that proves the CURRENT tree:
  either recorded at the current iteration, or earlier with a still-matching work-tree
  **fingerprint** (`shell/git.mjs`, SHA-256 of the index, binary-safe working diff and
  untracked file contents, excluding `.omc-loop/`). The verb records two fingerprints:
  the full one and a **code** one that leaves `DOC_PATHSPECS` out (`*.md`, `docs/`,
  `LICENSE*`... never `*.txt`: `requirements.txt` is code); a green whose code fingerprint
  still matches is accepted as `docs-only`. The fingerprint is the stronger evidence, so
  it is the iteration rule that yields, never the fingerprint rule. `test --if-needed`
  applies the same comparison before running anything.
  An existing fingerprint the hook cannot recompute (deadline, unreadable tree) is refused
  with its own outcome, `claim-unverifiable`: the instruction says it is NOT a code change
  and points at `.gitignore`, so Claude does not rerun the suite blindly. A test recorded
  outside git has no fingerprint. Snapshot work shares the Stop hook deadline.
- Verdicts (`core/verdicts.mjs`) are schema-checked. Malformed → journaled and treated as
  **missing**; missing → asked once, then a **failure** (review and final gate alike; the
  v1 "advance anyway" path is gone). When the declared verdict and the findings disagree,
  the **stricter** reading wins (critical findings raise `blocking`, veto `pass`).
  A malformed artifact also overrides a stale `report pass`; `blocking` must be a JSON
  integer (no coercion of null, booleans, arrays or strings).
- `maxRetries` means fixes **really granted**: with 3 the pause comes at the 4th failure.
- Artifacts are consumed on read: a verdict is never reused. Consumed is not deleted: the
  `keepArtifact` effect renames it to `review-<n>.json` / `verify-<n>.json` (n = the
  iteration that consumed it) so the fix phase can reread the findings and the archive
  keeps them; `dropArtifact` only removes a STALE file at phase entry, before any read.
- The hook fingerprints the tree at every stop (`state.tree`, hook-owned). In `implement`,
  an identical tree with no test recorded in this iteration is `idle`: asked once through
  `flags.repeated`, then review proceeds regardless. A null fingerprint (no git, deadline)
  never counts as unchanged.

## Git closure (`src/shell/git.mjs`)

- Verified on **facts** (clean tree beyond `.omc-loop/`, HEAD not ahead of upstream), never
  on exit codes. `underLoop` matches by path **prefix** (a `src/omc-loop-helper.js` is real
  work) and handles renames on both sides.
- Facts are usable only after successful Git queries. Timeouts, unavailable Git, failed
  status reads and missing ahead counts cannot confirm closure. A push must succeed as
  well as leave HEAD not ahead. Staging/exclusion failures stop before commit. When the
  facts say "not committed" and `git commit` itself failed, its last stderr line goes into
  `error` (identity unknown, hooks, locked index): the human reads it in the notification
  and in ESCALATION, never a bare "not verified".
- `--no-push`: confirmed by the local commit alone; HEAD staying ahead is the user's choice.
- Baseline-dirty files and a missing successful external opinion go into the **commit
  body**: durable, unlike notifications.

## Run archive and journal (`src/shell/archive.mjs`, `src/shell/journal.mjs`)

- `.omc-loop/` is never just deleted at the end: `archiveRun` moves it to
  `~/.perseveranza/runs/<project>/<stamp>-<unique>/` with a `summary.json`.
  On archive failure, keep every remaining artifact in place and rename `state.json`
  to `state.disarmed.json` so the hook becomes dormant; never delete an unarchived gate.
  `status` explains recovery, `disarm` retries the archive and `arm` (including `--force`)
  refuses to overwrite a retained run. If even the state rename fails, report that the
  loop could not be disarmed. The explicit `disarm --no-archive` still permits deletion.
  Journal entries normally precede archival; failures are logged in the retained gate.
  `rename` is refused across volumes (`EXDEV`) and, on Windows, while an indexer, an
  antivirus or a sync client (Google Drive, OneDrive) holds a file of the gate open
  (`EPERM`/`EBUSY`/`EACCES`): lock codes get a few short retries, then both cases copy
  completely before publishing the summary and removing originals. A partial copy is
  removed; incomplete archives are excluded from `runs list`. If the copy is complete but
  the locked originals cannot be removed, the run is published once, `state.json` is
  deleted so the hook is dormant, and the result carries `leftover` (never a retained run:
  a retry would duplicate the archive). Any other rename error retains the run.
- `journal.jsonl` is append-only JSON lines; `readJournal` tolerates unparseable lines.
  `history` renders it; a new entry type needs a `formatEntry` case.
- `PERSEVERANZA_HOME` overrides `~/.perseveranza` (tests use it: never touch the real home).

## Budget (`src/core/budget.mjs`)

- `canContinue` is the ONLY judge: iterations (+3 grace on the exit ramp) and tokens (only
  when `--budget-tokens` was set and the transcript was readable).
- Adaptive `maxIterations` (`8 + 3 × steps`, cap 60) is set once, on the plan → implement
  transition, only when `--max` was not explicit (`limits.maxIterationsExplicit`).
- Token usage (`shell/transcript.mjs`) is best-effort: assistant entries' `message.usage`
  since `armedAt`. Unreadable → `null` → iterations only. Never make the loop depend on it.

## Prompt pack (`src/core/prompts.mjs`, `src/shell/packs.mjs`)

- Layers, strongest first: `OMC_PROMPT_PACK` > `.omc-loop/prompts.json` > `packs/<lang>.json`
  > defaults. `renderPrompt` never throws: unknown key → `''`, unknown placeholder → literal.
- `PROMPT_VARS` declares the placeholders each key may use; `prompts validate` and a unit
  test enforce it. `packs/it.json` must stay a **complete** override (packaging test).
- Every phase instruction is a key + `P('key', vars)`: never an inline template literal.
  The progress header is prepended by the machine, never by a template.
- Defaults change only by deliberate decision with evidence (bench), never by drift; the
  operative verbs (`{{LOOP}} claim-done`, `complexity`, `report`, `test --`) are asserted
  by tests in both languages.

## Providers (`src/providers/`)

- Single source of truth: registry entry = detection + invocation + models. The prompt
  **never goes through a shell**: `cmdline()` (fixed flags, prompt on stdin) or `argv()`
  (pure argv, no shell). `claude`/`grok`/`cursor` run with an isolated `cwd` (a `claude -p`
  in the project dir would load OUR hook). `isolated: true` allocates a fresh empty
  directory with `mkdtempSync` per invocation; `finally` attempts cleanup on success,
  nonzero exit, timeout and spawn exception. A dedicated cwd is not a sandbox.
- Detecting ≠ working: `providers check` probes and writes the denylist with a reason;
  `providers enable` undoes. A refusal/timeout is never a finding.
- `OLLAMA_API_KEY` lives only in env or `~/.perseveranza/config.json`; host validated
  (http/https) before the key is sent; never written to artifacts.

## HUD (`src/hud/`)

- `hud on` composes with the existing statusline (base saved in the config, restored by
  `hud off`) and points `settings.json` at the stable wrapper in `~/.perseveranza/`; the
  resolver finds the newest installed `statusline.mjs` (plugin cache, marketplace clone,
  manual install).
- Ownership matches our actual wrapper command, never a generic `statusline.mjs` name.
  `hud off` preserves foreign settings byte for byte and is idempotent. The complete
  original statusLine object is restored; malformed settings are never overwritten.
- The statusline must stay fast: no synchronous network; the update check spawns detached
  with a `wx` lock.

## Packaging

- `manifest.mjs` is the ONLY list of shipped files: `install.mjs` copies/removes exactly it;
  a packaging test fails when a file under `src/` or `packs/` is not listed, or a listed
  file is missing, or `hooks.json` does not point at `HOOK_ENTRY`.
- Plugin and manual install **never together**: two Stop hooks would advance the loop twice.
- Version lives in `.claude-plugin/plugin.json`, `package.json` and both README badges (test).

## Tests (`test/`)

- `unit/` is the core with no processes; `verbs/` runs the CLI in temp projects; `e2e/`
  drives the real hook with fake Stop events and a local bare remote; `packaging/` checks
  manifest, docs and the installer. `test/run.mjs` passes explicit files to `node --test`
  (Node 20 and 22 differ on directory/glob handling).
- Every test gets its own `PERSEVERANZA_HOME` and `OMC_LOOP_NO_NOTIFY=1`.
