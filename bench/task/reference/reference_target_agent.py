"""Target agent del perseveranza-bench (seed della generazione 1).

Esegue i 3 mini-task armando un loop perseveranza HEADLESS (claude -p) in una copia
usa-e-getta di ciascun template, applica PROMPT_PACK come override delle istruzioni
(.omc-loop/prompts.json) e scrive submission.json con gli esiti misurati.

LA SUPERFICIE DI EVOLUZIONE E' PROMPT_PACK: il feedback agent migliora i template
delle istruzioni del loop (chiavi e placeholder: vedi task.md). La meccanica di
esecuzione qui sotto va lasciata intatta salvo bug reali; NON leggere data/private,
NON modificare i mini-task ne' i loro test: e' barare, e i test nascosti lo scoprono.
"""

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

# ====================== SUPERFICIE DI EVOLUZIONE ======================
# Override dei template di scripts/prompts.mjs del plugin. Generazione 1:
# vuoto = default del plugin. Esempio di mutazione:
#   PROMPT_PACK = {"prompts": {"implement-first": "FASE: implement. ... {{implHint}}"}}
PROMPT_PACK = {"prompts": {}}
# ======================================================================

ROOT = Path(os.environ["PERSEVERANZA_ROOT"])  # obbligatoria: path del repo perseveranza
LOOP_MJS = ROOT / "scripts" / "omc-loop.mjs"
MINITASKS = ROOT / "bench" / "task" / "data" / "public" / "minitasks"
EXPECTED = ["t1-slugify", "t2-bugfix", "t3-refactor"]

MODEL = os.environ.get("BENCH_LOOP_MODEL", "sonnet")
TIMEOUT_S = int(os.environ.get("BENCH_LOOP_TIMEOUT_S", "900"))
LOOP_MAX = int(os.environ.get("BENCH_LOOP_MAX", "10"))
POLL_S = 5
KICK = (
    "Il ciclo perseveranza e' armato in questa directory: sei tu la sessione che lo guida. "
    "Comincia dalla fase plan seguendo le istruzioni che lo Stop hook ti iniettera' a ogni fine risposta."
)


def run_minitask(name: str) -> dict:
    template = MINITASKS / name
    work = Path.cwd() / "minitask-runs" / name
    if work.exists():
        shutil.rmtree(work)
    shutil.copytree(template, work)
    task_text = (work / "TASK.txt").read_text(encoding="utf-8").strip()

    # arma il loop: niente esterni (determinismo/costi), niente git, suite visibile come prova
    arm = subprocess.run(
        ["node", str(LOOP_MJS), "arm", task_text, "--max", str(LOOP_MAX),
         "--external", "off", "--no-git-finish", "--test", "node visible/test.mjs"],
        cwd=work, capture_output=True, text=True,
    )
    if arm.returncode != 0:
        return {"name": name, "workdir": str(work), "closed": False,
                "iterations": None, "escalated": False, "max": LOOP_MAX,
                "error": f"arm fallito: {arm.stdout}{arm.stderr}"}

    gate = work / ".omc-loop"
    (gate / "prompts.json").write_text(json.dumps(PROMPT_PACK), encoding="utf-8")

    # loop headless: lo Stop hook del plugin guida le fasi fino a chiusura e disarm.
    # Durante il run campioniamo lo stato (il disarm finale rimuove .omc-loop).
    proc = subprocess.Popen(
        ["claude", "-p", KICK, "--dangerously-skip-permissions", "--model", MODEL],
        cwd=work, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    last_state: dict = {}
    escalated = False
    start = time.time()
    while proc.poll() is None and time.time() - start < TIMEOUT_S:
        time.sleep(POLL_S)
        try:
            last_state = json.loads((gate / "state.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass  # gate gia' rimosso (chiusura) o scrittura concorrente: tengo l'ultimo
        if (gate / "ESCALATION.md").exists() or last_state.get("paused"):
            escalated = True
    timed_out = proc.poll() is None
    if timed_out:
        proc.kill()

    return {
        "name": name,
        "workdir": str(work),
        "closed": (not gate.exists()) and not timed_out,  # disarm a fine progetto = convergenza
        "iterations": last_state.get("iterations"),
        "escalated": escalated,
        "timed_out": timed_out,
        "max": LOOP_MAX,
    }


def main():
    results = []
    for name in EXPECTED:
        print(f"[bench] mini-task {name}...", flush=True)
        t = run_minitask(name)
        print(f"[bench]   closed={t['closed']} iterations={t['iterations']} escalated={t['escalated']}", flush=True)
        results.append(t)
    Path("submission.json").write_text(json.dumps({"tasks": results}, indent=2), encoding="utf-8")
    print("[bench] submission.json scritta")


if __name__ == "__main__":
    main()
