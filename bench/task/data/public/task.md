# perseveranza-bench: evolvere il prompt pack di un loop di coding autonomo

## Missione

Il sistema da migliorare è **perseveranza**, un loop autonomo per Claude Code
(plan → implement → review → verifica finale avversariale) le cui istruzioni di fase
sono **template sovrascrivibili** ("prompt pack"). Il tuo compito, generazione dopo
generazione, è **migliorare il `PROMPT_PACK`** dentro `target_agent.py` così che i loop
convergano meglio sui 3 mini-task del benchmark: codice corretto (test nascosti verdi),
chiusura autonoma, meno iterazioni, niente escalation.

## Cosa fa il target agent (meccanica: NON evolverla, salvo bug reali)

Il runner viene invocato da SIA come `target_agent.py --dataset_dir <task>/data/public
--working_dir <gen_dir>` e **gestisce già questi argomenti** (minitask in
`<dataset_dir>/minitasks`, output in `<working_dir>`): NON riscrivere la risoluzione dei
path — nei run 1 e 2 la gen_1 è morta esattamente per riscritture di questa logica.

1. per ogni mini-task in `minitasks/` copia il template in un workdir usa-e-getta;
2. arma un loop perseveranza (`--max 10 --external off --no-git-finish`, suite visibile
   come `--test`) e scrive il `PROMPT_PACK` in `.omc-loop/prompts.json`;
3. lancia `claude -p` nel workdir: lo Stop hook del plugin guida le fasi fino a chiusura;
4. misura le iterazioni dalla copia di `history.log` (non dal polling dello stato), verifica
   che i template nel repo non siano stati toccati (contaminazione → ripristino + flag) e
   registra gli esiti in `submission.json`:
   `{"tasks": [{"name", "workdir", "closed", "iterations", "escalated", "contaminated", "max"}]}`
   (un task `contaminated` vale 0, sempre).

## La superficie di evoluzione: PROMPT_PACK

`{"prompts": {"<chiave>": "template con {{placeholder}}"}}`. Chiavi non presenti = default
del plugin. Le chiavi principali (le altre in `scripts/prompts.mjs` del repo):

| chiave | quando viene iniettata | placeholder utili |
|---|---|---|
| `plan-write` | scrivere il piano (checklist `- [ ] step`) | `{{extPlanHint}}` `{{LOOP}}` |
| `implement-first` | implementare il primo step | `{{implHint}}` `{{LOOP}}` |
| `review-delegate` | delegare la review al subagent | `{{reviewerRef}}` `{{reviewModel}}` `{{LOOP}}` |
| `review-fix` | correggere dopo una review bocciata | `{{retries}}` `{{maxRetries}}` `{{implHint}}` `{{extFixHint}}` |
| `review-advance` | avanzare dopo review passata | `{{commitHint}}` `{{implHint}}` `{{LOOP}}` |
| `claim-open-steps` / `claim-no-fresh-test` | claim-done rifiutato | `{{openSteps}}` `{{testRun}}` `{{LOOP}}` |
| `cleanup` | pulizia pre-verifica | `{{testRun}}` |
| `final-verify` | verifica finale avversariale | `{{verifierRef}}` `{{verifyModel}}` `{{secHint}}` `{{extVerifyHint}}` `{{LOOP}}` |
| `verify-postfix` | fix dopo bocciatura finale | `{{finalFails}}` `{{maxRetries}}` `{{implHint}}` `{{LOOP}}` |

Vincoli strutturali (imposti dal plugin, non aggirabili): l'header di progresso è sempre
anteposto; il **routing delle fasi non cambia** — il pack cambia *cosa si dice*, mai
*dove si va*; un template rotto fa ricadere sul default.

## Punteggio (vedi evaluate.py)

`0.60·test_nascosti + 0.25·chiusura_autonoma + 0.15·efficienza − 0.20·escalation`,
media sui 3 task. I test nascosti sono più severi delle suite visibili: le istruzioni
che spingono a implementare TUTTA la specifica (edge case, input ostili) battono quelle
che accontentano la suite visibile.

## Regole

- NON leggere `data/private/` (ground truth): il punteggio perderebbe ogni significato.
- NON modificare i mini-task, i loro test visibili, `evaluate.py` o la meccanica di
  esecuzione: l'unico grado di libertà è `PROMPT_PACK` (più eventuali fix a bug reali
  del runner, motivandoli).
- **PRESERVA I VERBI OPERATIVI.** I template default contengono i comandi esatti che
  fanno avanzare il loop (`{{LOOP}} claim-done`, `{{LOOP}} report pass|fail`, il verbo
  `test`, la delega ai subagent col verdetto in `review.json`/`verify.json`). Una
  mutazione NON deve mai rimuoverli o parafrasarli: si muta AGGIUNGENDO guida breve
  attorno a essi (prefissi/suffissi), non riscrivendo l'istruzione da zero. Evidenza
  storica: nella generazione 3 del primo run pilota la riscrittura totale in "coaching"
  senza comandi ha fatto crollare lo score da 0.5333 a 0.41 (t1: 0.0).
- Le mutazioni siano MIRATE e motivate dai log: poche chiavi per generazione, leggendo
  dove i loop hanno sprecato iterazioni o sbagliato (history/esiti in submission.json).
