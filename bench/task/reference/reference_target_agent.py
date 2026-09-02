"""Target agent of the perseveranza-bench (seed of generation 1).

Runs the 3 mini-tasks by arming a HEADLESS perseveranza loop (claude -p) in a throw-away
copy of each template, applies PROMPT_PACK as an override of the instructions
(.omc-loop/prompts.json) and writes submission.json with the measured outcomes.

THE EVOLUTION SURFACE IS PROMPT_PACK: the feedback agent improves the loop's instruction
templates (keys and placeholders: see task.md). The execution mechanics below must stay
intact except for real bugs; NEVER read data/private, NEVER modify the mini-tasks or their
tests: that is cheating, and the hidden tests catch it.

Engine v2 (perseveranza >= 2.0.0):
  - the loop CLI is src/cli/omc-loop.mjs, the journal is .omc-loop/journal.jsonl;
  - each mini-task can be repeated BENCH_REPEATS times (default 1): the submission carries
    one entry per repetition and evaluate.py averages per task, so the noise that dominated
    single-run measurements (see bench/README.md) can be estimated;
  - `--dry-run` exercises the runner and the evaluator without `claude` (CI self-check).
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

# stdout/stderr ALWAYS utf-8: on Windows the cp1252 default crashes any print with unicode
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass

# ====================== EVOLUTION SURFACE ======================
# Overrides of the plugin's src/core/prompts.mjs templates. Generation 1: empty = plugin
# defaults. Example mutation:
#   PROMPT_PACK = {"prompts": {"implement-first": "PHASE: implement. ... {{implHint}}"}}
PROMPT_PACK = {"prompts": {}}
# ===============================================================

# SIA INVOCATION CONTRACT (orchestrator.py):
#   target_agent.py --dataset_dir <task>/data/public --working_dir <gen_dir>
# These arguments are ALREADY handled below: do NOT rewrite the path resolution.
_ap = argparse.ArgumentParser()
_ap.add_argument("--dataset_dir", default=None)
_ap.add_argument("--working_dir", default=None)
_ap.add_argument("--dry-run", action="store_true", help="no claude: fake loops, check runner + evaluator")
_ARGS, _ = _ap.parse_known_args()

ROOT = Path(os.environ["PERSEVERANZA_ROOT"])  # plugin repo: loop CLI + contamination guard
LOOP_MJS = ROOT / "src" / "cli" / "omc-loop.mjs"
DATASET = Path(_ARGS.dataset_dir) if _ARGS.dataset_dir else ROOT / "bench" / "task" / "data" / "public"
MINITASKS = DATASET / "minitasks"
WORKROOT = Path(_ARGS.working_dir) if _ARGS.working_dir else Path.cwd()
EXPECTED = ["t1-slugify", "t2-bugfix", "t3-refactor"]

MODEL = os.environ.get("BENCH_LOOP_MODEL", "sonnet")
TIMEOUT_S = int(os.environ.get("BENCH_LOOP_TIMEOUT_S", "1800"))   # 900 killed healthy loops
LOOP_MAX = int(os.environ.get("BENCH_LOOP_MAX", "14"))             # a perfect run already needs ~7 fires
REPEATS = max(1, int(os.environ.get("BENCH_REPEATS", "1")))
POLL_S = 2
KICK = (
    "The perseveranza loop is armed in this directory: you are the session driving it. "
    "Start from the plan phase following the instructions the Stop hook injects at the end of every response. "
    "CONSTRAINT: work EXCLUSIVELY inside this directory; do not read or modify files outside it "
    "(in particular the perseveranza plugin repo and its bench/templates)."
)

# ENGINE VERSION GUARD. The loops are driven by the INSTALLED plugin's Stop hook, not by the
# repo's scripts: with an engine < 2.0.0 the pack layout, the journal and the verbs differ and
# every measure is invalid (runs 1-4 of the v1 bench ran on 1.12.0: results thrown away).
REQUIRED_ENGINE = (2, 0, 0)


def installed_engine_version():
    """Version of the installed perseveranza plugin, from Claude Code's registry."""
    reg = Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")) / "plugins" / "installed_plugins.json"
    try:
        data = json.loads(reg.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    def find(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k == "perseveranza@perseveranza" and isinstance(v, list) and v:
                    return str(v[0].get("version", ""))
                got = find(v)
                if got:
                    return got
        elif isinstance(node, list):
            for item in node:
                got = find(item)
                if got:
                    return got
        return None

    return find(data)


def repo_engine_version():
    try:
        return json.loads((ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8")).get("version")
    except (OSError, json.JSONDecodeError):
        return None


def require_engine():
    if _ARGS.dry_run:
        engine = repo_engine_version() or "0.0.0"
        print(f"[bench] dry run: engine = repo {engine}", flush=True)
        return engine
    engine = installed_engine_version()
    parts = tuple(int(x) for x in (engine or "").split(".")[:3] if x.isdigit())
    if len(parts) < 3 or parts < REQUIRED_ENGINE:
        print(f"[bench] ERROR: installed perseveranza plugin = {engine or 'not found'}; "
              f"need >= {'.'.join(map(str, REQUIRED_ENGINE))} or the measure is invalid. "
              f"Update: claude plugin update perseveranza@perseveranza")
        sys.exit(1)
    print(f"[bench] engine: perseveranza {engine} (installed)", flush=True)
    return engine


def read_journal(path: Path):
    entries = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    except OSError:
        pass
    return entries


def dry_loop(work: Path, name: str):
    """No claude: simulate a converged loop (drive the real hook with fake Stop events)."""
    hook = ROOT / "src" / "shell" / "stop.mjs"
    env = {**os.environ, "OMC_LOOP_NO_NOTIFY": "1", "OMC_NO_UPDATE_CHECK": "1",
           "PERSEVERANZA_HOME": str(WORKROOT / "prs-home")}

    def fire():
        subprocess.run(["node", str(hook)], input=json.dumps({"cwd": str(work), "session_id": "dry"}),
                       cwd=work, capture_output=True, text=True, env=env, timeout=120)

    gate = work / ".omc-loop"
    fire()                                             # plan-write
    (gate / "plan.md").write_text("- [ ] do it\n", encoding="utf-8")
    fire()                                             # -> implement
    fire()                                             # -> review
    (gate / "review.json").write_text('{"blocking":0}', encoding="utf-8")
    fire()                                             # -> implement (advance)
    (gate / "plan.md").write_text("- [x] do it\n", encoding="utf-8")
    subprocess.run(["node", str(LOOP_MJS), "claim-done"], cwd=work, capture_output=True, text=True, env=env)
    fire()                                             # -> cleanup (no suite configured in dry run)
    fire()                                             # -> final-verify
    (gate / "verify.json").write_text('{"pass":true}', encoding="utf-8")
    fire()                                             # -> done: archived + disarmed


def run_minitask(name: str, repeat: int) -> dict:
    template = MINITASKS / name
    work = WORKROOT / "minitask-runs" / (name if REPEATS == 1 else f"{name}.r{repeat}")
    if work.exists():
        shutil.rmtree(work)
    shutil.copytree(template, work)
    task_text = (work / "TASK.txt").read_text(encoding="utf-8").strip()
    env = {**os.environ, "OMC_LOOP_NO_NOTIFY": "1", "OMC_NO_UPDATE_CHECK": "1"}
    if _ARGS.dry_run:
        env["PERSEVERANZA_HOME"] = str(WORKROOT / "prs-home")

    arm_args = ["node", str(LOOP_MJS), "arm", task_text, "--max", str(LOOP_MAX),
                "--external", "off", "--no-git-finish", "--lang", "en"]
    if not _ARGS.dry_run:
        arm_args += ["--test", "node visible/test.mjs"]
    arm = subprocess.run(arm_args, cwd=work, capture_output=True, text=True, env=env)
    if arm.returncode != 0:
        return {"name": name, "repeat": repeat, "workdir": str(work), "closed": False,
                "iterations": None, "escalated": False, "max": LOOP_MAX,
                "error": f"arm failed: {arm.stdout}{arm.stderr}"}

    gate = work / ".omc-loop"
    (gate / "prompts.json").write_text(json.dumps(PROMPT_PACK), encoding="utf-8")
    journal_copy = work.parent / f"{work.name}.journal.jsonl"  # survives the archive/disarm

    escalated = False
    timed_out = False
    if _ARGS.dry_run:
        dry_loop(work, name)
    else:
        proc = subprocess.Popen(
            ["claude", "-p", KICK, "--dangerously-skip-permissions", "--model", MODEL],
            cwd=work, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env,
        )
        start = time.time()
        while proc.poll() is None and time.time() - start < TIMEOUT_S:
            time.sleep(POLL_S)
            try:
                shutil.copy2(gate / "journal.jsonl", journal_copy)
            except OSError:
                pass
            if (gate / "ESCALATION.md").exists():
                escalated = True
            try:
                st = json.loads((gate / "state.json").read_text(encoding="utf-8"))
                if st.get("signals", {}).get("paused"):
                    escalated = True
            except (OSError, json.JSONDecodeError, AttributeError):
                pass
        timed_out = proc.poll() is None
        if timed_out:
            proc.kill()

    # PRECISE iterations and outcome from the journal. The archive keeps the full journal
    # under ~/.perseveranza/runs (or PERSEVERANZA_HOME): prefer it, fall back to the copy.
    journal = []
    home = Path(env.get("PERSEVERANZA_HOME", Path.home() / ".perseveranza"))
    runs = sorted((home / "runs" / work.name).glob("*/omc-loop/journal.jsonl")) if (home / "runs" / work.name).exists() else []
    if runs:
        journal = read_journal(runs[-1])
    if not journal:
        journal = read_journal(journal_copy)
    iterations = max([int(e.get("iteration", 0)) for e in journal if e.get("type") == "transition"] or [0]) or None
    done = any(e.get("type") == "done" for e in journal)
    tokens = next((e.get("tokens") for e in reversed(journal) if e.get("type") == "done"), None)
    if any(e.get("type") == "transition" and e.get("paused") for e in journal):
        escalated = True

    # anti-contamination guard: if the loop touched the TEMPLATES in the repo the measure is
    # invalid. Detect via git, RESTORE and flag: evaluate.py zeroes the task.
    contaminated = False
    try:
        dirty = subprocess.run(
            ["git", "-C", str(ROOT), "status", "--porcelain", "--", "bench/task/data/public/minitasks"],
            capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        if dirty:
            contaminated = True
            subprocess.run(["git", "-C", str(ROOT), "checkout", "--", "bench/task/data/public/minitasks"],
                           capture_output=True, text=True, timeout=30)
            print(f"[bench]   CONTAMINATION detected and restored: {dirty.splitlines()[0]}...", flush=True)
    except (OSError, subprocess.TimeoutExpired):
        pass

    return {
        "name": name,
        "repeat": repeat,
        "workdir": str(work),
        "closed": done and (not gate.exists()) and not timed_out,   # archived + disarmed = convergence
        "iterations": iterations,
        "tokens": tokens,
        "escalated": escalated,
        "timed_out": timed_out,
        "contaminated": contaminated,
        "max": LOOP_MAX,
    }


def main():
    engine = require_engine()
    if not MINITASKS.is_dir():
        print(f"[bench] ERROR: minitasks not found in {MINITASKS} (check --dataset_dir)")
        sys.exit(1)
    results = []
    for name in EXPECTED:
        for repeat in range(1, REPEATS + 1):
            print(f"[bench] mini-task {name}{f' (repeat {repeat}/{REPEATS})' if REPEATS > 1 else ''}...", flush=True)
            t = run_minitask(name, repeat)
            print(f"[bench]   closed={t['closed']} iterations={t['iterations']} escalated={t['escalated']}", flush=True)
            results.append(t)
    WORKROOT.mkdir(parents=True, exist_ok=True)
    (WORKROOT / "submission.json").write_text(
        json.dumps({"engine": engine, "repeats": REPEATS, "dry_run": _ARGS.dry_run, "tasks": results}, indent=2),
        encoding="utf-8")
    print("[bench] submission.json written")
    if _ARGS.dry_run:
        sys.path.insert(0, str(DATASET))
        import evaluate  # noqa: E402  (the public evaluator)
        res = evaluate.evaluate(WORKROOT / "submission.json")
        print(f"[bench] dry-run evaluate: score={res['score']} (hidden tests are expected to fail on untouched templates)")
        for t in res["tasks"]:
            if not t.get("closed", False):
                print(f"[bench] ERROR: dry loop for {t['name']} did not close")
                sys.exit(1)
        print("[bench] dry run OK: runner and evaluator work")


if __name__ == "__main__":
    main()
