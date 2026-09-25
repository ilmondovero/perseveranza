# Piano corto, giudici in parallelo — piano di modifica

Proposta di partenza: meno passi nel piano, e più giudici in parallelo nello stesso turno
al posto di un solo revisore e di un solo verificatore finale. Questa versione del piano
parte dai **dati dei run reali** (sezione 1) e ne ricava cosa conviene fare, in che
ordine, e cosa no. Da approvare prima di scrivere codice; le decisioni marcate
**[scelta]** hanno un'alternativa scartata, con il motivo.

## 1. Cosa dicono i dati

Fonti: i 9 run archiviati in `~/.perseveranza/runs` con un journal (4 progetti, motore
2.0.0–2.5.0, 182 iterazioni, 96 passi di piano, 129 ore di calendario); le trascrizioni
di sessione e dei subagent in `~/.claude/projects`; il pannello di giudici di
`pi-workflows` (10 blocchi rivisti da due giudici di famiglie diverse, 18 pannelli reali).

**Review per passo: non è lì che si perdono i giri.**

- 35 passi arrivati al pass: 22 (63%) al primo giro, 10 (29%) al secondo, 3 al terzo o
  oltre.
- Gli esiti di review *mancanti* (23) superano le bocciature vere (17), ma quasi tutti
  vengono da un run con il motore 2.0.2 (16 da solo), prima dell'hook delle attività e
  del controllo `implement-idle`; dalla 2.1 in poi sono 1–2 per run.
- Due verdetti validi nel merito sono stati buttati dal parser: una severità `medium`
  (ammesse: critical, warning, suggestion) e un JSON con un escape non valido.

**Verifica finale: è lì che il lavoro viene fermato davvero.**

- Ogni run recente (2.1+) arrivato alla verifica finale è stato bocciato almeno una volta,
  dopo che tutte le review per passo erano passate.
- I difetti trovati sono veri e gravi: un tetto di spesa che diventa illimitato in
  silenzio sotto un guasto (fail-open), una ReDoS introdotta dal lavoro, una regressione
  introdotta da un fix del giro precedente, documentazione d'ingresso rimasta falsa.
- In un run Claude ha affiancato di sua iniziativa un `security-reviewer` al verificatore:
  l'unico caso di giudici davvero in parallelo (per il resto al massimo una delega aperta
  alla volta; le deleghe "in più" a `pf-reviewer` sono rilanci in sequenza o review che
  Claude si fa da solo durante il fix).

**Costo: i giudici pesano poco, e il budget ne vede la metà.**

| chi | token di output | contesto letto (input + cache) |
|---|---|---|
| sessione principale | 52% | 46% |
| executor (`pf-executor` e simili) | 27% | 30% |
| reviewer per passo | 14% | 14% |
| verificatore finale | 6% | 9% |

- Il budget in token (`src/shell/transcript.mjs`) legge solo la trascrizione principale:
  **circa metà della spesa reale non viene contata**. Le trascrizioni dei subagent sono in
  `~/.claude/projects/<progetto>/<sessione>/subagents/agent-*.jsonl`, con accanto un
  `.meta.json` che porta `agentType` e `model` (verificato su questi run).
- Due lenti in più nella sola verifica finale costerebbero circa +12% dell'output di un
  run; due lenti in più in ogni review per passo circa +28%.

**Giudici diversi trovano cose diverse (`pi-workflows`).**

- Due giudici di famiglie di modelli diverse: su 117 problemi distinti, solo il 12% è
  stato trovato da entrambi. Diversi difetti importanti li ha visti uno solo mentre l'altro
  dava lo stesso codice per "corretto" (poi corretti nei commit).
- Ma con l'unanimità **tutti** i 10 blocchi sarebbero stati bocciati, e metà dei
  disaccordi erano sulla severità dello stesso problema: senza una regola che distingua
  "bloccante" da "da segnalare" il pannello blocca sempre.
