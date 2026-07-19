# perseveranza-bench — evolvere il prompt pack con SIA

Esperimento di self-improvement: [SIA](https://github.com/hexo-ai/sia) fa evolvere il
**prompt pack** di perseveranza (v1.18.0+) misurandolo su una batteria di mini-task con
test nascosti. Questo NON fa parte del runtime del plugin: è tooling di sviluppo.

## Come funziona

- Il **target agent** (`task/reference/reference_target_agent.py`, seed della generazione 1) porta
  con sé un `PROMPT_PACK` (gen 1: vuoto = default del plugin), esegue i 3 mini-task di
  `task/data/public/minitasks/` armando un loop perseveranza **headless** (`claude -p`)
  in una copia usa-e-getta di ciascuno, e scrive `submission.json` con gli esiti.
- `task/data/public/evaluate.py` esegue i **test nascosti** (`task/data/private/`) sul
  lavoro prodotto da ogni loop e calcola lo score (test verdi + convergenza autonoma −
  iterazioni − escalation) in `results.json`.
- Il **feedback agent** di SIA legge log e score e **muta il `PROMPT_PACK`** della
  generazione successiva. Il routing del loop non è mutabile: solo i testi.

"Nascosti" = mai visti dal loop durante il run (vivono fuori dalla sua directory);
non sono un segreto per gli umani.

## Prerequisiti

- perseveranza installato (il plugin) e CLI `claude` autenticata (abbonamento: nessuna
  `ANTHROPIC_API_KEY` necessaria — verificato: SDK e orchestrator al massimo avvisano);
- `py -m pip install "sia-agent[claude]"` (Python 3.11+);
- env `PERSEVERANZA_ROOT` = path del repo perseveranza (per gli script del loop);
- ⚠ **su Windows**: SIA 0.5.1 costruisce i path del venv alla POSIX (`venv/bin/python`):
  vanno patchate le due funzioni `venv_python_path`/`venv_pip_path` nel `layout.py`
  installato (site-packages) per usare `Scripts\` su `os.name == "nt"` — 4 righe,
  da segnalare upstream;
- ⚠ **su Windows**: lanciare con **`PYTHONUTF8=1`** nell'ambiente: lo stdout cp1252 fa
  crashare i target agent generati appena stampano un simbolo unicode (visto nel run 2:
  `UnicodeEncodeError` su `✓`). Il reference si difende da solo (`reconfigure utf-8`),
  ma i rigenerati ereditano solo l'ambiente.

## Lancio

```powershell
$env:PERSEVERANZA_ROOT = "C:\2026\perseveranza"
sia run --task_dir C:\2026\perseveranza\bench\task --max_gen 3 --run_id 1
```

Tuning: `BENCH_LOOP_MODEL` (default `sonnet`), `BENCH_LOOP_TIMEOUT_S` (default 900 per
mini-task), `BENCH_LOOP_MAX` (default 10 iterazioni per loop).

⚠ **Costi**: ogni generazione = 3 loop perseveranza completi (usage dell'abbonamento
Claude) + le chiamate del meta/feedback agent di SIA. Partire con `--max_gen 3`.

## Lezioni del run pilota 1 → guardrail v2

Il primo run (baseline 0.5333 con pack default; prima mutazione 0.41, peggiorativa) ha
insegnato quattro cose, ora codificate nel bench:

1. **t3 misurabile**: i test nascosti verificano anche la *struttura* (dedup reale: le
   occorrenze della logica comune nel sorgente), non solo il comportamento;
2. **iterazioni precise** dalla copia di `history.log` (il polling dello stato perdeva
   gli ultimi incrementi);
3. **guard anti-contaminazione**: nel run 1 un loop ha riscritto un template *nel repo*
   (conosceva il path dall'istruzione iniettata). Ora: vincolo di confinamento nel kick
   prompt + check git post-run con auto-ripristino + task contaminato = score 0;
4. **vincolo sui verbi operativi** in `task.md`: le mutazioni del pack devono preservare
   i comandi che fanno avanzare il loop — la gen_3 li aveva riscritti in "coaching"
   perdendoli, ed è crollata (evidenza citata nel task stesso).

`--max` dei loop portato da 10 a **14**: un run perfetto con la rampa d'uscita completa
consuma già ~7 fire, e la baseline mostrava lavoro corretto senza chiusura formale.

## Adozione dei risultati

I pack delle generazioni vivono in `runs/run_*/gen_*/target_agent.py` con la motivazione
delle mutazioni in `improvement.md`. Un pack vincente NON si adotta alla cieca: si fa il
diff con i default in `scripts/prompts.mjs`, si giudica a mano, e si porta nei default con
la suite (`node scripts/test.mjs`) a guardia. SIA propone, il maker/checker restiamo noi.
