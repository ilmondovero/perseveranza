"""Evaluator of the perseveranza-bench (SIA contract: evaluate(submission_path) -> dict).

Reads submission.json (written by the target agent), runs the HIDDEN tests of data/private/
inside the workdir of every mini-task run and computes the score:

  per run   = 0.60 * hidden_tests_green          (the substance: is the code right?)
            + 0.25 * autonomous_closure          (did the loop get to the end by itself?)
            + 0.15 * (1 - iterations/max)        (efficiency: fewer rounds, better)
            - 0.20 if escalation/pause           (it asked a human for help)
  per task  = mean over its repetitions (BENCH_REPEATS), with the sample std as noise
  total     = mean over the EXPECTED tasks (a task missing from the submission counts 0).

The target agent must NEVER read data/private: the hidden tests are the ground truth.
"""

import json
import statistics
import subprocess
from pathlib import Path

TASK_DIR = Path(__file__).resolve().parent.parent.parent  # .../bench/task
PRIVATE = TASK_DIR / "data" / "private"
EXPECTED = ["t1-slugify", "t2-bugfix", "t3-refactor"]
HIDDEN_TIMEOUT_S = 120
DEFAULT_LOOP_MAX = 14


def _run_hidden(name: str, workdir: Path) -> bool:
    hidden = PRIVATE / f"{name}.hidden.mjs"
    if not hidden.exists() or not workdir.is_dir():
        return False
    try:
        r = subprocess.run(["node", str(hidden)], cwd=workdir, capture_output=True, text=True, timeout=HIDDEN_TIMEOUT_S)
        return r.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        return False


def _score_run(name: str, t: dict) -> dict:
    if t.get("contaminated"):
        return {"score": 0.0, "contaminated": True, "note": "templates contaminated during the run: invalid measure"}
    workdir = Path(str(t.get("workdir", "")))
    hidden_ok = _run_hidden(name, workdir)
    closed = bool(t.get("closed"))
    escalated = bool(t.get("escalated"))
    loop_max = t.get("max") or DEFAULT_LOOP_MAX
    iters = t.get("iterations")
    eff = 0.0 if not isinstance(iters, (int, float)) else max(0.0, 1.0 - min(iters, loop_max) / loop_max)
    score = 0.60 * (1.0 if hidden_ok else 0.0) + 0.25 * (1.0 if closed else 0.0) + 0.15 * eff
    if escalated:
        score -= 0.20
    return {"score": max(0.0, min(1.0, score)), "hidden_ok": hidden_ok, "closed": closed,
            "iterations": iters, "tokens": t.get("tokens"), "escalated": escalated}


def evaluate(submission_path: Path) -> dict:
    sub = json.loads(Path(submission_path).read_text(encoding="utf-8"))
    by_name: dict[str, list] = {}
    for t in sub.get("tasks", []):
        if isinstance(t, dict) and t.get("name"):
            by_name.setdefault(t["name"], []).append(t)

    per_task = []
    for name in EXPECTED:
        runs = by_name.get(name, [])
        if not runs:
            per_task.append({"name": name, "score": 0.0, "runs": 0, "note": "missing from the submission"})
            continue
        scored = [_score_run(name, t) for t in runs]
        scores = [s["score"] for s in scored]
        entry = {
            "name": name,
            "score": round(sum(scores) / len(scores), 4),
            "runs": len(scores),
            "noise": round(statistics.stdev(scores), 4) if len(scores) > 1 else None,
            "hidden_ok": sum(1 for s in scored if s.get("hidden_ok")),
            "closed": sum(1 for s in scored if s.get("closed")),
            "escalated": sum(1 for s in scored if s.get("escalated")),
            "iterations": [s.get("iterations") for s in scored],
            "tokens": [s.get("tokens") for s in scored],
        }
        if any(s.get("contaminated") for s in scored):
            entry["contaminated"] = True
        per_task.append(entry)

    total = sum(t["score"] for t in per_task) / len(EXPECTED) if EXPECTED else 0.0
    return {"score": round(total, 4), "engine": sub.get("engine"), "repeats": sub.get("repeats", 1), "tasks": per_task}


def main():
    import argparse
    import sys

    parser = argparse.ArgumentParser()
    parser.add_argument("--gen-dir", type=Path, required=True)
    args = parser.parse_args()
    submission = args.gen_dir / "submission.json"
    if not submission.exists():
        print(f"Error: {submission} not found")
        sys.exit(1)
    results = evaluate(submission)
    (args.gen_dir / "results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"Score: {results['score']}")
    for t in results["tasks"]:
        noise = f" ±{t['noise']}" if t.get("noise") is not None else ""
        print(f"  {t['name']}: {t['score']}{noise}")


if __name__ == "__main__":
    main()