- C'è rumore: bloccanti mai tradotti in un fix, un giudice che si contraddice. E i
  fornitori esterni falliscono spesso (errori, limiti di output, 503): il backoff arrivava
  a 7 minuti su 9 di un ciclo.

**Fuori tema, ma da segnalare:** 7 run su 9 finiscono con un `disarm` a mano, spesso il
giorno dopo, con il loop fermo a metà (in review o in verifica). Non è un problema dei
giudici; il watchdog e il takeover della 2.4–2.5 sono nati da qui.

## 2. Cosa ne segue

1. **Più lenti nella verifica finale, non nella review per passo.** È il punto dove i
   difetti veri sfuggono, costa poco (6% oggi) e il tempo reale non cambia se i giudici
   girano in parallelo. Nella review per passo il 63% dei passi passa al primo giro e il
   costo si moltiplicherebbe per il numero di passi.
2. **Blocca solo il `critical`.** Con più giudici la regola "basta un `pass: false`"
   bloccherebbe quasi sempre (dato `pi-workflows`). Un giudice boccia solo con almeno un
   finding `critical`; i `warning` di tutti arrivano a Claude ma non bloccano.
3. **Il budget in token deve contare i subagent**, a prescindere dai giudici.
4. **Parser più tollerante sulle severità**: un verdetto giusto non va buttato per un
   sinonimo.
5. **Piano corto: solo prompt, e solo se il bench lo conferma.** I dati non dicono che i
   passi siano troppi; dicono che i giri si perdono altrove.

## 3. Fase 1 (circa 2 giorni)

### 3.1 Budget in token con i subagent (0,5 g)

- `src/shell/transcript.mjs`: oltre alla trascrizione principale, somma l'`usage` dei
  file `subagents/agent-*.jsonl` della stessa sessione (cartella `<sessione>/subagents`
  accanto a `<sessione>.jsonl`), filtrati per timestamp dall'arm come oggi.
- `usage` nel journal e nel `summary.json` distingue `main` e `subagents` (e, dal
  `.meta.json`, il tipo di agente): la ripartizione della sezione 1 diventa un dato del
  run, non un'analisi a mano.
- Se la cartella non c'è (versioni di Claude Code diverse): si torna alla sola
  trascrizione principale, come oggi, e il journal lo dice.

### 3.2 Severità tolleranti (0,2 g)

- `src/core/verdicts.mjs`: `blocker`/`bloccante` → `critical`, `high`/`medium`/`major`/
  `maggiore` → `warning` (`high` non è `critical`: nella scala a quattro livelli sta sotto, e
  un `critical` rovescerebbe il verdetto dichiarato), `low`/`minor`/`info`/`minore` →
  `suggestion`; una nota nel journal quando la mappa interviene. Una severità ancora sconosciuta resta un errore (esito
  mancante), come oggi.
- **[scelta]** Niente "riparazione" del JSON malformato: un verdetto che non si legge con
  certezza non è un pass. L'escape non valido resta un esito mancante, chiesto una volta.

### 3.3 Verifica finale con più lenti (1–1,5 g)

- `arm --verifiers <lenti>`: default `general` (identico a oggi). Con complessità `high` il
  default diventa `correctness,security,tests`.
- Lenti: `correctness` (logica, casi limite, input ostili, regressioni introdotte dai fix),
  `security` (oggi `hint-security`), `tests` (esegue test mirati, cerca casi non coperti,
  controlla che le affermazioni dei commenti e della documentazione siano vere: nei run è
  saltata fuori documentazione falsa due volte).
- File: `verify-<lente>.json` (con la sola `general`: `verify.json`, come oggi), stesso
  `requestId` per il giro, campo `lens`.
