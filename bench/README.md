# perseveranza-bench — evolvere il prompt pack con SIA

Esperimento di self-improvement: [SIA](https://github.com/hexo-ai/sia) fa evolvere il
**prompt pack** di perseveranza (v1.18.0+) misurandolo su una batteria di mini-task con
test nascosti. Questo NON fa parte del runtime del plugin: è tooling di sviluppo.

## Come funziona

- Il **target agent** (`task/reference/target_agent.py`, seed della generazione 1) porta
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
- env `PERSEVERANZA_ROOT` = path del repo perseveranza (per gli script del loop).

## Lancio

```powershell
$env:PERSEVERANZA_ROOT = "C:\2026\perseveranza"
sia run --task_dir C:\2026\perseveranza\bench\task --max_gen 3 --run_id 1
```

Tuning: `BENCH_LOOP_MODEL` (default `sonnet`), `BENCH_LOOP_TIMEOUT_S` (default 900 per
mini-task), `BENCH_LOOP_MAX` (default 10 iterazioni per loop).

⚠ **Costi**: ogni generazione = 3 loop perseveranza completi (usage dell'abbonamento
Claude) + le chiamate del meta/feedback agent di SIA. Partire con `--max_gen 3`.

## Adozione dei risultati

I pack delle generazioni vivono in `runs/run_*/gen_*/target_agent.py` con la motivazione
delle mutazioni in `improvement.md`. Un pack vincente NON si adotta alla cieca: si fa il
diff con i default in `scripts/prompts.mjs`, si giudica a mano, e si porta nei default con
la suite (`node scripts/test.mjs`) a guardia. SIA propone, il maker/checker restiamo noi.
