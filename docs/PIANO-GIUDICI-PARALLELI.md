# Piano corto, giudici in parallelo — piano di modifica

Proposta: meno passi nel piano, ciascuno più grande e coeso, e al posto di un solo
revisore (e di un solo verificatore finale) **più giudici in parallelo nello stesso
turno**, ciascuno con una lente diversa. Obiettivo: meno giri sequenziali di review, la
stessa severità (o maggiore) per giro, a parità circa di tempo reale.

Questo documento è da approvare prima di scrivere codice. Le decisioni marcate
**[scelta]** hanno un'alternativa scartata, con il motivo.

## 1. Invarianti che non cambiano

- Il routing resta nella tabella delle transizioni: i giudici multipli cambiano **come si
  calcola l'esito** di `review` e `final-verify`, non dove va il loop.
- Prove, non parole: ogni verdetto è un file JSON consumato alla lettura, legato alla sua
  richiesta dal `requestId` (introdotto in 2.5.x, commit `6a16f55`).
- Lettura più severa: basta un giudice con un problema bloccante per tornare al fix.
- Un esito mancante è chiesto una volta, poi conta come bocciatura.
- Default retrocompatibile: senza opzioni il loop si comporta come oggi (un giudice).

## 2. Piano corto

Solo prompt e un'opzione, nessuna logica nuova.

- `plan-write` (default e `packs/it.json`): chiedere **pochi passi grandi e coesi**, ognuno
  un'unità verificabile da sola; niente passi preparatori separati dal loro uso.
- Nuova opzione `arm --max-steps N` (default: nessun tetto). Se il piano supera N passi,
  lo Stop della fase `plan` chiede una volta di raggrupparlo (nuova riga
  `plan: too-long -> plan`, prompt `plan-regroup`), poi accetta comunque: mai bloccato in
  `plan`, come per `no-plan`.
- Il budget adattivo (`adaptiveMax`, 8 + 3 per passo) resta com'è: meno passi, budget
  più basso, ed è giusto così perché i giri di review sono meno.

## 3. Giudici in parallelo

### 3.1 Configurazione

`arm --judges <lenti>` e `arm --verifiers <lenti>`, liste separate da virgola. Default:
`review` → `general`, `final-verify` → `general` (identico a oggi). Lenti proposte:

| lente | cosa guarda |
|---|---|
| `general` | il prompt di oggi (correttezza, casi limite, regressioni, sicurezza, test) |
| `correctness` | logica, casi limite, input ostili, regressioni |
| `tests` | adeguatezza dei test, esegue test mirati, cerca casi non coperti |
| `security` | segreti, input non fidati, injection, path traversal (oggi `hint-security`) |

**[scelta]** Lenti diverse, non N copie dello stesso giudice: N giudici identici
trovano quasi le stesse cose e moltiplicano i falsi positivi senza allargare la
copertura. Alternativa scartata: `--judges 3` con prompt identico.

Con complessità `high` la lente `security` si aggiunge da sola al verificatore finale
(oggi è un hint nel prompt unico).

### 3.2 File dei verdetti

- `review-<lente>.json` e `verify-<lente>.json` in `.omc-loop/`, stesso formato di oggi
  più il campo `lens`. Con la sola lente `general` il file resta `review.json` /
  `verify.json`: i pack e il bench attuali continuano a funzionare.
- Un `requestId` per giro, uguale per tutte le lenti; il campo `lens` dice quale giudice
  risponde. **[scelta]** Un id per giro, non uno per lente: più semplice da passare nel
  prompt, e l'id lega già il verdetto al giro; la lente è nel nome del file e nel campo.

### 3.3 Macchina (`src/core/machine.mjs`)

- `state.verdictLenses`: le lenti attese per la richiesta in corso, fissate da
  `issueRequest` in base alla fase.
- `readVerdict` diventa `readVerdicts`: legge un file per lente, applica a ciascuno le
  regole di freschezza di oggi (id, poi orologio), e combina:
  - **review**: `blocking` = somma dei bloccanti effettivi; esito `pass` solo se tutte le
    lenti hanno scritto e sono a 0;
  - **final-verify**: `pass` solo se tutte le lenti hanno `pass: true`;
  - i findings di tutte le lenti finiscono in un solo `review-<n>.json` /
    `verify-<n>.json` (ogni finding con la sua lente), così il fix li rilegge in un posto
    solo; i file per lente sono conservati come oggi.
- **Verdetti parziali**: se manca una lente, l'esito è `missing` e il prompt
  `*-missing-outcome` elenca **solo le lenti mancanti** da rilanciare. Le lenti già
  arrivate restano valide per quel giro (non si rilanciano). Al secondo giro con lenti
  mancanti: `missing-twice`, come oggi.
  **[scelta]** Rigore, non quorum: un giudice che non risponde non è un voto favorevole.
  Alternativa scartata: maggioranza, che trasformerebbe un giudice caduto in un pass.