- Macchina (`machine.mjs`): `state.verdictLenses` fissato da `issueRequest`; la lettura
  combina le lenti:
  - **pass** del giro solo se tutte le lenti hanno scritto e **nessuna ha un finding
    `critical`**;
  - una lente che dichiara `pass: false` senza nessun `critical` non blocca: il suo verdetto
    viene letto come pass con `warning`, e il journal lo annota;
  - i findings di tutte le lenti vanno in un solo `verify-<n>.json`, ciascuno con la sua
    lente, così il fix li rilegge in un posto solo.
- Lenti mancanti: `missing` chiede **solo quelle**, le altre restano valide per il giro; la
  seconda volta è `missing-twice`, come oggi. **[scelta]** Rigore, non quorum: un giudice
  che non risponde non è un voto a favore.
- Il gate di uscita (2.5.3: piano spuntato, verde sul codice giudicato, codice invariato)
  resta identico e si applica al pass combinato.
- Prompt `final-verify` (en/it): "delega **nello stesso messaggio e in primo piano** un
  verificatore per lente", con per ogni lente il file e l'id; placeholder `lensList` in
  `PROMPT_VARS` e `PROMPT_EXPECTED`. Stesso agente `pf-verifier`, con la lente nel prompt.
- `status` mostra le lenti attese e quelle arrivate.
- **Nessuna riga nuova** nella tabella delle transizioni: cambia come si calcola l'esito
  di `final-verify`, non dove va il loop.

### 3.4 Test

- Unit: combinazione per lente (critical blocca, `pass:false` senza critical non blocca),
  lenti parziali e mancanti due volte, lente non attesa messa da parte, id per giro,
  severità tolleranti, `usage` con i subagent.
- E2e: un giro di verifica con tre lenti attraverso l'hook reale, con l'id letto dal
  prompt; una lente mancante.
- Packaging: chiavi nuove nel pack italiano; `lensList` atteso.
- Bench: `dry_loop` scrive un verdetto per lente quando il run è armato con più lenti.

## 4. Fase 2 (solo con i numeri)

Da decidere dopo la fase 1, misurando con il bench (`bench/`, più ripetizioni) e con i
nuovi `usage` per agente nei run reali:

- **Piano corto**: variante del prompt `plan-write` (pochi passi grandi e coesi,
  eventualmente `--max-steps N`) confrontata sul bench per iterazioni, token e difetti
  trovati dalla verifica finale.
- **Più lenti nella review per passo**: solo se la verifica finale con più lenti continua
  a trovare difetti che una review per passo con quella lente avrebbe preso prima.
- **Un giudice di un'altra famiglia di modelli con voto**: oggi i modelli esterni (`ask`)
  in verifica finale danno solo un parere. I dati di `pi-workflows` dicono che la diversità
  di famiglia trova difetti unici, ma anche che i fornitori esterni falliscono spesso: da
  valutare con un fallback che non blocchi il loop su un 503.

## 5. Rischi

| rischio | mitigazione |
|---|---|
| Più giudici, più rumore e più giri di fix | blocca solo il `critical`; i `warning` informano |
| Giudici lanciati in background: il turno finisce senza verdetti | prompt "in primo piano, nello stesso messaggio"; `missing` chiede solo le lenti mancanti |
| Costo | lenti multiple solo in verifica finale e di default solo con complessità `high`; il budget conta finalmente i subagent |
| Formato delle trascrizioni dei subagent non documentato | lettura best-effort con ripiego sulla sola trascrizione principale, dichiarato nel journal |

## 6. Da decidere prima di partire

1. Il default delle lenti in verifica finale con complessità `high`
   (`correctness,security,tests`) va bene, o le lenti multiple devono essere solo su
   richiesta?
2. La regola "blocca solo il `critical`" vale anche per il verificatore singolo di oggi
   (oggi un `pass: false` senza critical boccia)? Proposta: sì, per coerenza, ma è un cambio
   di comportamento da mettere nel CHANGELOG.
3. L'ordine: proposta 3.1 e 3.2 subito (indipendenti, utili comunque), poi 3.3.
