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
| External opinion timeout | 3 min | `OMC_ASK_TIMEOUT_MS`, or `providers.timeouts.<id>` in the config | opinion recorded ERROR in `external-*.md` |
| Session takeover | 6 h | `OMC_SESSION_TAKEOVER_MS` | another session takes over from the current phase |

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
- **It got stuck** → read `.omc-loop/ESCALATION.md`, fix, `resume`.
- **What happened** → `history`, and after the end `runs show <id>`.