- Il verbo `report pass|fail` resta come ripiego per il caso di un solo giudice; con più
  lenti vale solo per le lenti mancanti (`report pass --lens tests`).
- Tabella delle transizioni: **nessuna riga nuova** per i giudici; solo `plan: too-long`
  (sezione 2).

### 3.4 Shell (`src/shell/stop.mjs`)

- Legge `review-*.json` / `verify-*.json` per le lenti attese (non per glob libero: un
  file di una lente non richiesta viene messo da parte come stale, non letto).
- `effects.mjs`: `keepArtifact` per ogni file di lente.

### 3.5 Prompt e agenti

- `review-delegate` e `final-verify`: "delega **nello stesso messaggio, in primo piano**,
  un giudice per ciascuna lente: {{lensList}}", con per ogni lente il file da scrivere e
  l'id. Nuovi placeholder `lensList` / `lensFiles`, aggiunti a `PROMPT_VARS` e a
  `PROMPT_EXPECTED`.
- **[scelta]** Stessi agenti `pf-reviewer` / `pf-verifier` con la lente passata nel
  prompt, non un agente per lente: meno file da mantenere, e il test di packaging sugli
  agenti resta com'è. Il testo degli agenti spiega come applicare una lente e come
  riempire `lens`.
- Traduzione in `packs/it.json` di tutte le chiavi nuove (il test di completezza lo
  impone).

### 3.6 Budget in token

Oggi `src/shell/transcript.mjs` legge solo la trascrizione della sessione principale:
i token dei subagent non contano. Con N giudici per giro la sottostima cresce di N volte.

- Leggere anche le trascrizioni dei subagent della sessione. **Da verificare sulla
  versione di Claude Code installata** dove stanno (file separati accanto alla
  trascrizione principale, oppure righe `isSidechain` nella stessa): lo verifico su un run
  reale prima di scrivere il parser, come fatto per il ripristino.
- Se non sono leggibili in modo affidabile: il budget in token resta com'è e la
  documentazione dice chiaramente che non conta i subagent.

## 4. Rischi

| rischio | mitigazione |
|---|---|
| Costo in token circa N volte per giro | default a un giudice; lenti scelte per progetto; budget in token corretto (3.6) |
| Più falsi positivi con la lettura più severa, quindi più giri di fix | "bloccante" solo per findings `critical`, ribadito nel prompt di ogni lente; findings deduplicati per file e riga nel prompt di fix |
| Giudici lanciati in background: il turno finisce senza verdetti | prompt esplicito "in primo piano, nello stesso messaggio"; il caso resta coperto da `missing` (chiesto una volta, poi bocciatura) |
| Due giudici scrivono lo stesso file | un file per lente, nome fissato dal prompt; un file di lente non attesa è stale |
| Pack di prompt utente che non conoscono le lenti | con la sola lente `general` nulla cambia; con più lenti, `prompts validate` avvisa se mancano `{{lensList}}` / `{{verdictRequestId}}` |

## 5. Test

- **Unit** (`test/unit/machine.test.mjs`): combinazione `pass`/`fail` per lente, verdetti
  parziali (manca una lente, poi due volte), verdetto di una lente non attesa, id per
  giro, lettura più severa, `report --lens`; `plan: too-long` chiesto una volta.
- **Unit** (`verdicts.test.mjs`): campo `lens` valido/non valido.
- **E2e** (`test/e2e/hook.test.mjs`): un giro completo con due lenti in review e due in
  verifica attraverso l'hook reale, con l'id letto dal prompt reso; un giro con una lente
  mancante.
- **Packaging**: chiavi nuove nel pack italiano; placeholder attesi; agenti.
- **Bench**: `dry_loop` scrive un verdetto per lente quando il run è armato con più lenti.
- **Transizioni**: la tabella dei README rigenerata (`npm run explain -- --markdown`).

## 6. Passi e stima

| passo | contenuto | stima |
|---|---|---|
| 1 | piano corto: prompt, `--max-steps`, riga `plan: too-long`, test | 0,5 g |
| 2 | macchina e shell: lenti attese, lettura e combinazione dei verdetti, parziali, `report --lens`, test unit | 1 g |
| 3 | prompt (en/it), agenti, `arm --judges/--verifiers`, `status` con le lenti in attesa, e2e | 0,5 g |
| 4 | budget in token dei subagent (dopo la verifica su un run reale) | 0,5 g |
| 5 | docs (README it/en, `commands/perseveranza.md`), CHANGELOG, versione | 0,5 g |

Totale indicativo: 3 giorni. I passi 1 e 4 sono indipendenti dagli altri.

## 7. Da decidere prima di partire

1. Lenti di default quando si passa solo `--judges` senza lista: proposta
   `correctness,tests` in review e `correctness,tests,security` in verifica.
2. Il tetto `--max-steps`: solo un'opzione, oppure un default (proposta: nessun default).
3. Il budget in token dei subagent (passo 4): dentro questa modifica o separato.
