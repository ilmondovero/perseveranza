# Budget, kill switch, escalation

An autonomous loop needs spending caps and a fast way to stop it. Perseveranza v2 counts
**iterations** (always) and **tokens** (when a cap is set and the session transcript is
readable), plus timeouts. This page gathers every cap and switch in one place.

## Caps

| cap | default | how to change it | what happens at the limit |
|---|---|---|---|
| Iterations | adaptive: `8 + 3 × steps` (max 60), or 25 before the plan | `--max N` at arm (then never adapted) | loop archived + disarmed + notification |
| Exit-ramp grace | +3 iterations in cleanup / final-verify / git-finish | fixed | a loop that finished the work is not killed one step short of its verification |
| Tokens | none | `--budget-tokens N` at arm | loop archived + disarmed + notification |
| Fixes per step (review) | 3 | `--max-retries N` | **pause** + `ESCALATION.md` at the next failure |
| Final rejections | 3 | `--max-retries N` | **pause** + `ESCALATION.md` at the next failure |
| Hook deadline | 120 s | `OMC_HOOK_TIMEOUT_MS` (keep `hooks.json` in sync) | git closure paused in `git-finish` by decision, never by kill |
| Push cap inside the deadline | 45 s | fixed | closure not confirmed → pause, `resume` retries |
| Test run timeout | 30 min | `OMC_TEST_TIMEOUT_MS` | test recorded red (exit 124) |
| External opinion timeout | 3 min | `OMC_ASK_TIMEOUT_MS`, or `providers.timeouts.<id>` in the config | opinion recorded ERROR in `external-*.md`, with the hint on how to raise it |
| External opinion retries | 1 (timeouts and network errors only) | `OMC_ASK_RETRIES` (0–5) | the error of the last attempt is recorded, with the attempt count |
| Activity hook cost | ~50–150 ms per matched tool call (a Node start), twice for the working tools (PreToolUse and PostToolUse), armed or not, in every project once the plugin is installed | matchers in `hooks/hooks.json` (`Agent\|Task\|Bash\|PowerShell\|Edit\|Write\|MultiEdit\|NotebookEdit`; Read/Grep/Glob excluded on purpose) | the dormant check runs before any import beyond `node:fs`; this is the price of a heartbeat inside the turn and of the read-only enforcement after a restore. Tools outside the matcher (MCP writers) are not refused during a reconciliation: a known limit |
| Stale loop | 30 min without a sign of life (Stop, tool activity of the owner, transcript write) | `OMC_LOOP_STALE_MS` | `status`/HUD flag it `STALE`, the journal records a `gap`, the `SessionStart` hook asks a new session whether to take over (`resume --takeover`, valid for the same window) or disarm; nothing happens by itself. A paused loop is never stale. A detached watchdog (spawned at every Stop and at `arm`, `OMC_LOOP_NO_WATCHDOG=1` disables it) notifies and journals `watchdog` when the silence is real |
| Kill and restore | off | `OMC_LOOP_RESTORE=1` | the watchdog alerts at the stale threshold and, after a second one (`OMC_LOOP_RESTORE_AFTER_MS`, default 2× stale = 60 min) still without a sign of life, terminates the recorded Claude Code process tree and reopens the session (`claude -r <id> "<restore prompt>"`) in a new console; at most 3 restores per run; a pid whose start time or command line no longer match is never killed; no recorded process, no relaunch. `OMC_LOOP_CLAUDE_BIN` points at the `claude` binary when it is not on `PATH` |
| Reconciliation after a restore | once | fixed | the restored session must write `.omc-loop/reconcile.json` read-only (mutating tools refused by the PreToolUse hook); a second miss, an `uncertain` disposition or a command still running pause for a human; retry counters untouched |
| Test heartbeat | 60 s | `OMC_ACTIVITY_HEARTBEAT_MS` | the `test` verb refreshes the activity record while the suite runs, so a long suite never looks silent |

An iteration is the unit of spend: every injected phase (plan, implement, review, fix,
verification...) consumes one. Token usage is read from the transcript path that Claude
Code passes to the Stop hook, summing the assistant messages since the arm time; it shows
in the injected header and in `status`, and is stored in the run summary. It is
**best-effort**: if the transcript cannot be read the token cap simply does not apply.

## Kill switch

Three ways to stop the loop, from the softest to the most immediate:

1. **`pause`** — suspends without disarming; `resume` continues.
2. **`disarm`** — archives the run and removes `.omc-loop/`. Clean and final.
3. **Emergency kill switch** — the fastest, needs no node command and works from **any
   session**, even with a corrupt state:
   - create the sentinel file **`.omc-loop/STOP`**, **or**
   - set **`OMC_LOOP_KILL=1`** in the environment.

   At the first Stop the hook finds the switch, archives what it can, disarms and notifies.
   The check runs **before** the session scoping and the corrupt-state path, so there is no
   condition in which the loop can ignore a kill.

## Escalation (hand-off to a human)

When the loop exhausts its fixes (review) or its rejections (final gate) it does not insist
blindly: it **pauses and writes `.omc-loop/ESCALATION.md`**, a hand-off with phase,
attempts, last test, what to look at and how to resume, plus the last journal lines. After
fixing by hand, `resume` continues (and removes the stale hand-off); `disarm` gives up.

## In short

- **Cost under control** → adaptive iterations, `--max`, `--budget-tokens`, `--max-retries`.
- **Fast stop** → `.omc-loop/STOP` or `OMC_LOOP_KILL=1`.
- **The owner session is gone** (`status` says `STALE`, or a new session got the
  SessionStart notice) → `resume --takeover` from the session that will continue, or
  `disarm` (its recap says which steps were left open).
- **It got stuck** → read `.omc-loop/ESCALATION.md`, fix, `resume`.
- **What happened** → `history`, and after the end `runs show <id>`.
