---
description: Arma il ciclo OMC-loop a feedback (plan -> implement -> review -> verifica finale avversariale) e inizia il task
argument-hint: <descrizione del task> [--max N] [--commit] [--external off] [--test "cmd"] [--no-git-finish]
---

Attiva la modalita' "perseveranza" per il task indicato e comincia a lavorarci.

Task richiesto dall'utente:

$ARGUMENTS

Passi da eseguire ORA, in ordine:

1. Se il testo sopra contiene flag (`--max N`, `--commit`, `--external off`,
   `--test "cmd"`), RIMUOVILI dalla descrizione del task e passali al comando; altrimenti
   lascia i default. Se il task contiene virgolette doppie, escapale. Se il progetto ha
   una suite di test e l'utente non ha passato `--test`, individuala tu (package.json,
   Makefile, pytest...) e passala. Arma il ciclo:

   node "${CLAUDE_PLUGIN_ROOT}/scripts/omc-loop.mjs" arm "<task senza flag>" [--max N] [--commit] [--external off] [--test "npm test"]

   (`--commit` = commit atomico dopo ogni step validato; `--external off` = niente
   confronto con modelli esterni, che altrimenti vengono auto-rilevati: codex, gemini,
   agy (quest'ultimo solo su macOS/Linux); `--test` = comando della suite, il claim-done richiedera' la prova di un
   run verde fresco; `--no-git-finish` = a fine progetto NON fare commit+push automatico)

2. Verifica che sia armato:

   node "${CLAUDE_PLUGIN_ROOT}/scripts/omc-loop.mjs" status

3. FASE PLAN: PRIMA esplora il codice rilevante (moduli coinvolti, pattern esistenti,
   test attuali), POI scrivi il piano in `.omc-loop/plan.md` come checklist markdown
   (`- [ ] step`), con step piccoli e verificabili. Se l'arm ha rilevato modelli esterni
   (riga "Modelli esterni per il confronto"), sottoponi il piano a uno di essi per una
   critica indipendente (es. `codex exec --skip-git-repo-check "<task + piano>"` oppure `gemini -p "..."`) e
   integra le osservazioni fondate. Poi valuta la complessita' del task e registrala:

   node "${CLAUDE_PLUGIN_ROOT}/scripts/omc-loop.mjs" complexity low|medium|high

   (criterio: low = modifica piccola e localizzata; medium = feature multi-file standard;
   high = architettura, refactor esteso, dominio delicato. Default se non registri: medium.)
   Infine FERMATI (termina la risposta senza implementare). Da qui in poi lo Stop hook
   `loop-drive.mjs` guida le fasi iniettando a ogni fine risposta l'istruzione successiva,
   instradando in base agli esiti che registri.

La complessita' instrada i modelli delle fasi (hint per i subagent):

   | fase                       | low    | medium | high |
   |----------------------------|--------|--------|------|
   | code-review (subagent)     | haiku  | sonnet | opus |
   | verifica finale (subagent) | sonnet | opus   | opus |
   | implement                  | in sessione | in sessione | delega a executor model=opus |

Come funziona il ciclo (a feedback):

- implement -> code-review (delegata a un subagent con contesto pulito): il revisore
  scrive il verdetto in `.omc-loop/review.json` (`{"blocking": N, "findings": [...]}`)
  ed e' quel file a instradare il loop; solo se manca, registri tu l'esito con
  `report pass|fail`.
  - blocking > 0 -> torni a correggere lo STESSO step, e il fix verra' ri-revisionato
    (al 3o fallimento il loop si mette in pausa e notifica l'utente);
  - blocking = 0 -> spunti lo step in `plan.md` (`- [x]`) e passi al successivo.
- Per eseguire la suite di test usa SEMPRE il verbo dedicato (e' lo script a lanciare il
  comando e registrare l'exit code reale: la prova non e' autodichiarata):
  node "${CLAUDE_PLUGIN_ROOT}/scripts/omc-loop.mjs" test -- <comando>
- Con `--commit`, dopo ogni review passata committi lo step validato (commit atomico).
- Se un fix fallisce due volte, la fase successiva include una diagnosi indipendente
  chiesta a un modello esterno (se rilevato).
- Quando TUTTI gli step sono spuntati e il progetto e' completo:
  node "${CLAUDE_PLUGIN_ROOT}/scripts/omc-loop.mjs" claim-done
  Il claim viene ACCETTATO solo se nella stessa risposta c'e' un run verde fresco del
  verbo `test` (quando una suite e' nota). -> prima un giro di cleanup (solo al primo
  claim: codice morto, duplicazioni, docs), poi la verifica finale avversariale (subagent
  indipendente + falsificazione da modello esterno se rilevato; lente security per
  complessita' high): il verificatore scrive `.omc-loop/verify.json`
  (`{"pass": true|false, "findings": [...]}`); `pass` chiude il ciclo, `fail` ti rimanda
  a correggere.
- Alla chiusura, se la directory e' dentro un repo git, l'hook fa da solo `git add -A`
  (escludendo `.omc-loop/`), commit `perseveranza: <task>` e `git push` (best-effort: un
  push senza upstream/remote non blocca la chiusura). Se non e' un repo git, salta. Tu
  non devi fare nulla: avviene nello Stop hook. Disattivabile con `--no-git-finish`.
- Se ti serve input dell'utente: esegui `pause`, poi fai la domanda; quando l'utente risponde,
  esegui `resume` e prosegui.
- Limite globale di iterazioni (default 25): raggiunto quello, il loop si ferma da solo.
- Interruzione manuale in qualsiasi momento:
  node "${CLAUDE_PLUGIN_ROOT}/scripts/omc-loop.mjs" disarm

Regole:
- NON modificare mai a mano `.omc-loop/state.json`: usa solo i verbi `report`, `complexity`,
  `claim-done`, `pause`, `resume`.
- I file del ciclo che gestisci tu sono `.omc-loop/plan.md` (checklist degli step) e
  `.omc-loop/notes.md` (2-3 righe per step completato: decisioni prese, trappole — e' la
  memoria che sopravvive alla compattazione del contesto; rileggila se perdi il filo).
- A ogni nuovo step, se la sua complessita' e' chiaramente diversa da quella registrata,
  aggiornala con il verbo `complexity` prima di implementare.
- La review usa l'agente `pf-reviewer`, la verifica finale `pf-verifier`, l'implementazione
  high `pf-executor` (inclusi nel plugin; `perseveranza:pf-*` da plugin o nome semplice da
  installazione manuale; fallback a subagent generici se assenti). Passa loro nel prompt
  step/piano, file toccati e diff (se enorme: elenco + estratti): partono da contesto
  vuoto, non farli scavare.
- Lo storico delle transizioni e' in `.omc-loop/history.log` (utile per diagnosi).
