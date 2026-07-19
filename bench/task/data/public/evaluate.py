"""Valutatore del perseveranza-bench (contratto SIA: evaluate(submission_path) -> dict).

Legge submission.json (scritto dal target agent), esegue i test NASCOSTI di
data/private/ dentro il workdir di ogni mini-task e calcola lo score:

  per task = 0.60 * test_nascosti_verdi          (la sostanza: il codice e' giusto?)
           + 0.25 * chiusura_autonoma            (il loop e' arrivato in fondo da solo?)
           + 0.15 * (1 - iterazioni/max)         (efficienza: meno giri, meglio)
           - 0.20 se escalation/pausa            (ha chiesto aiuto all'umano)
  totale  = media sui task ATTESI (un task mancante nella submission vale 0).

Il target agent non deve MAI leggere data/private: i test nascosti sono la ground truth.
"""

import json
import subprocess
from pathlib import Path

TASK_DIR = Path(__file__).resolve().parent.parent.parent  # .../bench/task
PRIVATE = TASK_DIR / "data" / "private"
EXPECTED = ["t1-slugify", "t2-bugfix", "t3-refactor"]
HIDDEN_TIMEOUT_S = 120
DEFAULT_LOOP_MAX = 10


def _run_hidden(name: str, workdir: Path) -> bool:
    """Esegue il test nascosto del mini-task con cwd nel workdir del loop."""
    hidden = PRIVATE / f"{name}.hidden.mjs"
    if not hidden.exists() or not workdir.is_dir():
        return False
    try:
        r = subprocess.run(
            ["node", str(hidden)], cwd=workdir,
            capture_output=True, text=True, timeout=HIDDEN_TIMEOUT_S,
        )
        return r.returncode == 0
    except (subprocess.TimeoutExpired, OSError):
        return False


def evaluate(submission_path: Path) -> dict:
    sub = json.loads(Path(submission_path).read_text(encoding="utf-8"))
    by_name = {t.get("name"): t for t in sub.get("tasks", []) if isinstance(t, dict)}

    per_task = []
    for name in EXPECTED:
        t = by_name.get(name)
        if not t:
            per_task.append({"name": name, "score": 0.0, "note": "assente dalla submission"})
            continue
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
        score = max(0.0, min(1.0, score))
        per_task.append({
            "name": name, "score": round(score, 4), "hidden_ok": hidden_ok,
            "closed": closed, "iterations": iters, "escalated": escalated,
        })

    total = sum(t["score"] for t in per_task) / len(EXPECTED) if EXPECTED else 0.0
    return {"score": round(total, 4), "tasks": per_task}


def main():
    import argparse
    import sys

    parser = argparse.ArgumentParser()
    parser.add_argument("--gen-dir", type=Path, required=True)
    args = parser.parse_args()

    submission = args.gen_dir / "submission.json"
    if not submission.exists():
        print(f"Errore: {submission} non trovato")
        sys.exit(1)

    results = evaluate(submission)
    (args.gen_dir / "results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"Score: {results['score']}")
    for t in results["tasks"]:
        print(f"  {t['name']}: {t['score']}")


if __name__ == "__main__":
    main()
