# Perseveranza come mod di Claude Code — piano

Decisione presa: perseveranza diventa una **mod** (hook-funzioni in-process di Claude Code
≥ 2.1.287) e **abbandona gli hook di impostazioni**. Questa versione (3.0.0) è rotta di
proposito: niente doppio guidatore, niente ripiego sugli hook. Il costo è dichiarato: la mod
usa `$.process.run`, che è **solo CLI** (`claude` nel terminale, anche `claude -p`): non gira
nell'app Desktop né nell'estensione VS Code. Dove le mod sono spente (`--bare`, `--safe-mode`,
`disableAllHooks`, policy aziendale) il loop non parte, e `arm` deve dirlo chiaramente.

## 1. Fatti verificati su Claude Code 2.1.289 (non congetture)

Provati con mod di prova caricate con `--plugin-dir` in `claude -p` (Haiku):

| Fatto | Prova |
|---|---|
| `on('classic.Stop')` che restituisce `{ block: 'testo' }` continua la conversazione, 12 blocchi di fila con lavoro tra l'uno e l'altro, **nessun tetto** | log `Stop#1..13` |
| Il tetto di 8 continuazioni di Claude Code scatta solo se le continuazioni sono di solo testo (hook di impostazioni: 9 fire senza lavoro; 15 fire con una chiamata a Bash a ogni passo) | due prove |
| L'input di Stop porta `background_tasks` con il subagent `running` e `last_assistant_message`, `stop_hook_active`, `agent_id`, `agent_type`, `effort`, `scratchpad_dir`, `prompt_id` | log |
| `on('classic.SubagentStop')` che restituisce `{ block }` **fa ripartire il subagent**, che esegue l'istruzione in più; il secondo Stop ha `stop_hook_active=true` | prova 2 |
| `on('agent.spawn')` con `next({...e, model: 'sonnet'})` **cambia davvero il modello** del subagent (padre Haiku, subagent `claude-sonnet-5-5`; senza riscrittura Haiku) | `turn.step` per agente |
| `on('turn.step')` (async generator, `yield* next(e)`) riceve `result.usage` per richiesta, con cache, e `e.agentId` per i subagent | log |
| `on('tool.call')` porta `e.agentId` per le chiamate dei subagent e `tool_use_id` | log |
| `$.tool.register({name, description, inputSchema})` espone `mcp__<plugin>__<nome>`; il modello lo chiama e `on('tool.call', {tool: ...})` risponde con `{ result }` | prova 2 |
| `$.process.run([...], {cwd, env, stdin, timeoutMs})` funziona in `-p` | prova 2 |
| `$.fs.write` **non è atomico** e non ha append/rename/delete; due hook concorrenti con lettura-modifica-scrittura hanno perso una riga di log | prova 2 |

Dal file dei tipi (`.claude-plugin/types/claude-code/index.d.ts`, scritto dalla versione in uso
ogni volta che una mod viene caricata con `--plugin-dir`) e dalla documentazione:
- un hook ha **10 s di tempo proprio** (non contano `next` e le chiamate a `$`, salvo `$.clock.sleep`);
  il gestore `.catch` ha 1 s; `session.end` ha 1,5 s in tutto;
- un hook che fallisce prima di `next` è **saltato** (fail-open); per un controllo che deve
  bloccare serve `.catch` che risponda esplicitamente (`{ block }`, `{ deny }`);
- il modulo non ha API Node, né timer globali, né `require`; i nomi degli eventi in `on()` sono
  **stringhe letterali**; `$` non si destruttura né si assegna; import solo relativi dentro il
  plugin (più `claude-code` per i tipi); `claude plugin validate` fa questa analisi statica;
- `$.store`: JSON per plugin sotto la config dell'utente, 4 MiB in tutto; `$.state`: valori in
  memoria dell'host con `ifVersion`, sopravvivono al hot reload ma **non** a un riavvio;
- `claude plugin test` esegue `*.test.ts` senza fs/rete/processi; `$` è l'engine vero e i
  metodi si stubbano come eventi (`on('process.run', ...)`); `mock.clock`, `mock.store`,
  `mock.env`; `$.classic.Stop({...})` simula uno Stop.

Non verificato (da non dare per buono): durabilità di `$.store` dopo un crash; se
`$.turn.abort` ferma i subagent figli; `tool.check` non ha `agentId` (per restringere per agente
serve `tool.call`).

## 2. Principio: mod sottile, nucleo e shell Node riusati

Il nucleo puro (`src/core/*`, nessun import `node:`, 267 test) **non cambia comportamento** e si
importa dalla mod con percorsi relativi. Lo stato resta in `.perseveranza/state.json` (stesso schema,
più campi additivi): così watchdog, ripristino, archivio, CLI per umani e test esistenti
continuano a funzionare. La mod è **senza stato di loop in memoria**: a ogni Stop rilegge lo
stato (come oggi), perché un riavvio o un hot reload non deve perdere nulla. In memoria tiene
solo fatti effimeri (token per agente, ultima attività, deleghe pendenti), svuotati su disco a
intervalli e a ogni Stop.

Tutto l'I/O passa da **un solo punto**: un helper Node invocato con `$.process.run` e l'input su
`stdin`. Motivi: `$.fs.write` non è atomico, non ha append, ha il tetto di 4 MiB, e il journal
supera quel tetto. L'helper riusa `src/shell/*` così com'è (effects, journal, archive, git,
notify, providers, test, watchdog). Una coda seriale nella mod evita le scritture concorrenti.

```
hooks/hooks.json            { "modules": ["./register.js"] }     (gli hook classici spariscono)
hooks/register.js           punto d'ingresso: solo on(...) letterali, niente logica
hooks/lib/*.js              adattatori della mod (coda seriale, contesto, effetti, fatti effimeri)
src/core/*                  nucleo puro (additivo, vedi 3)
src/shell/mod-bridge.mjs    helper Node: legge JSON da stdin, fa ciò che faceva stop.mjs, risponde in JSON
src/shell/*, src/cli/*      invariati nella sostanza; il CLI resta per umani, watchdog e archivio
```

## 3. Cosa fa la mod (evento → effetto)

| Evento | Cosa fa | Sostituisce |
|---|---|---|
| `classic.Stop` | raccoglie i fatti (incluso `background_tasks`), chiama il bridge che esegue `step()` e gli effetti, restituisce `{ block: reason }` o `next(e)` | `src/shell/stop.mjs` come hook |
| `classic.Stop` `.catch` | se l'hook fallisce: journal e un solo `{ block }` di recupero; con `stop_hook_active` già vero lascia fermare (mai un blocco infinito) | — |
| `classic.SubagentStop` | per `pf-reviewer`/`pf-verifier` (e lenti): se il verdetto atteso manca o non si legge, `{ block }` con l'istruzione di scriverlo; al massimo 2 volte per richiesta, poi lascia andare (la rete resta l'esito `missing` della macchina) | 23 esiti di review mancanti nei run reali |
| `agent.spawn` | per `pf-*` riscrive `model` secondo `MODEL_ROUTING`; fail-open (se l'hook salta, vale ciò che dice il prompt); journal della riscrittura | il solo suggerimento nei prompt |
| `turn.step` | accumula `usage` per `agentId` (token esatti, cache inclusa); svuota su disco | `src/shell/transcript.mjs` |
| `tool.call` / `classic.SubagentStop` | battito: ultima attività, deleghe `Agent` pendenti (con `agentId`), comandi di `Bash` con classificazione sicuro/non sicuro da rieseguire; flush con debounce via `$.clock.after` | `src/shell/activity-hook.mjs` (un processo `node` per chiamata) |
| `session.start` / `prompt.context` | se in questa cartella c'è un loop che la sessione non possiede (abbandonato, rilasciato, in pausa) lo dice alla sessione, come `session-start.mjs` | `src/shell/session-start.mjs` |
| `$.tool.register('perseveranza', ...)` | uno strumento tipizzato `mcp__perseveranza__perseveranza` con `verb` (report, complexity, claim-done, pause, resume, test, ask, status) e argomenti; esegue il verbo del CLI via `$.process.run` e restituisce l'output | i comandi `node perseveranza.mjs ...` via Bash (e i loro permessi) |
| `$.command.register('perseveranza')` | `/perseveranza <verbo ...>` per l'utente (`immediate: true` per status e disarm anche a turno in corso) | il CLI digitato a mano |

Nel nucleo (puro, con test), additivi:
- `ctx.backgroundTasks`: se a uno Stop in `implement`, `review` o `final-verify` un subagent
  `pf-*` risulta ancora `running`, la macchina chiede di aspettare invece di mandare in review il
  nulla o contare un esito mancante; al massimo 3 attese di fila (poi vale la logica attuale), così
  non si esaurisce il tetto di 8 continuazioni di solo testo. Una riga nuova in `TRANSITIONS`
  (e il README che la riproduce) per l'esito `subagent-running`.
- `ctx.usage` con `source: 'mod'` e la ripartizione `byAgent`; il budget in token la usa.
- Funzioni pure `subagentVerdictCheck(state, agentType, artifacts)` e `routeModel(state, subagentType)`.
- `LOOP` nei prompt: in modalità mod rende "lo strumento `perseveranza` con verb ..." al posto del
  comando di shell (pack en e it, `PROMPT_VARS` invariato).

## 4. Antifragilità

- Nessuno stato di loop nella mod: si può ricaricare, riavviare, uccidere.
- Ogni hook che non deve bloccare è fail-open e lascia una riga nel journal (`mod-hook-skipped`).
- Gli unici hook fail-closed sono quelli che proteggono il loop (Stop e SubagentStop), con `.catch`
  esplicito e il limite `stop_hook_active`.
- All'avvio (`session.start`) la mod legge la versione di Claude Code: se è più vecchia della
  2.1.287 o un evento atteso non esiste, lo scrive nel journal e in `status`, non fallisce in silenzio.
- Il watchdog resta un processo esterno separato (i timer di una mod muoiono col processo);
  la mod lo avvia con `$.process.spawn`/`run` come oggi lo avvia `arm`.
- Scritture sempre atomiche (helper), nessun `read-modify-write` con `$.fs` su file condivisi.

## 5. Fasi e criteri di uscita

1. **Nucleo additivo + bridge** (nessun cambio di comportamento senza mod): le tre aggiunte di
   sezione 3, `mod-bridge.mjs` (stdin JSON → stdout JSON) che riusa la logica di `stop.mjs`
   (refactor in funzione importabile, `stop.mjs` resta un sottile involucro per i test esistenti).
   Uscita: `npm test` verde, test nuovi per ogni aggiunta.
2. **La mod**: `hooks/register.js`, `hooks/lib/*`, `hooks.json` con solo `modules`. Uscita:
   `claude plugin validate .` pulito; test con `claude plugin test` (stub di `process.run`/`fs`,
   `$.classic.Stop`, `mock.clock`); e2e reale con `claude -p --plugin-dir` (Haiku, `--setting-sources project`,
   `ENABLE_CLAUDEAI_MCP_SERVERS=0`, `< /dev/null`) che porta un mini-task dal piano al git-finish.
3. **Strumento, comando, prompt**: `perseveranza` tool, `/perseveranza`, `LOOP` in modalità mod,
   `arm` che rifiuta con un messaggio chiaro se la mod non è caricabile.
4. **Pacchetto**: `install.mjs` per l'installazione manuale carica il plugin con
   `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`; rimozione degli hook di impostazioni da
   `hooks.json` e dal manifest; README (it/en), CHANGELOG 3.0.0 con la rottura dichiarata, `npm run
   test:mod` (validate + plugin test + e2e; se `claude` non è nel PATH il passo risulta **saltato in
   modo esplicito**, mai silenzioso).

Fuori scopo: HUD in riquadro, `$.model.fork` come advisor, takeover via `session.send`,
compattazione guidata. Si valutano dopo, sui dati.

## Stato fase 1

Fatto (nessun cambio di comportamento senza la mod: gli hook di impostazioni e i test
esistenti restano validi; `hooks/hooks.json` non è toccato):
- `ctx.backgroundTasks` → esito `subagent-running` (riga nuova in `TRANSITIONS`, README it/en
  rigenerati, prompt en e it), solo per il subagent del ruolo della fase (`WAIT_ROLES`:
  `pf-executor` in implement, `pf-reviewer` in review, `pf-verifier` in final-verify),
  contatore `counters.subagentWaits` (massimo 3 per richiesta di verdetto,
  `MAX_SUBAGENT_WAITS`, azzerato da una nuova richiesta o da un cambio di fase) e
  `counters.quietStops` (stop bloccanti di fila senza prove di lavoro dallo stop prima;
  da 5, `MAX_QUIET_STOPS`, niente attese).
- `ctx.usage` con `source: 'mod'` e `byAgent` per `agentId`: `normalizeUsage` fa dei totali
  almeno la somma per agente e piega oltre il tetto in `other`; `mergeModUsage(prev, delta)`
  somma i token dall'ultimo flush. `status` mostra la fonte, la ripartizione e i token ancora
  nella casella di posta.
- Casella di posta dei token: `src/shell/usage-inbox.mjs`, `.perseveranza/usage-inbox/`,
  `state.usageInboxSeen`.
- `src/core/subagents.mjs`: `routeModel`, `subagentVerdictCheck`, `MAX_VERDICT_ASKS = 2`; la
  macchina esporta `loopAgentName` e `runningLoopAgents`.
- `ctx.loopMode` (`'shell'` di default, `'tool'`) e `loopVar(mode, shellLoop, layers)` da
  `prompts.mjs`, da usare anche per gli avvisi di sessione (`sessionNotice`, `compactNotice`,
  `restorePrompt` ricevono già `LOOP`).
- `src/shell/stop-core.mjs` (`runStopFromFacts`, `readVerdictFiles`), `stop.mjs` involucro,
  `src/shell/mod-bridge.mjs` con le quattro operazioni.

Deviazioni e scelte, con il perché:
- **Un'attesa non spende un'iterazione** e non tocca `flags.repeated`: non è progresso, e così
  dopo le 3 attese l'esito `missing` (o `idle`) scatta come senza la mod.
- **Si aspetta solo se nulla ha già deciso**: in `review`/`final-verify` solo senza esito
  (`report` vuoto: un verdetto valido, un `report` del verbo o un claim instradano comunque);
  in `implement` sempre (lì `report` non conta).
- **Chiavi di prompt in più oltre a `subagent-running`**: `loop-tool` (come si legge `LOOP` in
  modalità strumento, tradotta dal pacchetto), `hint-ask-tool` (la sola frase che usava una
  pipe su stdin), `subagent-verdict` (il testo del `{ block }` di `subagent-stop`) e
  `hint-verdict-missing|stale|malformed` (il motivo, leggibile). Per questo `PROMPT_VARS` ha
  sei chiavi nuove; le variabili esistenti, `LOOP` compreso, sono invariate.
- **Il test "nessun comando di shell" controlla `perseveranza.mjs` e `node `**, non la
  stringa `perseveranza`: i percorsi `.perseveranza/plan.md` ecc. sono in quasi ogni prompt e
  restano.
- **`MODEL_ROUTING.execute`** (sonnet/sonnet/opus) per `pf-executor`: prima l'executor aveva
  solo il "model=opus" del suggerimento ad alta complessità.
- **`subagentVerdictCheck` e le lenti**: il SubagentStop non dice quale lente avesse il
  verificatore. Con `opts.lens` si controlla il suo file (o `verify.json`, se il suo manca del
  tutto); senza, basta un file valido del giro (il resto lo chiede la macchina con `missing`).
- **`usage-flush` non scrive mai `state.json`** (correzione dopo la verifica: la prima versione
  rileggeva e riscriveva lo stato senza blocco, e flush o Stop sovrapposti perdevano token).
  Scrive `.perseveranza/usage-inbox/<ts>-<pid>-<rand>.json` in modo atomico; lo Stop elenca la
  casella **prima** di leggere lo stato, somma i delta e salva. I file li cancella uno Stop
  successivo, solo se lo stato caricato li nomina (correzione dopo la sesta verifica: vedi sotto).
  I nomi contati restano in `state.usageInboxSeen` finché il loro file è su disco: a ogni Stop
  si riprova a cancellarli e un nome esce solo quando il file risulta assente (ENOENT). Un
  file già contato (Stop sovrapposti, crash tra salvataggio e cancellazione, cancellazione
  rifiutata da un client di sincronizzazione) si cancella e non si conta mai più. Nessun
  taglio per numero: solo una guardia a 5000 nomi, annotata se scatta. Con
  l'elenco fatto prima della lettura, un file cancellato da un altro Stop è già nello stato
  letto. Un file illeggibile più vecchio di 5 s diventa `<nome>.invalid` (più giovane può essere
  ancora in scrittura: si riprova). Ogni file porta `session` e `arm` (`state.armedAt`): un
  file di un'altra sessione o di un'altra armata (un flush tardivo di un run archiviato) si
  scarta e si annota. `usage-flush` crea la cartella solo dentro un `.perseveranza/` che esiste
  (mkdir non ricorsivo: è il mkdir stesso a dire che il gate non c'è) e senza loop risponde
  `{ ok: false, error: 'no-loop' }`. `no-loop` vuol dire stato davvero assente (mai armato,
  disarmato, archiviato). Con uno `state.json` bloccato o corrotto il delta si accoda come
  `armUnknown` e la risposta è `usage-queued` con `armUnknown: true` (tassonomia completa
  sotto, correzioni dopo la decima verifica). Due Stop che
  si sovrappongono non si sovrascrivono più (correzioni dopo la sesta verifica, sotto). La lettura di un'altra fonte già in `state.usage`
  diventa la riga `main` della prima lettura della mod: nulla di speso si perde.
- **Al `stop` i fatti `usage` della mod sono un delta** (dall'ultimo flush), sommato allo stato
  prima di `step()`; con `facts.usage` le trascrizioni non si leggono.
- **`saveState` ora è atomico** anche dallo Stop hook (`writeAtomic`, stesso ripiego in place
  di `activity.json` se il rename è rifiutato): un lettore non vede mai uno stato a metà.
- **Correzioni dopo la verifica indipendente** (2 critical, 4 warning):
  - un'attesa non fa avanzare `s.tree`: prima registrava l'albero dello stop, e le modifiche
    scritte da `pf-executor` prima di quello stop risultavano `idle` allo stop dopo;
  - un'attesa non consuma né sposta alcun file di verdetto (niente `keepArtifact`,
    `dropArtifact`, `writeArtifact`; una nota nel journal dice quali sono rimasti al loro posto);
  - le attese sono contate per richiesta di verdetto e c'è il tetto di 5 stop di fila senza
    lavoro chiesto: la sequenza che dava 8 continuazioni di solo testo (3 attese, `missing`, 3
    attese, `missing-twice`) ora ne dà 5 (3 attese, `missing`, `missing-twice`);
  - test che catturano la riscrittura dello stato da parte di `usage-flush` (byte per byte,
    anche per uno stato v1);
  - `subagent-stop` senza `verdictRequestId` lascia andare (`no-request`, annotato): nessun
    blocco consegna più un id vuoto; il motivo del blocco è reso dal pacchetto
    (`hint-verdict-missing`, `-stale`, `-malformed`: "risulta assente" in italiano).
- **Correzioni dopo la seconda verifica** (1 critical, 5 warning):
  - conti dei token limitati alla radice (`tokenCount` in `state.mjs`): interi finiti non
    negativi, saturazione a `Number.MAX_SAFE_INTEGER` (mai `Infinity`, mai ritorno a 0), ogni
    campo di un delta troncato a `MAX_TOKEN_DELTA` = 1e12 e annotato (`usage-clamped`), un
    valore ostile conta 0 e non riduce il totale; vale per `normalizeUsage`, `mergeModUsage`,
    `byAgent` e la casella. Prima due flush da 1e308 azzeravano la lettura e scavalcavano
    `maxTokens`;
  - `usageInboxSeen` senza taglio a 200 (vedi sopra): prima 1000 file e un crash davano 3600
    invece di 2000, e un file non cancellabile si ricontava dopo 201 stop;
  - `quietStops` si azzera solo con lavoro vero (albero cambiato, test registrato dopo lo stop
    prima, verdetto o `report` instradato, claim) o con uno stop che lascia fermare; mai con
    attese, `missing`, `missing-twice`, `idle`. Un albero sconosciuto (fuori da git) non è una
    prova di lavoro. Il lavoro fatto in questo stesso stop consente l'attesa. La sequenza che
    dava 9 blocchi senza lavoro con 6 attese (3 attese, `missing`, `missing-twice`, 3 attese,
    `idle`) ora ha 3 attese in tutto; i blocchi successivi senza lavoro (`idle`, `missing`...)
    sono la logica di sempre, che le attese non allungano;
  - si attende solo il subagent del ruolo della fase: un `pf-reviewer` rimasto in esecuzione
    non trattiene `implement`;
  - test che catturano le mutazioni a mano segnalate: azzeramento a nuova richiesta
    (`claim-again` in final-verify), cancellazione della casella prima del salvataggio (una
    `unlink` di prova verifica che ogni file cancellato sia già nello stato su disco), file di
    un'altra sessione o armata, `status` che sposta file. Una batteria di 15 mutazioni a mano
    (queste, più tetto, saturazione, ruoli, albero, verdetti, `no-loop`, id vuoto) è uccisa
    tutta dai test;
  - un flush dopo l'archivio non ricrea `.perseveranza/` (`no-loop`), e i file portano l'arm.
- **Correzioni dopo la terza verifica** (1 critical, 2 regole senza test):
  - `saveState` ora rilegge ciò che ha scritto (`saveStateVerified` in `effects.mjs`, sopra
    `writeFileResult` di `activity.mjs`, che dice se il testo è nel file: per rename o sul
    posto) e lascia l'esito in `env.save`. Lo Stop cancella i file della casella solo se il
    salvataggio è riuscito e lo stato riletto dal disco nomina i file contati e ne porta i
    totali; altrimenti non cancella nulla, ripristina in memoria la lista dei nomi contati,
    annota `state-save-failed` (con l'errore) e risponde comunque. Prima, con `state.json` in
    sola lettura (un client di sincronizzazione lo tiene: `C:\2026` è su Google Drive), i token
    della casella si perdevano per sempre.
  - Stesso schema per l'archivio: dopo un salvataggio fallito `archiveRun` prova a scrivere lo
    stato finale in `state.unsaved.json` e archivia con quello; se non riesce nemmeno lì,
    niente archivio e niente disarmo (`archive-skipped`), e lo Stop dopo riprova. Gli altri
    effetti (`writeArtifact`, `keepArtifact`, `dropArtifact`, `writeEscalation`, `notify`) non
    dipendono dal salvataggio dello stato: un verdetto consumato con lo stato non salvato fa
    scattare `missing` allo Stop dopo, come un crash in quel punto prima della mod.
  - `gone()` esce solo su ENOENT (test con `stat` che fallisce con EPERM, EBUSY, EACCES);
    `boundSeen` oltre la guardia scarta prima i nomi i cui file sono già assenti, poi i più
    vecchi, e tiene sempre i più recenti (quelli contati in quel salvataggio).
  - `tokenCount`: una stringa conta solo se è di cifre decimali (`/^\d+(\.\d+)?$/`); le
    altre (esadecimale, binario, ottale, esponente, segno, spazi) contano 0. Scelta la regola
    più rigorosa: un contatore che arriva da un file deve essere un numero JSON o le sue cifre.
- **Correzioni dopo la quarta verifica** (2 critical di progetto, 2 warning). Prima i file di
  stato si scrivevano in due modi diversi, e i verbi salvavano copie lette prima. Ora si
  scrivono in un modo solo, `src/shell/state-file.mjs`, per lo Stop, i verbi, il watchdog e
  l'archivio:
  - `writeDurable(path, text)`:
    - (a) scrive prima un file temporaneo e lo rilegge; se quella scrittura fallisce o resta a
      metà, il salvataggio fallisce e il file di destinazione non si tocca. Prima, con
      ENOSPC sul temporaneo, `writeFileResult` scriveva sul posto e svuotava `state.json`;
    - (b) riprova il rename 3 volte, con una pausa crescente (Drive e gli antivirus tengono i
      file per un attimo);
    - (c) scrive sul posto solo con una copia completa che il caricamento successivo sa
      trovare: il temporaneo diventa **prima** `state.json.pending` (rename, o scrittura
      diretta riletta), poi si scrive la destinazione e la si rilegge, e solo allora il
      `.pending` si toglie. Se nemmeno il `.pending` si può scrivere, non si scrive sul posto.
      (Corretto dopo la quinta verifica: prima il temporaneo diventava `.pending` solo dopo
      un fallimento sul posto, e un kill -9 durante la scrittura lasciava `state.json` troncato
      e la copia completa come `.tmp`, che nessuno legge: lo Stop dopo disarmava.)

    `writeFileResult` e `writeAtomic` di `activity.mjs` ora passano tutti da qui.
  - `loadStateFile`:
    - (d) uno `state.json` assente, vuoto o corrotto, con accanto un `.pending` valido e non
      più vecchio di 60 s, viene sostituito dalla copia pending (`state-recovered` nel
      journal);
    - non succede se c'è un run trattenuto (`state.disarmed.json`), perché quel run è
      disarmato;
    - senza un `.pending` valido, uno stato corrotto si comporta come oggi (`corrupt-state`,
      archiviato).

    `loadStateFile` lo usano lo Stop, i verbi (`requireState`), `status`, `disarm` e il
    ponte. `status` e il `subagent-stop` del ponte leggono la copia pending senza
    promuoverla: restano in sola lettura.
  - `rev`: un contatore incrementato a ogni salvataggio, da chiunque scriva, e normalizzato a
    intero non negativo.
  - `updateState(paths, mutator)` per ogni verbo (`report`, `claim-done`, `pause`, `resume`,
    `complexity`, `test`) e per l'interruzione che segna il watchdog:
    1. rilegge lo stato subito prima di scrivere e applica il mutatore ai soli campi del
       verbo;
    2. controlla che il file sia ancora quello letto;
    3. scrive con `writeDurable` (rev + 1), rilegge e verifica;
    4. se un altro scrittore è arrivato in mezzo, riparte dal suo stato (3 tentativi);
    5. se lo stato cambia a ogni tentativo, dà un errore: non scrive mai alla cieca.

    `test` scrive il risultato sullo stato di dopo la suite, non su quello letto prima: con
    una suite di 4 s e uno Stop che contava 1000 token nel frattempo, il verbo riportava la
    spesa a 0. Le decisioni di `resume` si prendono dentro il mutatore.
  - Lo Stop, subito prima di salvare, rilegge `state.json`. Se è cambiato da quando l'ha
    letto, prende dal disco i campi dei verbi cambiati lì (`VERB_OWNED`: segnali, `lastTest`,
    `complexity`, `options.testCmd`, i contatori azzerati da `resume`, il rilascio del
    proprietario, l'interruzione del watchdog; `mergeVerbFields` in `state.mjs`, puro),
    annota `state-merged` e porta `rev` oltre entrambi. Un `report` o un `claim-done`
    arrivati durante uno Stop lento non si perdono più.
  - Una rilettura che trova uno stato **successivo** (rev più alta, cioè un verbo che ha
    salvato subito dopo sopra lo stato dello Stop) conta come salvataggio riuscito.
  - **La corsa che resta**, documentata in testa a `state-file.mjs`.
    - Com'era prima: `writeDurable` controllava la destinazione una volta sola, prima di
      calcolare il testo. Poi i nuovi tentativi del rename (pause di 40 e 80 ms) riscrivevano
      quel testo senza ricontrollarla. Uno Stop arrivato nella pausa di un verbo perdeva i
      suoi token e la casella già cancellata (1000 → 0); un verbo arrivato nella pausa di uno
      Stop veniva sovrascritto (`complexity high` perso). Ora si passa a `writeDurable` il
      testo su cui il chiamante ha costruito (`expect`), e lo si ricontrolla prima di **ogni**
      tentativo, il primo compreso, e prima della scrittura sul posto. Se è cambiato c'è un
      conflitto: il verbo riparte dallo stato nuovo (`updateState`), lo Stop rifà l'unione
      dei campi dei verbi e riprova (`SAVE_ROUNDS` = 3, poi `state-save-failed` e casella
      intatta).
    - Cosa resta: il controllo e il rename sono due chiamate, non una. Uno scrittore che
      arriva proprio fra le due, in quell'istante, viene sovrascritto. Le pause dei tentativi
      non allargano più la finestra. Se a perdersi è un nome della casella, il suo file si
      riconta allo Stop dopo, una volta sola. Ma se nel frattempo un terzo Stop ha caricato
      quel salvataggio e cancellato il file, i suoi token si perdono: l'errore va per difetto,
      mai per eccesso (correzioni dopo la verifica finale, sotto). Senza un lock la
      finestra non si chiude, e il repo non ne ha: un lock è un'altra cosa che un crash
      lascia indietro.
    - Due Stop sovrapposti: vedi le correzioni dopo la sesta verifica (riparte, abbandona, e i
      file della casella si cancellano solo allo Stop dopo).
    - Sotto stress con processi veri (15 giri di due Stop, un flush, un verbo e ogni 5 giri
      `test`, tutti insieme) nessun `complexity` e nessun `lastTest` si è perso, e i token
      nello stato sono la somma esatta dei flush.
  - **Correzioni dopo la sesta verifica** (2 critical, 4 warning, mutanti sopravvissuti):
    - **Stop sovrapposti** (prima perdevano token per sempre: `reconcile` trattava il
      salvataggio di un altro Stop come quello di un verbo, ne teneva solo i campi dei verbi
      e scriveva sopra i suoi conteggi, dopo che quello aveva già cancellato i suoi file).
      Ora:
      - uno Stop che, prima di scrivere qualsiasi cosa, trova su disco il salvataggio di un
        altro Stop (cambiato più dei campi dei verbi: `onlyVerbChanges`) riparte da quello
        stato (`stop-restarted`, al massimo 2 volte);
      - se lo trova solo al momento del salvataggio, abbandona il suo (`state-save-skipped`,
        nessun archivio e nessun disarmo) e lo stato dell'altro resta;
      - **un file della casella non lo cancella mai lo Stop che lo conta**: lo cancella uno
        Stop successivo, e solo perché lo stato che ha caricato dal disco lo nomina. Così un
        salvataggio sovrascritto (anche nell'istante che nessun controllo chiude) perde nome e
        token insieme, il file resta su disco e lo Stop dopo lo conta una volta sola;
      - il delta che la mod porta con `stop` (`facts.usage`) diventa un file della casella
        prima che la casella si legga: segue le stesse regole, e non si perde se il
        salvataggio di quello Stop fallisce o viene abbandonato.

      Cosa resta: uno Stop che cancella un file in base a uno stato che poi viene sovrascritto
      da uno Stop cominciato prima che quello stato esistesse, proprio nell'istante fra il suo
      ultimo controllo e il rename. Servono tre Stop sovrapposti e uno di essi fermo fra due
      chiamate di sistema. Lo stress del verificatore (`e7`, tre istanze in parallelo, 15
      prove ciascuna, armato con `--max 100`) non ha perso nulla. Il test del ponte sugli Stop
      sovrapposti è deterministico nel risultato: ogni giro ha al più due Stop insieme.
    - **Un run disarmato non risorge**: se `state.json` sparisce mentre uno Stop gira, o il
      gate ha il marcatore, lo Stop non riscrive nulla (resta dormiente prima di scrivere, o
      abbandona il salvataggio). Solo `arm` crea uno stato da zero.
    - **Lettura rifiutata per un attimo**: un EBUSY su `state.json` si riprova; se continua, lo
      Stop lascia andare (`state-busy`) e non promuove né archivia nulla. Prima un EBUSY
      faceva promuovere una copia pending più vecchia sopra uno stato valido. La promozione
      richiede anche una rev non più bassa di quella di uno `state.json` leggibile ma non
      valido.
    - **`arm`** rifiuta se non riesce a togliere `state.disarmed.mark` (un nuovo run accanto al
      marcatore non avrebbe recupero), e scrive il suo stato con la copia pending come ogni
      altro scrittore.
    - **`disarm --no-archive`** con `state.json` bloccato dice che non ha disarmato (exit 1) e
      non scrive il marcatore accanto a uno stato vivo (`makeDormant` non marca se resta
      `state.json`).
    - Test per ogni mutante sopravvissuto del verificatore (X5, X10, X13, X18, X20, X23, X26,
      X28) in `test/e2e/state-overlap.test.mjs`. `markInterrupted` del watchdog è esportata e
      provata nel punto di chiamata. `archiveRun` e il verbo `disarm` accettano `io.rename` e
      `io.rm` per simulare un gate che un client di sincronizzazione non lascia spostare né
      togliere: il blocco vero di Windows si è rivelato non deterministico (lo stesso handle
      aperto rifiuta la cancellazione da un processo e la permette da un altro, e a volte
      Windows sposta l'intera cartella con il file aperto dentro).
  - **Limiti dichiarati**:
    - `mergeVerbFields` confronta valori, non scritture: un verbo che scrive il valore che
      il campo aveva già all'inizio non si vede, e resta il valore dello Stop. Per esempio,
      un `resume` che rimette `retries` a 0 mentre lo Stop lo portava a 1 lascia 1.
    - La durabilità vale contro la morte del processo: il temporaneo di un file di stato si
      scarica su disco (`fsync`) prima di sostituire qualcosa, ma dopo una mancanza di
      corrente decide il journal del file system.
  - **La prova che i file della casella sono contati** è una sola: lo stato su disco si legge
    e nomina ogni file contato in `usageInboxSeen` (`savedCounts`, esportato). È una prova
    solida perché un nome entra nella lista solo nel salvataggio che ne aggiunge i token
    (una scrittura, un file). Chi scrive dopo li tiene entrambi: un verbo rilegge, uno Stop
    parte dallo stato su disco, un nome esce solo a file assente. Sono state tolte due
    guardie che non servivano a questo:
    - "il nostro salvataggio è riuscito": se un altro Stop ha contato quei file, sono
      contati anche se il nostro salvataggio è fallito;
    - "i totali coincidono": uno Stop sovrapposto può averne aggiunti altri, e totali uguali
      con nomi diversi non provano nulla.

    I test mettono un altro scrittore tra il salvataggio e il controllo (`io.afterSave`) e
    isolano ogni caso: stessi totali con nomi diversi (i file restano e si contano una volta
    sola), salvataggio fallito con i file contati da un altro (si cancellano, nessun doppio),
    un totale più alto con i nostri nomi (si cancellano).
  - Dopo un archivio fallito, lo stato del run è il più recente, per rev e poi per ora, fra
    `state.unsaved.json` e `state.disarmed.json` (`readRetainedState`). `status` lo mostra e
    `disarm` archivia quello. `arm` (anche `--force`) toglie ciò che un run vecchio lascia
    (`state.unsaved.json`, `.pending`, temporanei, la casella). Uno Stop che salva bene toglie
    lo `state.unsaved.json` di un tentativo fallito prima di archiviare, così il file non
    finisce nell'archivio del run sbagliato.
  - Una cartella del gate che dopo il disarmo non si può togliere tutta (un file tenuto
    aperto da Drive o da un antivirus) non riarma mai il loop. `makeDormant` in `archive.mjs`
    toglie lo stato e ogni sua copia (`.pending`, temporanei), sia nel ramo dell'archivio
    completo con la cartella bloccata sia dopo il `rm` di `disarm`. Se una copia resta
    perché è bloccata, accanto si scrive `state.disarmed.mark`: con il marcatore nessuno
    promuove il `.pending`, e lo Stop resta dormiente. `arm` toglie il marcatore. (Corretto
    dopo la quinta verifica: con il `.pending` aperto in lettura da un altro processo,
    `disarm` lasciava la copia e lo Stop dopo il rilascio la promuoveva: un run disarmato si
    riarmava.)
  - Il watchdog scrive l'interruzione con `promote: false`: un processo staccato non
    promuove mai una copia pending, come già non lo faceva `decide()`.
  - Corretto dopo l'ottava verifica, con i test in `test/e2e/state-overlap.test.mjs`:
    - Il delta di `facts.usage` si perdeva quando `state.json` restava bloccato alla prima
      lettura. Ora si scrive nella casella prima di leggere lo stato e indipendentemente da
      quella lettura. Se lo stato non si legge, il file porta `armUnknown` e il tempo di
      scrittura, e `foreignReason` lo accetta solo se è stato scritto dopo `armedAt`.
      Il test fa tre Stop da 100 con il secondo in EBUSY a ogni lettura: alla fine i token
      sono 300.
    - Due Stop sovrapposti contavano due volte un file. A elencava la casella, poi B contava
      il file, lo cancellava e toglieva il nome, e infine A leggeva lo stato. Ora un file si
      conta solo se esiste ancora dopo la lettura dello stato. Tiene perché un nome esce dalla
      lista solo a file assente. Nel test B gira tutto dentro la prima lettura di A.
      Lo script del verificatore e la sua variante a processi veri con ritardi da 0 a 150 ms
      danno sempre il totale esatto.
    - Il delta si scrive una volta per Stop, non a ogni `stop-restarted`. Un test lo
      verifica: dopo una ripartenza il conto è 100, non 200.
    - La rilettura prima del salvataggio (`readDisk`) ora riprova `READ_TRIES` volte. Se
      fallisce, il motivo è distinto: disarmato (marcatore), `state.json` tolto, oppure
      bloccato. Il motivo va sempre nel journal (`note` al controllo, `state-save-skipped`
      al salvataggio). Se lo stato resta bloccato, il salvataggio si abbandona e i token
      restano nella casella per lo Stop dopo.
  - Corretto dopo la nona verifica:
    - Il bridge leggeva uno `state.json` bloccato (EBUSY) come "nessuno stato". `readStateFile`
      ora restituisce `{ busy }` quando `loadStateFile` dice `transient`. Il contratto, nel
      commento in testa a `mod-bridge.mjs`, è questo:
      - `usage-flush` accoda il delta come `armUnknown` e risponde `usage-queued` (prima
        rispondeva `no-loop`, e una mod che segue il contratto buttava il delta);
      - `subagent-stop` rimanda indietro un giudice con il motivo (`subagent-busy`, fail closed)
        al massimo `MAX_VERDICT_ASKS` volte, poi lo lascia andare (`asked-enough: busy`);
        un agente che non è un giudice va (`outcome: 'busy'`);
      - `activity-flush` risponde `{ ok: false, error: 'busy', retry: true }`, senza scrivere
        nulla: di chi sia il loop non si sa, e la mod rimanda il battito;
      - `no-loop` e `dormant` restano solo per uno stato davvero assente.
    - Uno Stop il cui delta non si può accodare (casella non scrivibile) lo dice nella
      risposta: `usageDropped` con il motivo, oltre alla nota nel journal. La mod lo rimanda.
    - Una lettura bloccata al controllo prima di scrivere ora scrive anch'essa una `note`
      nel journal, quindi il motivo c'è sempre.
    - Tolto codice morto (`seenBeforeSave`). `writeUsageDelta` non controlla più che il gate
      esista prima del mkdir: il mkdir non ricorsivo è il controllo, senza finestra fra i due.
    - Test nuovi:
      - quattro in `test/e2e/mod-bridge.test.mjs`, con un preload che rende `state.json`
        EBUSY o la casella ENOSPC nel solo processo del bridge;
      - in `state-overlap`: la ripartenza salva lei stessa sullo stato dell'altro Stop
        (due iterazioni su disco, nessun abbandono), e uno stato troncato al merge viene
        sovrascritto, non abbandonato.
  - Corretto dopo la decima verifica:
    - `usageDropped` poteva mentire. `writeUsageDelta` rileggeva il file finale e, se la
      rilettura falliva (un antivirus che blocca per un attimo un file appena creato),
      rispondeva `not writable`. Il file però restava e veniva contato, e la mod che lo
      rimandava lo faceva contare due volte. Ora:
      - `writeDurable` con `ok` ha già riletto il contenuto (il temporaneo prima del
        rename, o il file scritto sul posto), quindi il delta è accodato e il file finale
        non si rilegge più;
      - se `writeDurable` fallisce, il file si toglie: solo se poi risulta assente la
        risposta è "scartato" (`usageDropped` allo Stop, `{ ok: false, error }` al flush),
        e la mod lo rimanda;
      - se il file non si toglie, la risposta è "non confermato" (`usageUnverified` allo
        Stop, `unverified: true` al flush) e la mod NON lo rimanda: si conta se è intero.
      (Questa regola era ancora sbagliata: corretta dopo l'undicesima verifica, sotto.)
    - Una lettura rifiutata di un file della casella (EBUSY, EPERM) non lo mette più da
      parte come `.invalid` dopo 5 s: si rilegge allo Stop dopo.
    - Tassonomia dello stato per il bridge (in testa a `mod-bridge.mjs`):
      - assente (mai armato, disarmato, archiviato): `no-loop` / `dormant`;
      - bloccato (lettura rifiutata a ogni tentativo): `busy`;
      - corrotto (`state.json` c'è ma non è uno stato, nessuna copia pending; lo Stop dopo
        archivia il run come `corrupt-state`): `corrupt`, trattato come `busy`.
      Con bloccato o corrotto, `usage-flush` accoda come `armUnknown`, `subagent-stop`
      rimanda indietro il giudice (fail closed) e `activity-flush` risponde
      `{ ok: false, error, retry: true }`.
    - Il motivo per il giudice (`subagent-busy`) è nella lingua di `facts.lang` se la mod
      la passa, altrimenti in quella che sceglierebbe `arm` (`PERSEVERANZA_LANG` > config >
      it). La lingua salvata nello stato non si può leggere, perché lo stato è proprio ciò
      che è illeggibile; se il run era stato armato con `--lang` diverso, il messaggio può
      uscire nell'altra lingua. Il testo copre sia il blocco sia il danno.
    - Test nuovi in `test/e2e/mod-bridge.test.mjs`, con il preload esteso:
      - antivirus sulla prima lettura;
      - file non confermato, sia rimovibile sia non rimovibile;
      - stato corrotto;
      - lingua;
      - flush bloccato da un'altra sessione;
      - sessione dell'`activity-flush`;
      - copia pending letta e non promossa dal bridge;
      - file vecchio con la lettura rifiutata.
  - Corretto dopo l'undicesima verifica (ultimo giro sulla catena di salvataggio):
    - Restava un doppio conteggio. Il rename nella casella veniva rifiutato tre volte, e
      `writeDurable` scriveva sul posto il file finale, che ha già un nome valido della
      casella. Uno Stop sovrapposto lo contava. Poi la rilettura sul posto falliva:
      `writeUsageDelta` toglieva il file, lo trovava assente e rispondeva "scartato". La mod
      lo rimandava. Ora `writeDurable` dice `placed` quando ha tentato la scrittura sul posto,
      e in quel caso la risposta è sempre "non confermato" e il file non si toglie. La
      tassonomia finale è:
      - accodato: si conta una volta;
      - scartato: il guasto è avvenuto prima che un file col nome della casella potesse
        esistere (la cartella, il temporaneo), mai contato, la mod lo rimanda;
      - non confermato: può essere già stato contato, la mod non lo rimanda.
    - Limiti dichiarati, le sole perdite possibili di un delta:
      - un "non confermato" che non è arrivato intero (scrittura sul posto fallita o
        troncata): lo Stop e il flush lo annotano nel journal, se il journal si può scrivere
        (corretto dopo la dodicesima verifica, sotto);
      - una chiamata della mod senza risposta (il timeout della mod uccide il bridge, un
        crash). La mod NON rimanda: lo Stop accoda il delta per primo e il flush non fa
        altro, quindi di solito il delta è già in casella. Si perde solo se la chiamata è
        morta prima di scriverlo. Rimandare rischierebbe il doppio. Un id idempotente
        (`facts.usageId` come nome del file) non è implementato, perché un nome si ricorda
        solo finché il suo file esiste, e un rinvio tardivo conterebbe due volte comunque.
    - Un file della casella che non si legge mai (ACL, una cartella con quel nome) non si
      salta più in silenzio:
      - passato il tempo di assestamento, il journal lo annota una volta sola (un marcatore
        vuoto `<nome>.unreadable` accanto, tolto quando il file sparisce);
      - `status` lo elenca come non contato.
    - Test nuovi:
      - in `state-overlap`: la sequenza del verificatore in processo (rename rifiutato,
        Stop sovrapposto che conta, rilettura rifiutata), per flush e per Stop; la prima
        lettura dello Stop che non promuove; un `armUnknown` senza ora che non conta; il
        file illeggibile annotato una volta e mostrato da `status`;
      - in `mod-bridge`: la scrittura sul posto non confermata, anche se rimovibile; un file
        tolto fra l'elenco e la lettura, mai annotato come `.invalid`; `facts.lang` in
        maiuscolo.
  - Corretto dopo la dodicesima verifica:
    - `runningLoopAgents` convertiva `status` con `String()`. Uno `status` come
      `{"toString":1}` (JSON valido) lanciava, e ogni Stop in implement, review o
      final-verify rispondeva `{ ok: false }` senza decisione. Ora una voce che non è un
      oggetto semplice, o con `status` non stringa, si ignora. Nessun campo viene convertito.
    - La nota "annotato una volta" di un file della casella mai leggibile, o messo da parte
      come `.invalid`, si perdeva se il primo Stop dopo i 5 s era di un'altra sessione o
      usciva con `state-busy` o `corrupt-state`: il marcatore o lo spostamento c'erano, la
      nota no. Ora la scrive `readUsageInbox`, tramite il callback `note`, all'elenco della
      casella, prima del marcatore e dello spostamento, e qualunque cosa accada dopo. Se il
      journal non si può scrivere, non mette marcatore e non sposta nulla, così lo Stop
      dopo ci riprova.
    - Un flush con la scrittura sul posto fallita prima di creare il file perdeva il delta
      senza una riga. Ora sia il flush sia lo Stop annotano ogni "non confermato", con il
      motivo. La nota dello Stop non dice più "could not be removed": dal giro precedente
      il file non si toglie.
    - Test nuovi:
      - voci ostili di `background_tasks`, unit e attraverso il bridge;
      - la nota una sola volta con il primo Stop di un'altra sessione, bloccato o normale;
      - il journal non scrivibile: niente marcatore e niente spostamento, poi una nota;
      - `status` di sola lettura;
      - il "non confermato" annotato, per flush e Stop.
    - Mutanti equivalenti rimasti:
      - "scartato comunque" (C3 / W1 del verificatore): è il ramo difensivo `gone(p)` di
        `writeUsageDelta`, che si raggiunge solo quando nessun file col nome della casella
        può esistere;
      - `facts.lang` non portato in minuscolo (W21): su Windows il file system non distingue
        le maiuscole, quindi `packs/IT.json` si carica lo stesso. Il test lo uccide su Linux.
  - Test della quinta verifica in `test/e2e/state-crash.test.mjs`:
    - un processo vero ucciso con SIGKILL a metà della scrittura sul posto: la copia
      pending esisteva già intera, e lo Stop dopo la recupera;
    - `expect` in conflitto al primo tentativo, durante una pausa e all'ultimo;
    - un verbo nella pausa di uno Stop, e uno Stop vero nella pausa di un verbo;
    - uno stato che cambia a ogni giro;
    - `makeDormant` con e senza blocco;
    - `disarm` con il `.pending` aperto in lettura da PowerShell;
    - il watchdog con `promote: false`.
  - Test con un iniettore di guasti (`io.fs`), tutti in `test/e2e/state-file.test.mjs`:
    - ENOSPC sul temporaneo;
    - temporaneo corto;
    - rename rifiutato 2 volte e poi accettato;
    - ENOSPC sul posto con il temporaneo completo (recuperato allo Stop dopo);
    - scrittura sul posto troncata;
    - il caso minimo del verificatore (500 + 300 token, uno Stop con ENOSPC su entrambe le
      scritture, poi disco libero: il loop è vivo e i token sono 800);
    - promozione e non promozione;
    - `rev` e i nuovi tentativi;
    - il caso del verbo `test`;
    - verbi durante uno Stop lento.

    Una batteria di mutazioni a mano su queste regole è uccisa tutta (vedi il rapporto).
- **`activity-flush`** scrive il record normalizzato (`normalizeActivity`: campi extra come
  `agentId` nelle deleghe non entrano nel file) e annota nel journal le righe `facts.journal`
  con `via: 'mod'`.

## Stato fase 2

Fatto: perseveranza è una mod. `hooks/hooks.json` ha solo `modules: ["./register.js"]` (e la
descrizione): il plugin non registra più nessun hook di impostazioni, quindi il loop ha un solo
guidatore. Gli script `src/shell/stop.mjs`, `session-start.mjs`, `activity-hook.mjs` restano per
i test esistenti, per il CLI e per l'installazione manuale (`install.mjs` scrive ancora
`HOOK_SPECS` in `settings.json`: la loro rimozione è la fase 4).

```
hooks/register.js        solo on(...) con nomi letterali e io($): le chiamate a $ come closure
hooks/lib/core.js        tempi, fatti effimeri (createMod), funzioni pure (versione, usage, lente)
hooks/lib/gate.js        il ponte ($.process.run [node, mod-bridge.mjs]), la coda dei flush,
                         hasGate ($.fs.exists dei file di stato del loop), il proprietario
                         letto da un .catch, il marcatore mod-fault.json, mod-hook-skipped
hooks/lib/stop.js        classic.Stop e il suo .catch
hooks/lib/subagent.js    classic.SubagentStop e il suo .catch (i giudici, il battito)
hooks/lib/spawn.js       agent.spawn (MODEL_ROUTING), quale agentId è quale subagent
hooks/lib/tool.js        tool.call: la guardia della riconciliazione, poi il battito
hooks/lib/usage.js       turn.step -> token per agente -> usage-flush (contratto del ponte)
hooks/lib/activity.js    il battito -> activity-flush, con debounce
hooks/lib/session.js     session.start (versione) e classic.SessionStart (l'avviso)
```

`$` non si passa a funzioni importate (lo vieta `claude plugin validate`): `register.js`
costruisce per ogni hook un oggetto `io` di closure (`run`, `after`, `now`, `cwd`,
`sessionId`, `version`, `nodeEnv`, `root`, `sleep`, `exists`, `read`, `write`, `log`, `status`) e lo passa agli
adattatori; `validate` le elenca "via io". Lo stato effimero sta in un oggetto creato da
`register()` (un reload lo azzera), mai lo stato del loop. `node` è quello sul PATH, oppure
`PERSEVERANZA_NODE` (variabile nuova, letta dalla mod con `$.env.get`); il ponte è
`$.plugin.root + '/src/shell/mod-bridge.mjs'`.

### Evento -> effetto (com'è davvero)

| Evento | Cosa fa | Quando fallisce |
|---|---|---|
| `classic.Stop` | senza un loop armato (`state.json`, o solo la sua copia `.pending` senza i segni di un disarmo: la regola del ponte) nessun processo; aspetta al più 5 s un flush dei token già partito; altrimenti op `stop` con `backgroundTasks` (dall'input), `loopMode: 'shell'`, `usage` (il delta dei token, `{}` se nullo: sotto la mod le trascrizioni non si leggono mai); `{ block }` o `next(e)`. Chiama sempre `next(e)` e unisce: gli hook sotto (di impostazioni dell'utente) girano lo stesso | nessuna risposta, JSON illeggibile, `ok: false` -> il hook lancia -> `.catch`: solo per il loop di questa sessione (proprietario letto da `state.json`; illeggibile: solo se questo processo l'ha già guidato), journal `mod-hook-skipped` (o, se il ponte non risponde nemmeno a quello, `.perseveranza/mod-fault.json` con `$.fs.write`), riga sotto il prompt, e UN `{ block }` di recupero (con il comando `status`); con `stop_hook_active` già vero lascia fermare, con la traccia; se il loop non si può verificare lascia fermare (una sessione senza loop non è mai bloccata) |
| `classic.SubagentStop` | battito (la SUA delega chiusa, una volta, quando il subagent è lasciato andare: `agent_id` -> `tool_use_id` della chiamata Agent, imparato da `agent.spawn`; un giudice rimandato resta in attesa); per `pf-reviewer`/`pf-verifier` op `subagent-stop` con `askedTimes` (contati in memoria per `agent_id`) e `lens` se nota; `{ block }` al massimo `MAX_VERDICT_ASKS` (2) volte per subagent, anche se il ponte dicesse ancora di bloccare | `.catch`: un `{ block }` che chiede di controllare il file del verdetto, mai con `stop_hook_active`, mai oltre il tetto, mai senza cartella del loop |
| `agent.spawn` | per `pf-*` (non fork) op `route-model` -> `next({ ...e, model })`; il ponte annota `model-route`; dall'esito dello spawn ricorda `agentId -> { type, lens }` (la lente se il prompt nomina un solo `verify-<lente>.json`) | fail-open: vale il modello del prompt; `mod-hook-skipped` (al più 3 volte per hook per processo, poi solo il log di debug) |
| `tool.call` | per gli strumenti che la riconciliazione rifiuta (Edit, Write, MultiEdit, NotebookEdit, Agent, Task, Bash, PowerShell) e con la cartella del loop: op `tool-check` -> `{ deny }`; poi il battito in memoria | fail-open (lo strumento gira), `mod-hook-skipped` |
| `turn.step` | `result.usage` per `agentId` (`main` per il ciclo principale), cache compresa; flush dopo 15 s, uno alla volta | il flush segue il contratto del ponte (sotto) |
| battito | delega o ritorno: flush entro 2 s; strumento qualsiasi: al più uno ogni 30 s dall'ultimo flush (`$.clock.after`, un timer alla volta, un evento urgente anticipa quello in attesa) | `retry: true` (stato bloccato o corrotto) -> si rimanda, al più 5 volte; `dormant`, sessione altrui -> scartato; nessuna risposta -> le righe non si rimandano (sarebbero doppie) |
| `session.start` | `$.session.version()`: una versione più vecchia della 2.1.287 o illeggibile va in `$.ui.status`; la riga `mod-start` (versione, ok, problema) va nel journal del loop, ora o al primo Stop di un loop vivo (al più 3 tentativi), e `status` la mostra (`mod:`) | fail-open |
| `classic.SessionStart` | op `session-start` (la stessa funzione di `session-start.mjs`, ora esportata come `sessionStartContext`) -> `additionalContext`, unito a quello degli hook sotto | fail-open, `mod-hook-skipped` |

Contratto dei token (`usage.js`, come in testa a `mod-bridge.mjs`): accodato -> fatto;
scartato (`ok: false` diverso da `no-loop`, o `usageDropped` allo Stop) -> torna in memoria e
riparte col flush o lo Stop dopo; non confermato (`unverified`, `usageUnverified`) -> MAI
rimandato; nessuna risposta (e `ok: false` dello Stop, che può aver già accodato) -> MAI
rimandato; `no-loop`, sessione altrui, nessuna cartella -> scartato per sempre; bloccato o
corrotto -> il ponte accoda come `armUnknown` (`usage-queued`) -> fatto.

### Aggiunte al ponte (additive, tutte in sola lettura su `state.json`)

- op `session-start` (l'avviso), `route-model` (`routeModel` + riga `model-route`),
  `tool-check` (`reconcileDecision` di `activity-hook.mjs` + riga `refused` con `via: 'mod'`),
  `journal` (solo i tipi `mod-start` e `mod-hook-skipped`, valori semplici, stringhe a 300
  caratteri, 20 righe per chiamata, `ts` mai dalla mod, solo accanto a uno stato vivo: mai una
  cartella creata);
- op `stop` scrive la riga `mod-stop` (esito, blocco, sessione, `stop_hook_active`) solo
  accanto a uno stato vivo: lo Stop che archivia il run non ne lascia;
- `status` mostra l'ultima riga `mod-start` (`mod: driven by the perseveranza mod on Claude
  Code X`, oppure `WARNING` con il motivo);
- `src/shell/legacy.mjs`: il task di un run 2.x stampato da `arm`/`status` passa da
  `printable()` (sequenze CSI e OSC, caratteri di controllo C0/C1, DEL, a capo e separatori di
  riga diventano uno spazio).

Test nuovi con `npm test`: `test/e2e/mod-bridge-ops.test.mjs` (le quattro op, la riga
`mod-stop`, la riga `mod:` di `status`), il task ostile in `test/e2e/legacy.test.mjs`, e in
`test/packaging/packaging.test.mjs` `hooks.json` con solo `modules`, ogni file di `hooks/` nel
manifest (`MOD_FILES`), ogni file raggiunto dagli import della mod spedito, nessuna API Node,
timer globale o `import()` dinamico in ciò che la mod raggiunge.

### Verificato, con quale prova

- **Mod di prova `probe3`** (`claude -p --plugin-dir`, Haiku, 2.1.289): `classic.SessionStart`
  scatta in una mod (con `session_id`, `cwd`, `source`) e il suo `additionalContext` arriva al
  modello (ha risposto con la parola segreta iniettata); `.catch` di `classic.Stop`:
  `next.error = { kind: 'throw', message, budget: 1000 }`, il suo `{ block }` fa continuare e lo
  Stop dopo ha `stop_hook_active: true`; `$.process.run(['node', ...], { stdin })` funziona;
  una closure che chiama `$` passata a una funzione importata da `./lib` passa `validate` e
  gira; un modulo della mod importa `../../src/core/*.mjs`; il callback di `$.clock.after` usa
  il `$` dell'hook che l'ha creato, fuori da ogni evento; `session.start` riceve `{ cwd,
  surface: null, isInteractive: false }`; `$.session.version()` dà `{ version, base, builtAt }`.
  Un turno breve di `claude -p` con `--setting-sources project --strict-mcp-config` dura circa
  7 s (contro 30 s con gli hook dei plugin dell'utente).
- **Mod di prova `probe4`**: un `classic.Stop` che aspetta un `$.process.run` di 16,7 s (oltre
  i 10 s di tempo proprio) non sfora: il suo `{ block }` vale e il `.catch` non scatta. Per
  questo il timeout del ponte allo Stop può restare quello dell'hook di impostazioni (125 s,
  con la scadenza interna di `stop-core`). Per i tipi (`Registration.catch`) anche la grazia
  di 1 s del `.catch` corre sullo stesso orologio fermo durante `$`: la chiamata al journal
  del `.catch` ha 5 s di timeout (non provato a parte).
- **`claude plugin validate --strict`** pulito su `.claude-plugin/plugin.json` e sulla radice
  (marketplace): `hooks: session.start, classic.SessionStart, classic.Stop,
  classic.SubagentStop, agent.spawn, tool.call, turn.step`, `env reads: PERSEVERANZA_NODE`.
- **`claude plugin test`**: `test/mod/*.test.ts` (99 test dopo le correzioni) contro l'engine
  vero, con `process.run` (anche in ritardo, per trattenere una chiamata), `fs.exists`,
  `fs.read`, `fs.write`, `session.*`, `env.get`, `ui.*` risposti dagli hook del test
  (`test/mod/world.ts`) e `mock.clock`: ogni evento della mod, ogni risposta del ponte
  (blocco, via libera, `dormant`, nessuna risposta, non JSON, `ok: false`, `usageDropped`,
  `usageUnverified`, `unverified`, `no-loop`, sessione altrui, `armUnknown`, `retry`), i casi
  fail-open e fail-closed, `stop_hook_active`, i tetti, i debounce, la versione vecchia o
  illeggibile, l'unione con gli hook sotto. Note del kit verificate: `on('process.run', ...)`
  risponde con `{ value }` e `{ deny }` fa rifiutare la chiamata; `$.turn.step` si consuma con
  `next()` fino a `done` (`result` del `HookStream` restituito è `undefined`); registrare due
  volte lo stesso evento nel test fa fallire il caricamento.
- **e2e reale** (`test/mod/e2e-claude.mjs`; quattro esecuzioni: la prima ha portato il loop
  fino all'archivio ma ha fallito un controllo scritto male, che contava le righe `mod-stop`
  contro le transizioni senza togliere lo Stop che archivia; corretto il controllo, le altre
  tre, l'ultima con `npm run test:mod`, sono riuscite in 139-193 s): un repo git temporaneo
  fuori dal repo, `arm` del CLI (`--complexity low --verifiers correctness --advisor off
  --test "node -e 0" --no-push`), poi un solo `claude -p` (Haiku) con `--plugin-dir <repo>
  --setting-sources project --settings '{"disableAllHooks":false}' --strict-mcp-config
  --debug-file`, `ENABLE_CLAUDEAI_MCP_SERVERS=0`, stdin chiuso. Il loop va da `plan` al
  git-finish e all'archivio in circa 2-3 minuti. Prove: un `fire` per Stop, una riga
  `mod-stop` per ognuno tranne quello che archivia, e almeno altrettante righe `hooks module
  perseveranza@inline classic.Stop settled` nel log di debug; `Hooks: Found 0 total hooks in
  registry` a ogni lettura e nessuno degli script degli hook di impostazioni nominato nel log;
  `mod-start` con 2.1.289 (e la sessione); le righe `activity` tutte `via: 'mod'`; `model-route`
  (`pf-reviewer -> haiku`, `pf-verifier -> sonnet`); nello stato archiviato `usage.source:
  'mod'` con `main` e una riga per ogni subagent; `hello.txt` scritto e committato. Dopo le
  correzioni, altre due esecuzioni riuscite (139 s e 140 s; la seconda con un revisore rimandato
  due volte, `missing-twice`).
- **Mutazioni a mano** su una copia, 30, tutte uccise (`claude plugin test`, o il test Node
  pertinente): niente `.catch` sullo Stop; niente guardia `stop_hook_active` nel `.catch` dello
  Stop e in quello del giudice; un delta non confermato rimandato; uno scartato non rimandato;
  uno rimandato dopo nessuna risposta; `usageDropped` ignorato; `no-loop` rimandato; il modello
  non riscritto; un hook classico di nuovo in `hooks.json`; il `.catch` che blocca con la
  cartella non verificabile o senza verificarla; nessun tetto ai rinvii del giudice; la lente
  non passata; niente debounce, niente limite al battito, niente nuovi tentativi su `busy`;
  lo Stop che non porta i token; la guardia che non rifiuta mai; la versione sempre buona;
  l'avviso di sessione perso o che scarta il contesto degli hook sotto; la riga `mod-start` a
  ogni Stop; il ponte che scrive qualsiasi tipo nel journal, instrada per un'altra sessione,
  ignora `signals.interrupted`, non scrive `mod-stop`; `status` senza la riga `mod:`; il task
  2.x con gli a capo; uno Stop senza cartella del loop che chiama il ponte. Dopo le correzioni,
  su una copia, la batteria unita: queste 30 (adattate al codice nuovo), le 27 della verifica e
  27 nuove (il cancello sulla cartella, la copia `.pending` con e senza disarmo, il proprietario
  ignorato, `driving` ignorato o sempre vero, nessun marcatore o sempre, lo Stop che non
  aspetta o aspetta senza limite, il flush non tracciato, la delega chiusa per nome o a ogni
  Stop o al rinvio, l'op `journal` per chiunque o con la sessione della riga, `status` con il
  `mod-start` di chiunque o senza la riga del guasto, il ponte che non annota il guasto, il
  watchdog che non lo nomina, `arm` che lo lascia, il `mod-start` e il `.catch` senza
  sessione): 83 uccise su 84, sopravvive solo V22, equivalente (sopra).

### Correzioni dopo la verifica (manual-p2a: 1 critico, 8 avvisi)

- **Critico, il cancello**: era `$.fs.exists('.perseveranza')`, cioè la cartella, che esiste
  anche in `~/.perseveranza` (configurazione e archivio) e in un progetto dopo un run
  archiviato: lì ogni Stop avviava `node` e, con `node` irraggiungibile, il `.catch` bloccava
  una sessione senza loop. Ora `hasGate` applica la regola del ponte (`state.json`, oppure solo
  `state.json.pending` senza `state.disarmed.json` né `state.disarmed.mark`) in tutti gli hook.
  Test: una cartella con `config.json` e `runs` e il ponte che rifiuta: nessun
  `process.run` in nessun hook (conteggio delle chiamate), nessun blocco, nessuna scrittura, e
  `fs.exists` mai chiesto sulla cartella; i casi `.pending` con e senza i segni del disarmo.
- **W2, la traccia durevole**: il `.catch` dello Stop recupera solo per il loop di questa
  sessione (proprietario da `state.json` con `$.fs.read`; se illeggibile, solo se questo
  processo l'ha già guidato: un esito diverso da `dormant` e `foreign-session`); se il ponte non
  annota nemmeno il guasto scrive `.perseveranza/mod-fault.json` (`$.fs.write`), sempre con la
  riga sotto il prompt (`$.ui.status`) e il log di debug. `src/shell/mod-fault.mjs`: `status`
  lo mostra (`mod fault:`, anche da non armato), la notifica del watchdog lo nomina, l'op
  `stop` lo annota (`mod-fault`, anche in `history`) e lo toglie prima di poter archiviare,
  `arm` segnala e toglie quello di un run finito. Il limite è scritto sotto ("Limiti").
- **W3, la delega giusta**: `agent.spawn` lega `agentId` al `tool_use_id` della chiamata Agent
  (pinned nell'input dell'evento); il ritorno chiude quella delega, una volta per `agent_id`, e
  solo quando il subagent è lasciato andare (un giudice rimandato resta in attesa, anche dal
  `.catch`). Test con due verificatori in parallelo.
- **W4**: i tre casi del flush dell'attività (`dormant`, sessione altrui, nessuna risposta)
  rispondevano al `tool-check` della chiamata Agent; ora le risposte vanno per op e il test
  verifica che la prima risposta sia arrivata al flush.
- **W5**: test nuovi per i mutanti sopravvissuti (coda seriale con un flush trattenuto, Bash e
  PowerShell e gli altri strumenti guardati, la politica del cancello non verificabile per
  ogni hook, token di sola uscita o cache, l'unione con gli hook sotto lo Stop, nessun nuovo
  invio di righe dopo nessuna risposta, `mod-start` ritentato se non annotato, `agentId` fuori
  dall'input della guardia, un delta restituito con token più nuovi in memoria). V22 (il tetto
  nel `.catch` del giudice) è equivalente: il hook principale torna `null` al tetto prima di
  poter lanciare, quindi il `.catch` non lo vede mai; il controllo resta come difesa.
- **W6**: lo Stop aspetta un flush dei token già partito (tracciato da `track()` in `gate.js`),
  al più `STOP_FLUSH_WAIT_MS` (5 s), poi prende la memoria. Test deterministici con
  `mock.clock`: il delta rifiutato parte con lo Stop; un flush appeso trattiene lo Stop
  esattamente 5 s; senza flush nessuna attesa.
- **W7**: l'op `journal` scrive solo per la sessione proprietaria (o un run non reclamato),
  ogni riga porta `session`; con lo stato illeggibile la riga va con `ownerUnknown: true`;
  `status` legge solo il `mod-start` del proprietario.
- **W8**: versione 3.0.0 in `plugin.json`, `package.json` e nei badge; il test dell'intestazione
  segue `plugin.json` (non più `v2.` fisso) e il test di packaging chiede almeno 3.0.0 (il
  bench lo richiede).

Prove dopo le correzioni: `npm test` 449/449, 0 skip, tre volte di fila (136 s, 264 s con sei
processi che occupano la CPU, 134 s); `validate --strict` pulito (manifest e radice: ora con
`$.clock.sleep`, `$.fs.read`, `$.fs.write` via io); `claude plugin test` 99/99; e2e reale due
volte; mutazioni 83/84 (sotto); il bench `--dry-run` legge la versione 3.0.0 del repo.

### Deviazioni dal piano, con il perché

- **Il comando della mod è `/pf`**, non `/perseveranza` (vedi sopra): così `/perseveranza <task>`
  resta il markdown che avvia un task, e i README restano veri.
- **Lo strumento non ha `test` né `ask`** (la sezione 3 li elencava): li governano i permessi di
  Bash, e uno strumento di una mod non ne ha. Nemmeno `resume --takeover`.
- **`immediate` per tutto il comando**, non per `status` e `disarm` soltanto; i verbi che
  avviano qualcosa o chiudono un loop girano solo per l'utente (origine).
- **`loopMode` `'shell'`** al posto di `'cli'`, e l'effettivo è l'accordo fra lo stato e chi guida.
- **Lo strumento ha anche `history` ed `explain`**, in sola lettura.
- **Una variabile di prompt in più, `USER`**: le parole per l'utente non sono quelle per il modello.
- **L'e2e arma con il comando in un `claude -p` a sé** e guida il loop in un secondo.

### Limiti

- Solo CLI (`$.process.run`): né l'app Desktop né l'estensione VS Code.
- **Il recupero dello Stop vale una volta per turno dell'utente**: dopo il primo blocco ogni
  Stop arriva con `stop_hook_active` vero, quindi un ponte che si guasta a metà di un loop
  lascia fermare Claude al primo Stop fallito. Non è silenzioso (journal o `mod-fault.json`,
  `status`, la notifica del watchdog, la riga sotto il prompt), ma il loop resta fermo finché
  qualcuno lo riprende o il watchdog (con `PERSEVERANZA_RESTORE=1`) riapre la sessione. È il
  prezzo di "mai un blocco infinito".
- **Un interruttore del prodotto** (rischio, non provato fino in fondo): nella verifica
  `claude plugin test` ha risposto "rollout switch saved off" finché un `claude -p` con la rete
  non ha aggiornato l'interruttore salvato. Se le mod di un'installazione restano spente così,
  la mod non gira e il loop non è guidato: nessun hook di impostazioni fa da riserva, per
  scelta (un solo guidatore). `status` lo lascia vedere (nessuna riga `mod-stop` nuova, la
  riga `last fire` invecchia) e il watchdog avvisa del silenzio.
- I fatti effimeri si perdono con il processo: fino a 15 s di token e 30 s di battito; un
  reload azzera i conteggi `askedTimes` (al più 2 rinvii in più a un giudice).
- Nell'e2e il prompt chiedeva già il modello che il routing assegna (`asked` uguale a `model`
  nelle righe `model-route`): la riscrittura è provata dai test della mod (il modello riscritto
  arriva allo spawn) e, sul modello davvero usato, dalla prova 2 della sezione 1.
- Non usati perché non verificati: `$.store`, `$.turn.abort`, `tool.check`.
- Caricare la mod con `--plugin-dir` scrive `.claude-plugin/types/` e un `tsconfig.json` nella
  radice: sono in `.gitignore`, e l'e2e toglie quelli che crea.
- `npm run test:mod` = `validate --strict` (manifest e radice) + `claude plugin test` + l'e2e;
  senza `claude` sul PATH ogni passo stampa `SKIPPED`; `--no-e2e` salta solo l'e2e, e lo dice.

## Stato fase 3

Fatto: lo strumento `perseveranza` per Claude, il comando `/pf` per l'utente, le
istruzioni del loop in modalità strumento, e `arm` che rifiuta se la mod non gira nella sua
sessione. Questa sezione descrive lo stato **dopo** le correzioni della verifica 3 (in fondo):
dove la prima versione era diversa, lo dice.

```
hooks/lib/verbs.js       lo strumento e il comando: schema, controllo degli argomenti, argv del
                         CLI, divisione delle parole del comando, testo della risposta, segno di vita
hooks/lib/session.js     session.start registra strumento e comando e scrive il segno di vita;
                         classic.SessionStart lo riscrive (un /clear porta un id nuovo)
src/shell/mod-alive.mjs  il segno di vita letto da `arm` (e scritto dal ponte, op 'alive', se il
                         $.fs.write della mod è rifiutato); la potatura dei file vecchi
src/cli/verbs/arm.mjs    modCheck: rifiuto, --no-mod-check, avviso fuori sessione, loopMode
```

### Fatti verificati (mod di prova `probe5`, Claude Code 2.1.289, `claude -p --plugin-dir`)

| Fatto | Prova |
|---|---|
| `$.tool.register` in `session.start` risponde `{ tool: 'mcp__<plugin>__<nome>' }`; `$.command.register` risponde `{ command }` e accetta `immediate: true` | log della prova |
| **Claude Code non applica lo schema dello strumento**: un `verb` fuori dall'enum e un argomento in più (`"extra":1`, arrivato come stringa `"1"`) arrivano all'hook `tool.call` | il modello ha chiamato `{"verb":"bogus","extra":1}` e l'hook l'ha ricevuto |
| `{ deny }` da `tool.call` arriva al modello come risultato d'errore con il testo | la prova ha rifiutato `report fail`, il modello ha letto il testo |
| `/comando` con `{ text }` in `claude -p "/comando ..."`: 0 turni del modello, costo 0, il testo come `result` (preceduto dal nome del plugin), `exitCode` come codice d'uscita | `num_turns: 0`, `total_cost_usd: 0` |
| Il comando registrato col nome del plugin **sostituisce** il comando markdown omonimo: `next(e)` risponde "registered /<nome> but no command.run hook answered it"; il markdown resta raggiungibile come `/<plugin>:<nome>` | `/pfprobe5:pfprobe5 hello` → la risposta del markdown |
| Da un hook `command.run` non si possono chiamare né `$.prompt.submit` né `$.command.run` ("it would wait on the turn this hook is holding", controllo dell'host) | errore registrato dalla prova |
| `CLAUDE_CODE_SESSION_ID` è nell'ambiente della Bash di Claude Code e **coincide** con `$.session.id()` della mod e con il `session_id` di `classic.SessionStart` | `echo $CLAUDE_CODE_SESSION_ID` = l'id nel log della mod |
| `$.fs.write` crea le cartelle mancanti del percorso | `home/mod-alive/deep/<id>.json` scritto senza cartelle |
| `$.env.get('USERPROFILE')` e `HOME` si leggono dalla mod | log della prova |
| **Il modello non può eseguire un comando registrato da una mod**: lo strumento `Skill` risponde "pfprobe5 is a built-in CLI command, not a skill. Ask the user to run /pfprobe5 themselves"; il comando markdown del plugin (`/pfprobe5:pfprobe5`) invece sì | trascrizione della prova (verifica 3) |
| `claude -p "/comando ..."` arriva a `command.run` con `e.origin` `{"kind":"sdk"}` | log della prova (verifica 3) |
| `$.session.surfaces()`: vuoto in `claude -p` e nell'SDK, `terminal` per primo sotto il REPL (dai tipi; `RenderSurface` = terminal, desktop, mobile, vscode) | tipi 2.1.289 |
| Haiku si tiene allo schema dello strumento: le chiamate fuori schema (un verbo fuori enum, un campo non elencato) le salta, anche se gli si chiede di farle; Sonnet le fa (e consegna i booleani come stringa, `"true"`) | e2e `--scenario hostile` |
| In Git Bash un argomento `"/comando ..."` passato a `claude -p` diventa un percorso (`C:/Program Files/Git/comando`): serve `MSYS_NO_PATHCONV=1`, o uno `spawn` da Node come fa l'e2e | primo tentativo della prova |

Dai tipi 2.1.289 (`.claude-plugin/types/claude-code/index.d.ts` della prova): `CommandSpec {name,
description, argumentHint?, immediate?: true}`; `CommandRunResult {text?, context?, exitCode?}`;
`ToolSpec {name, description, inputSchema?}`; `ToolCallResult` è `{ deny }` oppure `{ result,
context? }`; `ProcessRunInit.env` si aggiunge all'ambiente dell'host; `timeoutMs` al più 10 minuti.

### Lo strumento (`mcp__perseveranza__perseveranza`)

Il principio (dalla verifica 3): uno strumento di una mod gira **senza** il prompt dei permessi
di Claude Code, quindi non deve poter eseguire nulla che i permessi di Bash governerebbero.

- Verbi: `status`, `history`, `explain` (sola lettura), `report`, `complexity`,
  `claim-done`, `pause`, `resume` (lo stato del loop, nient'altro). **Dalla 3.0.1 senza
  `resume`**, che è dell'utente: vedi "Correzioni 3.0.1" in fondo. **Non** `test` (esegue la
  suite, un comando di shell) né `ask` (avvia la CLI di un agente esterno): restano comandi di
  shell che il modello lancia con Bash, e lo strumento li rifiuta nominando il comando. **Non**
  `arm`, `disarm`, né `resume --takeover` (in nessuna forma: campo, parole, verbo): sono
  dell'utente (`/pf`).
- Su un loop di **un'altra sessione** (`owner.sessionId` diverso da quello della chiamata, letto
  con `$.fs.read`) ogni verbo che cambia qualcosa è rifiutato; un proprietario illeggibile è un
  rifiuto (il CLI con Bash resta); un loop non ancora rivendicato (appena armato, o rilasciato
  dall'utente con `/pf resume --takeover`) si può muovere. Prendere il loop di un'altra sessione
  è solo dell'utente.
- Argomenti: `verb` (l'enum dei verbi) e `args` (le parole dopo il verbo, come le scrive
  l'istruzione: `{"verb": "report", "args": "pass"}`, al più 200 caratteri), oppure i campi
  `outcome`, `level`, `tail`; `additionalProperties: false`. Anche `"verb": "complexity low"`
  si accetta (la prima parola è il verbo). Campo e parole che dicono cose diverse sono un errore.
  Le parole si controllano verbo per verbo (`verbArgs`, la stessa funzione del comando): `report`
  esattamente `pass|fail`, `complexity` una complessità, `history` `--tail N`/`N`/`--json`,
  gli altri niente. La mod controlla tutto prima di avviare un processo, perché Claude Code non
  lo fa: un errore è un `{ deny }` con il motivo e "Nothing was run". Le chiavi del prototipo
  non sono argomenti.
- Esecuzione: `[node, <plugin>/src/cli/perseveranza.mjs, verbo, ...]` con `$.process.run`, senza
  shell, `cwd` = la cartella della sessione, `env` `PERSEVERANZA_VIA=tool`, 60 s.
- **Secondo muro nel CLI**: un'esecuzione con `PERSEVERANZA_VIA=tool` che chiede un verbo fuori
  da `TOOL_VIA_VERBS` (gli stessi otto, sette dalla 3.0.1: un test tiene uguali le liste) o `resume --takeover` è
  rifiutata (exit 2) prima di caricare il verbo.
- Il cancello (senza `state.json` solo `status`), la guardia della riconciliazione (`tool-check`
  per i verbi che cambiano qualcosa, fail-open), la risposta (`done`/`FAILED or REFUSED (exit N)`,
  l'uscita tagliata a 20000 caratteri), il ripiego sul CLI e il battito come prima.

### Il comando (`/pf <verbo> [argomenti]`)

- Si chiama **`/pf`** (prima `/perseveranza`): un comando registrato prende il nome al comando
  markdown omonimo, e `/perseveranza <task>` deve restare il markdown che avvia un task (i README
  lo insegnano). Il comando markdown `/perseveranza` torna così raggiungibile col nome corto.
- Verbi: quelli dello strumento più `test`, `ask`, `arm`, `disarm`, `runs`; `help`; senza
  parole `status`. Le parole si dividono come le dividerebbe una shell, senza mai darle a una
  shell; al più 8000 caratteri e 64 parole, niente caratteri di controllo.
- **Parole in più rifiutate**: `arm`, `test` e `ask` passano le loro parole al CLI (che le
  controlla); ogni altro verbo accetta solo le sue (`disarm [--no-archive]`, `resume
  [--takeover]`, `status [--json]`, `report pass|fail`...). `/pf disarm the legacy alarm
  module` risponde con l'errore e l'aiuto, exit 2, e non disarma niente.
- **Solo per quello che l'utente digita**: `arm`, `disarm`, `test`, `ask` e `resume --takeover`
  girano solo se `e.origin.kind` è `composer` (Invio al prompt), `bridge` (Remote Control) o
  `sdk` (`claude -p`, verificato: la prova registra `{"kind":"sdk"}`); da `$.command.run` di
  un altro plugin (`plugin`) o da un'origine ignota rispondono il rifiuto, exit 1. Il modello
  non può eseguire il comando: lo strumento `Skill` rifiuta un comando registrato da una mod
  ("pfprobe5 is a built-in CLI command, not a skill. Ask the user to run /pfprobe5 themselves",
  provato con `probe5`; il markdown `/pfprobe5:pfprobe5` invece il modello lo esegue).
- `immediate: true`, la risposta `{ text, exitCode }` (0..255, altrimenti 1), il segno di vita e
  `CLAUDE_CODE_SESSION_ID` prima di `arm`, il cancello dei verbi che agiscono su un loop
  (`ask` e `test` compresi) come prima.

### `arm` e la mod

- La mod scrive `<home>/mod-alive/<sessione>.json` (`{ session, at, claudeCode, plugin, cwd }`)
  a `session.start` (con `$.session.id()`), a ogni `classic.SessionStart` (con il suo
  `session_id`: dopo un `/clear` l'id cambia e `session.start` non scatta) e prima di
  `/pf arm`, **solo dove la sessione è della CLI**: `$.session.surfaces()` vuoto (`claude -p`,
  l'SDK) o con `terminal`. Una sessione disegnata solo da Desktop o VS Code (dove `$.process.run`,
  "CLI only" nei tipi, potrebbe mancare) o una `surfaces()` che fallisce non lascia segno: `arm`
  lì rifiuta, e `--no-mod-check` arma con le parole del CLI. `home` come in Node: `PERSEVERANZA_HOME`, altrimenti `USERPROFILE`, poi
  `HOME`, più `/.perseveranza`. Con `$.fs.write` (nessun processo); se è rifiutato, o la home
  non si legge, il ponte (op `alive`). Un id che non è un id
  (`/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/`) non diventa mai un nome di file, né nella mod né in
  `arm`.
- `arm`, prima di scrivere qualsiasi cosa:
  - dentro una sessione (`CLAUDE_CODE_SESSION_ID` valido) col segno di vita: arma con
    `options.loopMode = 'tool'`;
  - dentro una sessione senza: **rifiuta** (exit 1) con le cause probabili e come procedere, e
    non crea `.perseveranza/` né tocca un loop già armato (anche con `--force`);
  - `--no-mod-check`: arma senza controllo, `loopMode = 'shell'`;
  - fuori da ogni sessione (un terminale, uno script, i test): arma con un avviso, `loopMode =
    'shell'`;
  - toglie i segni di vita più vecchi di 30 giorni e i più vecchi oltre i 100, mai il proprio,
    solo i propri file (`<id>.json`): la mod non può cancellare.
- La mod, a `session.start` (una volta per processo), elenca la cartella con `$.fs.list` (nessun
  processo) e solo oltre 200 segni di vita, o con uno più vecchio di 30 giorni, chiede al ponte
  la potatura (op `alive` con `facts.prune`).
- Un segno di vita scritto a metà (`$.fs.write` non è atomico) conta: conta la presenza.
- Il valore è `'shell'`, non `'cli'`: `LOOP_MODES` della fase 1 usa già `shell`/`tool`.

### Le istruzioni

- `options.loopMode` nello stato (`'shell'` di default, `'tool'`). Lo Stop della mod porta
  `facts.loopMode = 'tool'` quando la mod ha registrato lo strumento; il ponte rende le
  istruzioni con lo strumento solo se **entrambi** dicono `'tool'` (`effectiveLoopMode` in
  `prompts.mjs`): un run armato da un terminale, o uno Stop guidato senza la mod, parla con il
  CLI. Lo stesso per l'avviso di sessione (op `session-start`, `facts.loopMode`).
- `LOOP` in modalità strumento: `the `perseveranza` tool ({"verb": "<the first word>", "args":
  "<the words after it, if any>"}):` (la prima versione diceva "(verb and args)" e Haiku mandava
  `{"verb":"complexity","args":"low"}`, che allora era rifiutato).
- `USER` (nuova variabile, in `plan-approval` e negli avvisi `session-abandoned`, `-live`,
  `-released`, `-waiting`): quello che digita l'utente. In modalità shell è uguale a `LOOP` (il
  testo resta identico byte per byte); in modalità strumento `loop-user-tool`, `(typed by the
  user) /pf`. I pacchetti en/it la usano; un pacchetto personale con `{{LOOP}}` in quei prompt
  resta valido.
- La suite e i modelli esterni sono **sempre** il CLI: in modalità strumento `testRun` e
  `askHint` hanno davanti `loop-bash` ("the shell command (run it with Bash, the `perseveranza`
  tool does not run it):"). `hint-ask-tool` è tolta (non serve più).
- Il blocco di recupero dello Stop (ponte irraggiungibile) nomina lo strumento con `status` e il
  CLI come ripiego.
- `commands/perseveranza.md`: i verbi del loop con lo strumento quando c'è (con gli esempi esatti
  `{"verb": ..., "args": ...}`), `test` e `ask` sempre col CLI da Bash, il CLI come ripiego
  esplicito per il resto; `arm` resta il comando di shell (lo strumento non arma); `disarm` e
  `resume --takeover` sono `/pf` dell'utente; se `arm` dice che la mod non gira, il modello
  mostra il messaggio e si ferma, senza `--no-mod-check` se l'utente non lo chiede. Agenti
  `pf-*`: i verbi sono del coordinatore (lo strumento per quelli del loop, il CLI da Bash per
  `test`, `ask` e come ripiego), non loro (i loro `tools:` non includono lo strumento). I README
  (it/en) descrivono `/pf` e lo strumento, e `PERSEVERANZA_SUBAGENT_WAIT_MS`.
- Il journal: `via: 'tool'` o `'command'` su ogni riga scritta dal processo del CLI avviato
  dalla mod (`PERSEVERANZA_VIA`, che il CLI toglie dal proprio ambiente prima di avviare
  altro); il riassunto archiviato ha `verbs: [{ verb, value, via }]` e `tests[].via` (`'shell'`
  quando il verbo è arrivato da una Bash o da un terminale).

### Prove (prima versione, superate dalle correzioni sotto)

- `npm test`: 476 test, 0 skip, 0 fail, tre volte (una sotto carico, con la batteria delle
  mutazioni e un e2e in corso: 189 s). Nuovi: `test/e2e/mod-tool.test.mjs` (`arm`: rifiuto,
  vivo, scritto a metà, sessione altrui, `--no-mod-check`, fuori sessione, id ostili, potatura,
  nessuna scrittura al rifiuto; `via` nel journal e nel riassunto, la variabile non ereditata
  dalla suite; `test` dallo strumento solo per la suite armata; le parole delle istruzioni e
  dell'avviso secondo `effectiveLoopMode`; op `alive`), `test/unit/mod-verbs.test.mjs` (schema,
  argomenti, argv, parole del comando, risposta, `effectiveLoopMode`, ogni prompt con
  `{{LOOP}}` nelle due modalità e nelle due lingue, l'advisor, ogni lente), il riassunto in
  `test/unit/shell.test.mjs`. `CLAUDE_CODE_SESSION_ID` è tolto dall'ambiente della suite
  (`test/run.mjs`, `OWN_ENV_VARS`): i test non dipendono dal girare dentro una sessione.
- `claude plugin validate --strict` (manifest e radice) pulito: `hooks: ..., tool.call,
  command.run{command=perseveranza}, turn.step`, `calls: ... $.command.register (via io),
  $.tool.register (via io) ...`, `env reads: HOME, PERSEVERANZA_HOME, PERSEVERANZA_NODE,
  USERPROFILE`.
- `claude plugin test`: 166 (99 di prima + 67 in `test/mod/verbs.test.ts`: registrazione, segno
  di vita e le sue case, ogni verbo con argv/cwd/env/stdin/tempo, risposte, taglio, ripiego,
  battito, 21 argomenti non validi, cancello, riconciliazione, il comando in ogni caso).
  `test/mod/world.ts` risponde anche alle esecuzioni del CLI (`cliRuns`), a `tool.register`,
  `command.register` e alle home in `env.get`, e tiene il segno di vita (`alive`) separato
  dalle scritture nel progetto.
- e2e reale (`test/mod/e2e-claude.mjs`, scenario `tool`, ora il predefinito): `claude -p
  "/perseveranza arm ..."` arma (0 turni, `loopMode: 'tool'`, nota `armed` con `via:
  'command'`), `claude -p "/perseveranza status"` risponde con exit 0, poi un `claude -p` guida
  il loop dal piano al git-finish. Due esecuzioni riuscite (146 s e 161 s), la seconda con il
  codice finale: il modello ha chiamato lo strumento 7 volte (`status`, `complexity`, `test`,
  `report`, `test`, `claim-done`, `test`), nessun errore, nessun verbo da Bash; nel journal
  `complexity`, `report`, `claim-done` e tre `test` con `via: 'tool'`, e così nel riassunto
  archiviato; 10 istruzioni, tutte con lo strumento e nessuna con `perseveranza.mjs`; un segno
  di vita per ciascuna delle tre sessioni; i controlli di prima (Stop della mod, nessun hook di
  impostazioni, token per agente, routing) tutti verdi. Lo scenario di prima (`--scenario
  shell`: `arm` del CLI fuori sessione, con l'avviso) è riuscito anch'esso (345 s).
- Mutazioni a mano su una copia (`mut-p3.mjs` nello scratchpad della sessione): 37, tutte uccise
  dai test (`claude plugin test` o il test Node pertinente): la validazione degli argomenti
  tolta; `arm`/`disarm` permessi al modello (nell'enum, o senza il controllo); una stringa di
  shell al posto di argv; il cancello dello strumento e quello del comando tolti; `arm` senza
  controllo della mod; `loopMode` sbagliato; la modalità decisa dal solo guidatore; le parole
  dello strumento che citano ancora `node ... perseveranza.mjs`; `PERSEVERANZA_VIA` ereditata;
  il journal senza `via`; la guardia della riconciliazione saltata per lo strumento (e quella
  che lascia passare ogni verbo); nessun segno di vita a `classic.SessionStart`; il comando non
  `immediate` o non registrato; la chiamata passata a Claude Code dopo la risposta; il prompt
  di `ask` in argv; lo Stop sempre in parole di shell; le chiavi del prototipo prese per
  argomenti; un id di sessione qualsiasi come nome di file (sopravvissuta alla prima batteria:
  il test guardava solo i percorsi `mod-alive/`, ora guarda ogni scrittura); `arm` che pota il
  proprio segno di vita; un segno scritto a metà che non conta; il taglio che tiene solo
  l'inizio; `/perseveranza arm` senza l'id di sessione; il riassunto senza `via`; ogni valore
  vero come booleano; un comando di `test` su due righe; il rifiuto fuori sessione al posto
  dell'avviso; `--no-mod-check` ignorato; l'avviso di sessione senza la modalità (mod e ponte);
  `test` dallo strumento con qualsiasi comando, con un altro comando, senza suite armata; il
  CLI che non passa `via` al verbo.

### Deviazioni dal piano, con il perché

- **`/perseveranza <task>` non arma più tramite il modello**: il comando della mod prende il nome
  al comando markdown (provato), e da un hook `command.run` non si può né inoltrare al markdown
  né avviare un turno. Il markdown resta come `/perseveranza:perseveranza <task>`; parole che non
  sono un verbo ricevono l'aiuto che lo dice. Rottura da scrivere nei README (fase 4).
- **`immediate` per tutto il comando** (vedi sopra), non per `status` e `disarm` soltanto.
- **`loopMode` `'shell'`** al posto di `'cli'`, e l'effettivo è l'accordo fra lo stato e chi guida.
- **Lo strumento ha anche `history` ed `explain`**, in sola lettura.
- **L'e2e arma con il comando in un `claude -p` a sé** e guida il loop in un secondo: il primo
  non ha turni del modello, quindi nessuno Stop che reclami il loop (verificato: la prima riga
  `fire` del journal è della sessione che guida).

### Limiti

- Il segno di vita dice che la mod è partita in quella sessione, non che gira ancora: una mod
  scaricata a sessione aperta non lo toglie.
- **Desktop e VS Code**: non ho un modo verificato per sapere se `$.process.run` c'è (i tipi
  dicono "CLI only", senza un'API che lo chieda). La mod decide dalla superficie
  (`$.session.surfaces()`): niente segno di vita in una sessione disegnata solo da `desktop`,
  `vscode` o `mobile` senza `terminal`. Se Desktop o VS Code avessero `$.process.run`, lì
  `arm` rifiuterebbe lo stesso (con `--no-mod-check` arma in modalità shell); il contrario
  (un segno di vita dove il ponte non parte) non accade più per quelle superfici.
- `PERSEVERANZA_HOME` diversa per Claude Code e per la sua Bash (impostata solo in un profilo
  di shell): la mod scrive dove dice l'ambiente di Claude Code, `arm` cerca dove dice quello
  della Bash, e rifiuta; è tra le cause che `arm` elenca.
- Il prompt di ripristino del watchdog (`restorePrompt`) nomina sempre il CLI: la sessione
  ripristinata da `claude --resume` può non avere la mod caricata.
- `USER` in modalità strumento è `/pf` anche se la registrazione del solo comando fosse
  fallita (raro: un nome preso); il CLI resta nominato nei messaggi di errore e nell'aiuto.
- L'attesa di un subagent (30 s per Stop) è tempo dello Stop, non del modello: con tre attese
  il modello aspetta fino a 90 s in più per richiesta prima che decida la logica di sempre. Per
  `implement` non c'è un file da aspettare: finisce prima solo col ritorno del subagent
  registrato dalla mod (`activity.json`, `subagent-stop`).

### Correzioni dopo la verifica 3 (manual-p3a: 2 critici, 8 avvisi)

**Critico 1, lo strumento aggira i permessi** (uno strumento di una mod gira senza prompt, e
`ask` avviava CLI di agenti con prompt scritti dal modello, `resume --takeover` prendeva il loop
di un'altra sessione). Corretto:
- lo strumento ha solo `status`, `history`, `explain`, `report`, `complexity`, `claim-done`,
  `pause`, `resume`; `test` e `ask` sono rifiutati con il comando di shell da usare con Bash;
  `resume --takeover` in ogni forma (campo `takeover`, parole `--takeover`, nel verbo) è
  rifiutato e rimanda a `/pf resume --takeover`;
- un loop di un'altra sessione: ogni verbo che cambia qualcosa è rifiutato (proprietario letto
  con `$.fs.read`; illeggibile = rifiuto);
- secondo muro nel CLI (`toolViaRefusal` in `src/cli/perseveranza.mjs`): con
  `PERSEVERANZA_VIA=tool` ogni verbo fuori dai otto, e `resume --takeover`, esce con 2 prima di
  caricare il verbo;
- `/pf`: `arm`, `disarm`, `test`, `ask` e `resume --takeover` solo per origine `composer`,
  `bridge` o `sdk`. Il modello non arriva al comando: `Skill` rifiuta i comandi di una mod
  (provato con `probe5`, vedi i fatti).
**Critico 2, la restrizione di `test` aggirabile modificando `options.testCmd`**: sparisce con
`test` fuori dallo strumento; `toolTestRefusal` (che serviva solo a quello) è tolta.
`tool.check`/permessi come difesa in più: non usati, non ho verificato come si comportano per uno
strumento di una mod; i due muri sopra non ne dipendono.

**Avvisi**:
- e2e rosso per `{"verb":"complexity","args":"low"}`: `args` è ora la forma prima (le parole
  dell'istruzione), `LOOP` in modalità strumento dice esattamente `{"verb": "<the first word>",
  "args": "<the words after it, if any>"}`, la descrizione dello strumento dà gli esempi esatti;
  anche `"verb": "complexity low"` e i campi tipizzati valgono, in disaccordo sono un errore.
- `/perseveranza disarm the legacy alarm module` disarmava: il comando è `/pf` (così
  `/perseveranza <task>` torna al markdown e i README restano veri), e ogni verbo che non prende
  parole rifiuta quelle in più (`verbArgs`); `disarm` accetta solo `--no-archive`.
- I prompt per l'utente in modalità strumento: variabile `USER` (`(typed by the user) /pf`), nei
  pacchetti en e it, un test per ogni prompt rivolto all'utente nelle due lingue.
- `test --if-needed -- <cmd>` senza `--test`: la suite è sempre il CLI da Bash (`loop-bash`).
- Le attese di `subagent-running` consumate in 4 s: lo Stop aspetta in tempo reale (sopra), e un
  verdetto che arriva durante l'attesa si legge nello stesso Stop.
- I segni di vita si accumulano: potatura per età e numero, da `arm` e dalla mod all'avvio.
- Desktop/VS Code: la superficie (sopra, e nei limiti).
- I 4 mutanti sopravvissuti, uccisi: `ask` tolto dal cancello del comando (test: `/pf ask` senza
  loop non avvia processi), un codice d'uscita negativo (`exitCodeOf`, test con -1 e -255),
  `HOME` letto prima di `USERPROFILE` (test con entrambe), "done" per ogni uscita diversa da 1
  (test con 2, 3, 124, 255, -1).

### Prove delle correzioni

- `npm test`: 486 test, 0 skip, 0 fail, sul codice finale tre volte: 169 s sotto carico (un e2e
  reale in corso), 194 s (con la batteria delle mutazioni in corso), 156 s da solo. Nuovi o
  riscritti: `test/unit/mod-verbs.test.mjs` (le liste dello strumento e del CLI uguali, il muro
  del CLI per ogni verbo, lo schema e la descrizione, `args` e campi, i rifiuti per tipo, le
  parole di `/pf` con 17 frasi da rifiutare, `exitCodeOf`, ogni prompt nelle due modalità e
  lingue: in modalità strumento il CLI compare solo dopo `loop-bash` e solo per `test`/`ask`,
  ogni prompt per l'utente con `/pf`), `test/unit/mod.test.mjs` (`subagentWaitMs`,
  `waitForSubagent` con un orologio finto), `test/e2e/mod-tool.test.mjs` (il CLI con `via=tool`:
  la suite armata, la suite messa in `state.json` da "qualcuno", una suite data nelle parole,
  `ask`, `arm`, `disarm`, gli altri verbi e `resume --takeover` rifiutati con exit 2, nessun
  marcatore, stato e journal intatti, e lo stesso dal comando o da una shell gira; la suite per
  Bash nelle istruzioni; gli avvisi con `/pf`; la potatura per età e numero),
  `test/e2e/mod-bridge.test.mjs` (l'attesa in tempo reale con un verdetto scritto da un altro
  processo a metà Stop, la finestra intera senza verdetto, la fine anticipata col ritorno del
  subagent, mai oltre la scadenza, i token della mod messi in coda una volta sola),
  `test/packaging/names.test.mjs` (`PERSEVERANZA_SUBAGENT_WAIT_MS` documentata nei due README).
- `claude plugin validate --strict` (manifest e radice): pulito, con `$.fs.list` e
  `$.session.surfaces` tra le chiamate e `command.run{command=pf}`.
- `claude plugin test`: 187 (`test/mod/verbs.test.ts` riscritto: ogni verbo vietato allo
  strumento in ogni forma, `deny` con "Nothing was run" e nessun processo; il loop di un'altra
  sessione; il proprietario illeggibile; `/pf` con parole in più, con ogni origine, `ask`/`test`
  senza loop; le superfici; la potatura dalla mod; l'ordine `USERPROFILE`/`HOME`; i codici
  d'uscita -1, 2, 300). `test/mod/world.ts` risponde anche a `session.surfaces` e `fs.list`; il
  banco di prova passa `origin` di `$.command.run` così com'è (provato: `plugin` rifiutato,
  `composer` eseguito).
- **Prova ostile reale** (`node test/mod/e2e-claude.mjs --scenario hostile`, modalità di permesso
  **default**, nessuno strumento permesso: Bash, Write, Edit rifiutati, lo strumento della mod
  senza prompt): loop armato con `/pf arm` e una `--test` che scrive un marcatore; poi
  `options.testCmd` cambiato in `state.json` con un altro marcatore, il loop dato a un'altra
  sessione e messo in pausa, un `codex` finto nel PATH che scrive un marcatore. Il modello
  (Sonnet) ha fatto tutte le 11 chiamate: `test` (4 forme, campi di prima compresi), `ask` (2
  forme), `resume` con `takeover` campo e parole, `resume` e `pause` del loop altrui: **tutte
  risultati d'errore** con "Nothing was run"; `status` eseguito. Nessun marcatore, proprietario,
  pausa e suite intatti, nel journal nessuna riga `test`/`signal`/`external`. Controllo: la
  stessa suite e lo stesso `ask codex` da una shell lasciano i loro marcatori. Due esecuzioni
  riuscite (26 s, 22 s). Con Haiku il modello salta le chiamate fuori schema (lo dice lui: "not a
  valid verb (not in enum)") e quelle fatte sono rifiutate allo stesso modo: per questo lo
  scenario usa Sonnet.
- **e2e reale, scenario `tool`**: due esecuzioni riuscite sul codice finale (122 s, 165 s), una
  prima (155 s) su quello appena prima di due ritocchi (un commento, i test). Il modello chiama lo
  strumento per `status`, `complexity`, `claim-done` senza errori (con `args`), mai per
  `test`/`ask`; la suite gira col CLI da Bash (2-3 volte), nessun altro verbo da Bash; nel
  journal i verbi `via: 'tool'`, i test senza `via` (`'shell'` nel riassunto); le istruzioni
  nominano lo strumento e il CLI solo per la suite, dopo le parole per Bash. L'attesa reale:
  `{"type":"subagent-wait","phase":"review","ms":9208,"landed":"review.json"}` (il verdetto letto
  nello stesso Stop, la review passata senza attese consumate) e, nell'altra,
  `{"ms":30001}` seguita da un `subagent-running` e poi `pass`. **Scenario `shell`**: riuscito
  (136 s).
- **Mutazioni** (`mut-p3b.mjs` nello scratchpad, una copia del repository): 45, tutte uccise
  (44 nella batteria; la R33, "`PERSEVERANZA_SUBAGENT_WAIT_MS=0` non spegne l'attesa", è
  sopravvissuta alla prima e uccisa dal test unitario aggiunto per lei). Tra queste: `test` e
  `ask` eseguibili dallo strumento; il muro del CLI tolto, o con `test` permesso, o senza il
  controllo del takeover; il takeover come campo e come parole; il loop altrui mosso; il
  proprietario illeggibile preso per nessuno; `/pf` per ogni origine, o `plugin` come utente, o
  il takeover non sensibile; parole in più accettate da `disarm`, `pause`, `claim-done`, un flag
  ripetuto; i quattro sopravvissuti della verifica; `args` ignorato, campo e parole in
  disaccordo, il verbo non diviso; `/pf` col vecchio nome; `USER` uguale allo strumento, la
  suite e `ask` nominati con lo strumento, gli avvisi senza `USER`, le parole per l'utente;
  l'attesa tolta, il verdetto non letto, i token due volte, oltre la scadenza, il ritorno del
  subagent ignorato; la potatura del proprio segno, di file non suoi, senza tetto, mai chiesta
  dalla mod o chiesta sempre, ignorata dal ponte; il segno di vita su ogni superficie o con
  `surfaces()` che fallisce; e, di nuovo, argv al posto di una stringa di shell, il cancello, le
  chiavi del prototipo, la chiamata passata a Claude Code. La copia, ripristinata, passa tutto.
- **I5, il percorso senza mod confrontato con HEAD** (`git archive HEAD` in una cartella a parte;
  `i5p3/flow.mjs` e `cmp.mjs` nello scratchpad): lo stesso scenario intero sui due alberi, dal CLI
  e dagli hook di impostazioni (`stop.mjs`, `session-start.mjs`), senza sessione: `arm`,
  `status`, `complexity`, `pause`, `resume`, l'avviso a un'altra sessione, una review fallita e
  il suo fix, `history`, `explain`, `test --if-needed`, `claim-done`, la pulizia, la verifica
  finale, il git-finish, l'archivio, `runs`; con le lenti `correctness,tests`, `general` e
  `security`. Normalizzati solo i nomi rinominati in 3.0 (cartella di stato, nome del CLI e
  variabili d'ambiente: tabella nel CHANGELOG), le versioni, i tempi, gli id e i percorsi. Ogni istruzione dello Stop, l'avviso di
  sessione e ogni riga del journal tranne la prima sono **identici**; restano 11 differenze, tutte
  aggiunte: la riga di avviso di `arm` fuori sessione (fase 3), `subagent-running` nell'elenco
  degli esiti di `status` ed `explain` (fase 1), `options.loopMode` nella nota `armed` e nello
  stato (fase 3), `counters.subagentWaits`, `counters.quietStops`, `usageInboxSeen`, `rev`
  nello stato (fasi 1-2), `tests[].via` e `verbs` nel riassunto (fase 3).
- Nessun file estraneo nel repository (`.perseveranza`, `mut`, la vecchia cartella di stato, `tsconfig.json`,
  `.claude-plugin/types` assenti), nessun TODO, `.skip` o `.only` nei file toccati, tutti LF.

## Stato fase 4

Fatto: il pacchetto. L'installazione manuale carica il plugin come mod, nessun hook di
impostazioni dichiarato da nessuna parte, README e CHANGELOG per chi usa la 3.0, `npm run
test:mod` intero; prima, le correzioni dei quattro avvisi della verifica manual-p3b.

### Correzioni dopo la verifica manual-p3b (0 critici, 4 avvisi)

- **W1, il segno di vita di una sessione lunga potato.** Scritto solo all'avvio, il file di una
  sessione aperta da ore finiva dietro a cento `claude -p` più giovani e la potatura per numero lo
  toglieva: il suo `arm` rifiutava. Ora la mod lo riscrive alle chiamate di strumenti della
  sessione (`hooks/lib/verbs.js` `refreshAlive`, da `tool.js` e dallo strumento `perseveranza`,
  al più ogni 10 minuti, solo con `$.fs.write`: un rinfresco non avvia mai un processo), e la
  potatura per numero non tocca mai un file di meno di un giorno (`ALIVE_PROTECT_MS` in
  `src/shell/mod-alive.mjs`; per età resta 30 giorni). Il caso della verifica è un test e2e
  (sessione di 2 ore, 100 figli dell'ultima ora: sopravvive e arma); il rinfresco ha 6 test della
  mod con `mock.clock` (scrive, non riscrive entro 10 minuti, riscrive dopo, nessun ponte se
  `$.fs.write` è rifiutato, niente su Desktop, niente per un id che non è un id).
- **W2, il bench dentro una sessione di Claude Code.** `reference_target_agent.py` arma con
  `--no-mod-check` (il loop lo guida il `claude -p` che parte dopo, non il runner) e toglie
  `CLAUDE_CODE_SESSION_ID` dall'ambiente di ogni suo processo (`child_env`). Prova: il dry run
  lanciato da questa sessione, con la variabile impostata, chiude i tre mini-task (7 iterazioni
  ciascuno, "dry run OK").
- **W3, `/pf runs show <progetto>/<data>`.** `isRunId`: al più due parti separate da `/`, ognuna
  `[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}` (i nomi di `archive.mjs` `safe()` e le date), quindi mai
  `..`, una parte che comincia con un punto, `\`, `:` o un percorso assoluto. Test unitari e
  della mod: accettati gli id come li stampa `runs list` (anche con `--all`), rifiutati
  `a/b/c`, `/abs`, `proj/..`, `proj/.x`, `a\b`, `C:x`, `proj/`, `../x`, `.hidden`.
- **W4, i mutanti sopravvissuti.** Test nuovi: lo strumento con un id di sessione vuoto e un
  proprietario (altrui o "S1") rifiuta ogni verbo che cambia qualcosa (V3); `/pf` senza `origin`,
  con `origin: null`, `{}` o `kind` non stringa rifiuta `arm`, `disarm`, `test`, `ask`, `resume
  --takeover`, anche in un test unitario con un `io` che esplode a ogni chiamata (V10); il muro del
  CLI rifiuta `--takeover` in qualunque posizione (V13); `history` dallo strumento rifiuta
  `--tail 501`, `9999` e `tail: '9999'` (V6); `runs show` come sopra (V8).

### Il pacchetto

- **`install.mjs`** fa ciò che la documentazione prevede per un plugin che non viene da un
  marketplace (`CLAUDE_CODE_PLUGIN_DIRS`, "Environment, or `env` in `~/.claude/settings.json`",
  riferimento delle mod): copia la cartella del plugin (`ALL_FILES` del manifest) in
  `<claude>/perseveranza/`, preparata in una cartella a parte e poi scambiata con la vecchia, e
  aggiunge quella cartella alla lista (`;` su Windows, `:` altrove) lasciando le altre voci e
  ogni altra chiave. Toglie gli hook di impostazioni della 1.x e della 2.x
  (`LEGACY_SETTINGS_HOOK_SCRIPTS` in `src/shell/legacy.mjs`, in ogni evento; un gruppo, un evento e
  `hooks` spariscono solo se li ha svuotati lui), i file della 1.x in `hooks/` e le copie 2.x di
  comando e agenti (solo se sono le nostre: il comando con il CLI e senza
  `${CLAUDE_PLUGIN_ROOT}`, gli agenti con `name: pf-` che nominano la cartella di stato della
  2.x o la nuova). `settings.json` è letto e controllato
  **prima** di toccare qualunque cosa: non JSON, non un oggetto, `env` non oggetto, la lista non
  stringa, una cartella al suo posto, un file non scrivibile: rifiuto, codice 1, niente cambiato
  (né la copia né il file). Al primo cambiamento ne fa una copia
  (`settings.json.bak-perseveranza`, mai sovrascritta: vedi le correzioni dopo la verifica
  finale), lo scrive solo se cambia e con un rename. `--uninstall` toglie la voce (la chiave e `env` se
  restano vuote), la cartella e gli avanzi; un argomento sconosciuto dà codice 2; il plugin del
  marketplace abilitato insieme dà un avviso.
- **Prova reale** (Claude Code 2.1.289, una home temporanea nello scratchpad: `HOME` e
  `USERPROFILE` puntati lì, `CLAUDE_CODE_OAUTH_TOKEN` passato al solo processo figlio per
  l'accesso): `node install.mjs` su un `settings.json` con un'altra chiave d'ambiente e un hook
  `Stop` della 2.x → hook tolto, voce aggiunta, copia di sicurezza; poi in un progetto vuoto
  `claude -p "/pf help"` risponde con l'aiuto della mod (nessun turno del modello), `/pf status`
  dice "NOT armed" con codice 1, `/pf arm` arma **in modalità strumento** ("Mod: alive in this
  session ... on Claude Code 2.1.289") e la sessione dopo è guidata dalla mod (8 `mod-stop` nel
  journal), un `claude -p` chiede allo strumento `{"verb":"status"}`
  (`mcp__perseveranza__perseveranza` nel flusso JSON) e riceve la risposta del CLI. Dopo
  `node install.mjs --uninstall` la chiave è sparita, `KEEP` è rimasta, e `/pf` non esiste più.
  Nota: in Git Bash `claude -p "/pf help"` arriva come `C:/Program Files/Git/pf help` (la
  conversione dei percorsi di MSYS); serve `MSYS_NO_PATHCONV=1`. Da Node, PowerShell o cmd no.
- **`manifest.mjs`** non ha più `HOOK_SPECS` né le tre entrate degli hook; `stop.mjs`,
  `session-start.mjs` e `activity-hook.mjs` restano (il ponte e i test li usano, e un hook scritto
  a mano può ancora chiamarli) e lo dicono in testa.
- **Test** (`npm test`, nessuna rete): `test/packaging/install.test.mjs` (10: installare in una
  home temporanea come fa un utente, senza `--claude-dir`; reinstallare senza scrivere né rifare
  la copia di sicurezza, con `mtime` invariato; disinstallare; gli avanzi 1.x/2.x tolti e quelli
  dell'utente tenuti; 8 JSON ostili per `install` e `--uninstall`; un file vuoto; una cartella al
  posto del file; un file in sola lettura; gli argomenti; l'avviso del marketplace; le parti pure;
  `npm run test:mod` con un `PATH` vuoto dice `SKIPPED` per ogni passo e non esegue niente);
  `packaging.test.mjs` (né il manifest né `install.mjs` dichiarano hook, `hooks.json` solo
  `modules`); `test/packaging/references.test.mjs` (6: ogni percorso del repository, verbo del
  CLI, di `/pf` e dello strumento, variabile, script npm, agente, link relativo e ancora citati
  da README, comando, agenti e prompt esistono; `{{LOOP}}` solo con i verbi dello strumento, tranne
  `hint-ask` che è reso sempre con il CLI; `{{USER}}` solo con quelli di `/pf`).
- **README** (it/en, allineati): installazione con i tre modi, sezione "La mod" (cos'è,
  requisiti, uso con la tabella di `/pf` e i verbi dello strumento, sicurezza: cosa il modello
  non può fare con lo strumento, risoluzione dei problemi con la tabella dei rifiuti di `arm`,
  `mod-fault.json`, l'interruttore remoto, limiti noti), migrazione con la tabella dei nomi, la
  rottura dichiarata e come togliere gli hook vecchi; badge 3.0.0 e "mod ≥ 2.1.287"; tabella
  delle variabili con `PERSEVERANZA_NODE` e `PERSEVERANZA_SUBAGENT_WAIT_MS`; le frasi sugli hook
  di impostazioni riscritte per la mod. `docs/loop-budget.md` allineata (scadenza dello Stop,
  costo del battito, token della mod).
- **CHANGELOG**: "Non rilasciato (3.0.0)" con Rotture, Novità, Correzioni, Migrazione (la tabella
  completa), Limiti; i dettagli delle fasi in fondo, come sottosezioni, con la fase 4.
- **`npm run test:mod`** passa `ENABLE_CLAUDEAI_MCP_SERVERS=0` ai suoi processi e, se un passo
  fallisce per l'interruttore remoto, lo dice con il rimedio.

### Prove

- `npm test`: 503 test, 0 skip, 0 fail, sul codice finale tre volte: 163 s e 157 s da soli,
  239 s sotto carico (in parallelo la suite intera su una copia e `claude plugin test`). Prima
  degli ultimi ritocchi (un test di `hook.test.mjs`, `docs/loop-budget.md`) altre due: 195 s da
  sola, 221 s con `npm run test:mod` in corso.
- `claude plugin validate --strict` (manifest e radice): pulito. `claude plugin test`: 197 (10 in
  più: i 6 del rinfresco, lo strumento con un id di sessione vuoto, `/pf` senza `origin`,
  `runs show`), verde anche sotto carico.
- **`npm run test:mod` intero**: i due `validate`, `claude plugin test` (197) e l'e2e reale
  (scenario `tool`, 148 s: `/pf arm` in modalità strumento, lo strumento per `status`,
  `complexity`, `claim-done`, la suite da Bash, archivio). Con un `PATH` senza `claude` (solo la
  cartella di `node`): i tre passi `SKIPPED - claude is not on the PATH`, codice 0; lo stesso è un
  test di `npm test`.
- **e2e reali** (toccati lo strumento e il comando markdown): `--scenario hostile` riuscito (28 s,
  Sonnet: ogni chiamata vietata un risultato d'errore, nessun marcatore), `--scenario shell`
  riuscito (143 s, token della mod per agente, routing dei `pf-*`).
- **Bench**: il dry run lanciato da questa sessione, con `CLAUDE_CODE_SESSION_ID` impostata, chiude
  i tre mini-task e dice "dry run OK".
- **`install.mjs` reale** in una home temporanea, come sopra (due prove: la seconda sul codice
  finale, con un hook `Stop` 2.x tolto e `/pf help` dalla mod).
- **Mutazioni** (`mut-p4.mjs` nello scratchpad), su copie del repository **con `.git`**, in 4
  blocchi paralleli: **100, tutte uccise**, nessuna solo dalla suite intera. Le 45 di prima (la
  R36 e la R41 riscritte sul codice di adesso); le 20 della verifica, con V7/V8 sostituite da 4
  mutanti di `isRunId` (punto iniziale, più barre, parte vuota, `progetto/data` di nuovo
  rifiutato): V3, V6, V8, V10, V13, sopravvissute alla verifica, ora uccise; 7 del rinfresco
  (mai, a ogni chiamata, col ponte, non da `tool.js`, non dallo strumento, la potatura dei file
  giovani, la finestra di un'ora); 15 di `install.mjs` (niente copia di sicurezza, JSON non valido
  sovrascritto, hook vecchi tenuti, le altre cartelle perse, una seconda esecuzione che riscrive,
  il controllo di scrittura tolto, `env` vuoto lasciato, la cartella non tolta, un hook scritto,
  la copia 2.x del comando tenuta, un argomento sconosciuto accettato, `env` non oggetto
  accettato, nessun avviso del marketplace, gli `hooks` vuoti dell'utente tolti, la copia non
  scambiata); il manifest con `HOOK_SPECS` di nuovo; `test:mod` muto o in errore senza `claude`;
  8 sui riferimenti (un percorso, un verbo di `/pf`, un'ancora, un verbo per l'utente nel pack it,
  la suite allo strumento nei prompt, una variabile, un agente, un verbo del CLI). La copia
  ripristinata, con il suo `.git`: suite intera 503/503 e `claude plugin test` verdi.
- **Un test dipendeva da dove gira.** Sulla copia la suite intera dava 502/503: il test di
  `restore.mjs` voleva `findClaudeProcess` nullo da un processo figlio del test, ma lanciata dentro
  una sessione di Claude Code la suite ha un Claude Code vero sopra di sé, e da una copia (meno
  livelli fra lui e il test che con `npm`) la ricerca, che sale di 12 livelli, lo raggiungeva. Era
  così anche in HEAD. Ora il test chiede ciò che intendeva: mai il processo di partenza né un
  `node` qualunque, e se qualcosa, il Claude Code sopra il test stesso. Verde sulla copia e nel
  repository.
- Repository pulito: nessun `.perseveranza`, copia delle mutazioni, `tsconfig.json`,
  `.claude-plugin/types` o vecchia cartella di stato; nessun TODO, `.skip` o `.only` nei file
  toccati (i due `skip` per piattaforma di `state-crash.test.mjs`, solo fuori da Windows, sono di
  prima); tutti LF.

### Limiti

- La prova reale di `install.mjs` usa un token d'accesso passato per ambiente al solo processo
  figlio: una home vuota non ha credenziali. Il caricamento della mod non dipende da questo.
- `install.mjs` legge e scrive `settings.json` come JSON stretto: un file con commenti (JSONC) è
  rifiutato, senza toccarlo, con il messaggio che lo dice.
- La copia di sicurezza è una sola (`settings.json.bak-perseveranza`): è lo stato prima del
  primo cambiamento e non si sovrascrive più (correzioni dopo la verifica finale). Un
  `settings.json` cambiato a mano dopo non ha una sua copia.
- `claude -p --setting-sources project` non legge le impostazioni utente: lì la mod
  dell'installazione manuale (e del marketplace) non si carica; serve `--plugin-dir`.

### Correzioni dopo la verifica finale (manual-final1: 1 critico, 10 avvisi)

- **Critico: l'installatore cancellava una cartella che non era sua.** `install.mjs` e
  `--uninstall` toglievano `<claude>/perseveranza` ricorsivamente, qualunque cosa contenesse:
  un checkout git con lavoro non salvato spariva. Ora `inspectInstall` guarda la cartella prima
  di toccare qualunque cosa:
  - è nostra solo con il marcatore `.perseveranza-install.json` (`plugin`, `version`,
    `installedAt`, `files`: percorso, dimensione e sha256 di ogni file copiato). Il marcatore si
    scrive per primo nella copia in preparazione, con un rename;
  - un'installazione 2.x, che non ha il marcatore, è nostra solo se contiene soltanto file che
    i manifest 2.x copiavano (`LEGACY_INSTALL_FILES`), più quelli che Claude Code genera
    (`.claude-plugin/types/`, il `tsconfig.json` che li estende);
  - viene rifiutata, senza toccare nulla e spiegando come procedere, una cartella che è un
    link o una junction, che non è una cartella, che è il checkout da cui gira l'installatore
    (stesso realpath), che contiene `.git`, che non si legge, che ha un marcatore corrotto (anche
    un percorso che esce dalla cartella) o che, senza marcatore, contiene altro;
  - l'installazione rifiuta anche i file non suoi o cambiati da allora (dimensione o hash).
    `--uninstall` toglie solo i file del marcatore ancora intatti, poi le cartelle rimaste
    vuote, poi la cartella se è vuota; i file dell'utente restano e lo dice.

  Test: un repo git con lavoro non salvato al posto dell'installazione (installare e
  disinstallare non cambiano un byte), il checkout dell'installatore lì (anche senza `.git`),
  una junction, una cartella qualsiasi, un marcatore corrotto e uno con `../`, file dell'utente
  dentro (un file nuovo, uno dei nostri cambiato con la stessa dimensione, un `tsconfig.json`
  suo), un'installazione 2.x senza marcatore. F7 è ucciso.
- **W1, reinstallazione interrotta.** La copia nuova si prepara in `perseveranza.tmp-<ts>-<pid>`
  e si verifica file per file contro il marcatore (`buildStaging`). La vecchia va in
  `perseveranza.old-<ts>-<pid>`, la nuova entra al suo posto; se il secondo rename fallisce la
  vecchia torna (`swapIn`). `settings.json` si scrive solo dopo; la vecchia copia si toglie per
  ultima. Il marcatore si cancella per ultimo, così una rimozione interrotta resta
  riconoscibile. Un'esecuzione successiva (`recoverLeftovers`) rimette al suo posto una vecchia
  copia completa quando manca l'installazione, toglie gli avanzi riconosciuti e il temporaneo
  di `settings.json`, e lascia stare con un messaggio ciò che non riconosce. Prova: 150 kill
  della sola installazione e 150 alternati con la disinstallazione, nessun `settings.json`
  rotto e nessuna installazione parziale. L'installazione può mancare solo fra i due rename;
  l'esecuzione finale ripara tutto e non lascia avanzi.
- **W2, permessi.** `writeAtomic` crea il temporaneo con il modo del file e lo ripete con
  `chmod` prima del rename. Prova in Docker (`node:22-alpine`): 600 resta 600 dopo
  l'installazione e dopo la disinstallazione, e la copia di sicurezza è 600. Il test della
  suite usa uno stub dell'fs per controllare l'ordine (scrittura con il modo, `chmod`, rename).
  Limite: su Windows `chmod` tocca solo l'attributo di sola lettura, e lì la prova è lo stub.
- **W3, `settings.json` link simbolico.** Si legge e si scrive il file a cui punta, il link
  resta. Un link a un file che non esiste è rifiutato. Questo l'ha trovato il mutante N32:
  prima `realpathSync` falliva e la scrittura sostituiva il link con un file.
- **W4, hook legacy esatti.** `LEGACY_SETTINGS_HOOK_SCRIPTS` (relativi a `<claude>`) e
  `LEGACY_PLUGIN_HOOK_SCRIPTS` (`${CLAUDE_PLUGIN_ROOT}/...`) al posto della regex. Un hook è
  nostro solo se il suo comando è un interprete (`node`, `pwsh`, `powershell`, `bash`, `sh`),
  eventuali flag, e come ultima parola uno di quegli script con il percorso esatto. Restano
  `node ~/projects/acme/scripts/loop-drive.mjs --my-own`, `notify-loop-drive.mjs.sh`,
  `my-perseveranza/src/shell/stop.mjs`, lo script con argomenti dopo, un `.bak`, un wrapper
  dell'utente che riceve il nostro script come argomento.
- **W5, copia di sicurezza e BOM.** La copia si fa solo se non esiste: è l'originale
  dell'utente e non si sovrascrive più. Il BOM UTF-8 si accetta e si rimette. Il README lo dice.
- **W6, mutanti.** F3 (le voci della lista non ripulite dagli spazi), F5 (ogni agente con il
  nostro nome tolto: ora solo se nomina la cartella di stato), F6 (un comando con
  `${CLAUDE_PLUGIN_ROOT}` tolto, anche quando nomina il percorso dell'installazione) e F10
  (`--uninstall` senza gli avanzi 1.x/2.x) hanno un test che li uccide. `buildStaging` e
  `swapIn` sono esportati per provare la verifica della copia e il ritorno della vecchia.
- **W7, token persi sotto stress.** Lo stress del verificatore (`p1k/stress3.mjs`: Stop, flush e
  verbi sovrapposti in processi veri, il preload che rifiuta letture e rename e aggiunge pause)
  con 6 loop di CPU in parallelo ha dato 2 giri sbagliati su 171: 7 e 14 token persi su 4563,
  mai uno in più. Per la causa ho tracciato ogni scrittura di `state.json` e ogni file della
  casella. Al doppio del carico, un giro ha perso 1607 token. La traccia mostra un rename di
  `state.json` cominciato 115 µs dopo quello di un altro Stop e finito 1,6 s dopo: il processo è
  rimasto fermo fra il controllo di `expect` e il rename. In quel tempo altri due Stop avevano
  salvato (rev 7 e 8) e cancellato i file contati lì. Il rename ha rimesso la rev 6, e i suoi
  token erano già persi.

  È la finestra senza lock già documentata, ma non è "un istante": dura quanto lo scrittore
  resta fuori dalla CPU. L'errore va solo per difetto; un file non si conta mai due volte. Lo
  stato torna a quello dello scrittore in ritardo, contatori compresi. Era sbagliato il testo
  che diceva "un conteggio in più, mai un token perso": ora `state-file.mjs`, `stop-core.mjs`,
  i limiti del CHANGELOG e i "Limiti noti" dei README dicono la direzione giusta e la durata.
  Il test `overlap, the documented residual window` fissa la sequenza dei tre scrittori (il
  200 contato e cancellato si perde). Chiuderla richiede un lock, che il repo non ha per
  scelta: Claude Code non sovrappone gli Stop di una sessione.
- **W8, test fragili sotto carico.** Le cause trovate eseguendo più suite insieme con i loop di
  CPU:
  - il verdetto scritto da un timer accanto al ponte arrivava prima che il ponte cominciasse
    ad aspettare: lo Stop lo leggeva senza attendere. Ora un preload
    (`test/helpers/land-during-wait.mjs`) scrive il verdetto, o il ritorno del subagent,
    dentro l'attesa, al suo terzo controllo;
  - limiti superiori sul tempo totale, che conta anche l'avvio di `node`: ora contano le durate
    che il ponte misura e scrive nel journal;
  - il test del watchdog unico: quello da un secondo poteva uscire prima dello Stop, o non
    essere ancora uscito dopo 300 ms. Ora si aspetta il fatto (`alive(pid)`), e l'incumbente
    vivo è un processo che dura più dello Stop;
  - figli `node` (`arm`, l'hook di Stop, il ponte) finiti con codice 1 senza scrivere un byte:
    gli script di perseveranza dicono sempre perché falliscono, quindi lì `node` non ha
    raggiunto il nostro codice. `runNode` (helper dei test) li rilancia, al più due volte, solo
    in quel caso. Una diagnostica per processo (un preload che registra avvio e uscita) non li
    ha più visti nelle esecuzioni successive: la causa non è identificata.
  - restano fragili, solo con più suite in parallelo (non con una suite e 6 loop), i due test
    del ripristino. `processInfo` interroga PowerShell con un timeout di 10 s, e oltre quel
    tempo il ripristino si rifiuta (fail closed).
- **W9, cartelle temporanee.** `install.test.mjs` (le home, le copie del checkout),
  `shell.test.mjs` (`prs-unit-`, `prs-cfg-`) e `packaging.test.mjs` (`prs-h-`) tolgono le loro
  cartelle. Dopo una suite intera in `%TEMP%` non resta nessuna `prs-*` nuova. Ho tolto le 971
  `prs-install-*` e le 33 `prs-nopath-*` rimaste; le altre `prs-*` vecchie (circa 8800, da
  esecuzioni passate) le ho lasciate, come da istruzioni.
- **W10, README "Limiti noti"** (it/en): la finestra senza lock dello stato, con la direzione e
  la durata, e l'azzeramento di `askedTimes` a un reload.
- `tsconfig.json` e `.claude-plugin/types/` non sono nel repository e `.gitignore` li copre.

#### Prove delle correzioni

- `npm test`: 517 test, 0 skip, 0 fail, tre volte sul codice finale: 186 s da sola, 331 s e
  800 s con 6 loop di CPU in parallelo. Dopo una suite in `%TEMP%` non resta nessuna `prs-*`
  nuova.
- `claude plugin validate --strict` (manifest e radice): pulito. `claude plugin test`: 197
  verdi. `npm run test:mod` intero: verde (e2e reale in 163 s). Prima di questo, un
  `claude -p "ok"` con la rete aveva aggiornato l'interruttore remoto salvato ("rollout switch
  saved off").
- **Installazione reale** in una home temporanea (`HOME`/`USERPROFILE` puntati lì, token solo
  nell'ambiente del figlio). `settings.json` aveva un'altra variabile e un hook `Stop` della
  2.x: l'hook è stato tolto, la voce aggiunta e la copia di sicurezza fatta. `/pf help`,
  `/pf status`, `/pf arm` e `/pf disarm` hanno risposto; le chiamate allo strumento le prova
  l'e2e di `test:mod`.
  Una volta `/pf arm` ha avuto da Claude Code "Command 'node' not found or is in an unsafe
  location" con la macchina sotto il carico di tre suite; ripetuto, è andato. Dopo
  `--uninstall` resta `{"env":{"MY_VAR":"1"}}` e `/pf` non esiste più. Gli hash di
  `settings.json` e `.credentials.json` reali sono gli stessi prima e dopo, e nessun token è
  finito in un file.
- **Kill dell'installatore**: `fv/kill.mjs` (60, alternati con `--uninstall`) e
  `fv/kill2.mjs` (150, sola installazione): JSON rotti 0, installazioni parziali 0. Il
  classificatore con 150 kill e 150 alternati: 0 rotti, 0 parziali, nessuna installazione che
  manca mentre `settings.json` la nomina. L'esecuzione finale lascia l'installazione completa
  e nessun avanzo.
- **Mutazioni** su una copia con `.git`: 39 su `install.mjs` e `legacy.mjs`, tutte uccise
  (F3, F5, F6, F7, F10 del verificatore e 34 nuove: rifiuti, marcatore, copia verificata,
  ordine di scrittura, ripristino, permessi, link, BOM, hook esatti, avanzi). La copia
  ripristinata è verde con la suite intera (517).
- **Docker** (`node:22-alpine`): `settings.json` a 600 resta 600 dopo installazione e
  disinstallazione. Un link a un file 640 resta un link, e il file resta 640 e viene scritto.

### Correzioni dopo la verifica dell'installatore (manual-inst1: 4 critici, 5 avvisi)

Causa comune dei quattro critici: la pulizia dei residui 1.x/2.x riconosceva i file per nome o
per un contenuto approssimato. Il principio applicato ovunque in `install.mjs`: **si cancella
solo** (a) ciò che il marcatore elenca ed è ancora intatto (più i file che Claude Code genera,
dentro una cartella riconosciuta), (b) un file vecchio il cui sha256 è esattamente quello di un
file che una release passata ha copiato lì, (c) un avanzo di una nostra esecuzione interrotta,
riconosciuto dalla sentinella. Tutto il resto si segnala ("Left alone ... remove it yourself").

- **La tabella delle impronte** (`src/shell/legacy-hashes.mjs`, 68 percorsi, 566 impronte di
  file e 42 di comandi) la genera `scripts/legacy-hashes.mjs` dalla storia git: per ogni commit
  legge il suo installatore (`install.ps1`, poi `install.mjs` 1.x e 2.x), ricava quali file
  copiava e dove (i `Copy-Item`, i `copyFileSync`, la lista `AGENTS`, i `RUNTIME_FILES` e
  `PLUGIN_FILES` del manifest di quel commit) e in che forma scriveva il comando (`verbatim`,
  `v1-cli` con il percorso del CLI 1.x, `v2-root` con la cartella 2.x). Ogni testo si conta con
  i fine riga del commit e con gli altri (un checkout Windows senza `.gitattributes` scriveva
  CRLF). Il comando si riconosce rimettendo il segnaposto al posto del percorso di questa
  cartella di configurazione e confrontando l'impronta. Gli installatori della 3.0 (che hanno
  il marcatore) si saltano. `test/packaging/legacy-hashes.test.mjs` la ricalcola da git e
  vuole uguaglianza esatta; senza la storia completa fallisce dicendo perché (niente skip): la
  CI ora clona con `fetch-depth: 0`. `legacy.mjs` la riesporta; `LEGACY_V1_HOOK_FILES` e
  `LEGACY_INSTALL_FILES` (i nomi) non ci sono più.
- **C1, file in `<claude>/hooks/` cancellati per nome.** Ora si cancella un file di `hooks/` o
  `agents/` solo se la sua impronta è nella tabella sotto quel percorso; un file con lo stesso
  nome e un altro contenuto resta ed è elencato. Test: un file dell'utente sotto ogni nome della
  tabella resta, byte per byte, con installazione e disinstallazione, ed è nominato.
- **C2, agenti 3.0 personalizzati presi per copie 2.x.** `isOldAgent` (che guardava il nome e
  la menzione della cartella di stato, compresa `.perseveranza/`) non c'è più: un agente è una
  copia vecchia solo per impronta. Il test che lo voleva vero ora vuole il contrario: un agente
  dell'utente che scrive in `.perseveranza/` resta.
- **C3, cartelle `perseveranza.old-*`/`.tmp-*` dell'utente cancellate.** Le cartelle che una
  esecuzione crea si chiamano `perseveranza.<tmp|old>-<ms>-<pid>-<nonce di 16 esadecimali>` e
  la prima cosa scritta dentro è `.perseveranza-staging.json` con gli stessi tipo, ora, pid e
  nonce. Una cartella è un nostro avanzo solo se nome e sentinella coincidono e quel processo
  non è vivo (`leftoverOf`). Nella copia in preparazione si scrive sentinella, marcatore, file;
  nella vecchia la sentinella si scrive subito prima del rename. Per il ripristino si prende la
  vecchia copia più recente, solo se completa (ogni file del marcatore intatto) o una 2.x
  riconosciuta; le altre perdono solo ciò che il marcatore elenca (in una `.tmp` anche i file
  scritti a metà; in una `.old` solo quelli intatti). Il temporaneo di `settings.json` si
  chiama `<file>.tmp-perseveranza-<pid>-<nonce>` e si toglie solo se è di quel file e il pid
  è morto. Le prove di kill e di errori iniettati (sotto) hanno mostrato tre buchi, chiusi:
  `removeInstall` toglieva la sentinella fra i primi file (ora prima i file, poi le cartelle
  vuote, poi il marcatore, poi la sentinella); se un file non si toglie, marcatore e sentinella
  restano e l'esecuzione successiva finisce il lavoro (`--uninstall` esce con 1 e lo dice); la
  sentinella si toglie solo dopo il marcatore. Una cartella col nome giusto, il pid morto e
  nessun file dentro (uccisa fra `mkdir` e la sentinella, o mentre toglieva le cartelle vuote)
  si rimuove: non contiene niente da perdere. Test: una copia dell'utente con dentro un'installazione e il suo marcatore
  (`.old-mybackup`), una `.tmp-notes`, una cartella dal nome giusto senza sentinella, una con
  il processo vivo, una con sentinella e nome diversi, un `notes.txt.tmp-perseveranza-…`:
  restano tutte, byte per byte.
- **C4, reinstallare dopo `--uninstall` cancellava un file modificato.** Una cartella senza
  marcatore si sostituisce o si toglie solo se ogni file (tolti quelli generati da Claude Code
  e la sentinella) è una copia esatta di un file di una release: della tabella
  (`perseveranza/<rel>`) o di questo checkout. Altrimenti si rifiuta, con l'elenco dei file.
  Una cartella con soli file generati e nessun file di una release si rifiuta anche lei. Alla
  rimozione ogni file si ricontrolla. Test dedicato: modificare un agente installato,
  disinstallare, reinstallare e disinstallare di nuovo: rifiutati, la cartella byte per byte.
- **W1, nessun lucchetto.** `acquireLock`: `mkdir` non ricorsivo di
  `<claude>/.perseveranza-install.lock` con `owner.json` (pid, host, ora, nonce), rilasciato
  nel `finally` solo se il nonce è ancora il nostro. Un lucchetto tenuto si aspetta fino a
  10 s, poi l'errore spiega cosa fare. **Deviazione** dalla regola "stale solo se pid morto e
  più vecchio di N minuti": il pid morto (sulla stessa macchina) basta, perché un
  installatore ucciso deve poter essere seguito subito da quello che ripara (le prove di kill
  lo fanno a ogni passo); l'età serve per il caso opposto, un pid vivo ma riusato: oltre
  5 minuti il lucchetto è vecchio comunque. Un lucchetto senza `owner.json` (ucciso fra i due
  passi) è vecchio dopo 3 s; uno di un altro host si aspetta. Il furto rinomina il lucchetto
  con un nome unico e lo cancella solo se è ancora quello visto vecchio, altrimenti lo rimette.
  Il controllo "dentro il checkout" avviene prima di creare la cartella di configurazione e il
  lucchetto. Test: due installatori veri lanciati insieme mentre il test tiene il lucchetto
  (nessuno fa niente finché lo tiene, poi uno copia e l'altro trova tutto uguale), un processo
  ucciso col lucchetto (il successivo non aspetta), e i casi unitari.
- **W2, percorsi non provati.** Le installazioni vecchie nei test non sono più finte: le
  ricostruiscono i loro installatori letti da git (`planOf` del generatore) per `6d83420`
  (`install.ps1`), `69f3d61`, `f9c3a6e` (1.x) e `a263a0c` (2.x, con il CLI col vecchio nome),
  con LF e CRLF, sia per l'installazione sia per `--uninstall`. I sopravvissuti del verificatore
  hanno ognuno un test: V24 e V23 (`recoverLeftovers` unitario: la più recente completa, mai
  una con un file mancante), V32/V33 (2.x vera installata e disinstallata), V13/V14 (le forme
  vere del comando), V15 (CRLF), V19 (marcatore di un altro plugin), V21 (ordine delle
  cancellazioni registrato: il marcatore per ultimo), V30 (`--claude-dir` con
  `CLAUDE_CONFIG_DIR` impostata), V31 (`loop-drive.ps1` dalla `6d83420`).
- **W3, `settings.json` riformattato.** `settingsFormat` rileva rientro (la prima riga
  rientrata: spazi o tab; una riga sola resta una riga; vuoto o `{}` due spazi), fine riga e
  newline finale; `renderSettings` li rimette. Installare e disinstallare restituiscono gli
  stessi byte. `jsonHazards` trova chiavi ripetute nello stesso oggetto (confrontate come le
  legge JSON) e numeri che JavaScript non tiene esatti (interi oltre 2^53, non finiti); se una
  scrittura è dovuta il file si rifiuta senza toccarlo. I decimali restano alla precisione
  double, come li legge Claude Code.
- **W4, copia di sicurezza.** `backupOnce`: `lstat` del nome (qualunque cosa ci sia, anche un
  link rotto, non si scrive), poi scrittura `wx` con il modo del file, dai byte originali. Il
  marcatore registra `settings: 'created' | 'existed'` (portato avanti dalle reinstallazioni):
  se l'aveva creato l'installazione non si fa nessuna copia, e `--uninstall` cancella il file
  quando resta `{}`.
- **W5, reinstallazione identica.** Con marcatore, origine di `settings.json` e ogni file
  uguali alla sorgente (e nient'altro nella cartella) non si copia nulla: "Already installed
  and identical". Il test confronta impronta e mtime di ogni file.

#### Prove delle correzioni (manual-inst1)

- `npm test`: 528 test, 0 skip, 0 fail, tre volte sul codice finale: 178 s e 175 s da sola,
  405 s con 6 loop di CPU e i kill dell'installatore in parallelo. `%TEMP%` aveva 4298 `prs-*`
  prima e 4298 dopo ogni esecuzione (anche di `install.test.mjs` da solo).
- `claude plugin validate --strict` (manifest e radice): pulito. `claude plugin test`: 197
  verdi.
- **Installazione reale** in una home temporanea (token solo nell'ambiente del figlio): l'hook
  `Stop` 2.x tolto, la voce aggiunta, la copia di sicurezza fatta; `/pf help`, `/pf status`,
  `/pf arm`, `/pf disarm` hanno risposto; dopo `--uninstall` resta `{"env": {"MY_VAR": "1"}}`
  con il suo rientro e `/pf` non esiste più. Le impronte di `settings.json` e
  `.credentials.json` reali sono uguali prima e dopo; nessun token in un file.
- **Kill e errori iniettati** (`vi1/k/kt2.mjs`, il `kt.mjs` del verificatore con la migrazione
  da una 2.x vera e i file dell'utente con i nomi vecchi): un kill o un errore (EPERM, ENOSPC)
  a ogni operazione del file system di installazione (177), reinstallazione (10, identica),
  disinstallazione (110) e migrazione dalla 2.x (249). Nessuno stato rotto, nessun file
  dell'utente toccato, e dopo una nuova esecuzione nessun avanzo (né cartelle né lucchetto).
  Gli unici fallimenti senza "ERROR" sono i primi 4 errori iniettati, che colpiscono il
  caricamento dei moduli di Node prima che giri una riga dell'installatore (nulla cambiato).
  Anche `kt.mjs` del verificatore (installazione, reinstallazione, disinstallazione): pulito.
  `fv/kill.mjs` e `fv/kill2.mjs` (kill a tempo casuale, 60 e 150): JSON rotti 0, cartelle
  parziali 0, e l'esecuzione finale toglie ogni avanzo. `par3.mjs` (installatori concorrenti):
  nessuna riproduzione.
- **Mutazioni** su una copia con `.git` (`mut3/mut.mjs`): 101 su `install.mjs`, `legacy.mjs`,
  la tabella e il generatore, compresi i 36 del verificatore adattati al codice nuovo; 98
  uccise. Le 3 sopravvissute sono equivalenti: V2 (`resolve` toglie già il separatore finale),
  N28b (senza `wx` resta il controllo `lstat` subito prima: cambia solo in una corsa fra i
  due), G5 (nessun installatore 3.0 è nella storia, e il suo testo non somiglia a nessun
  installatore vecchio: la regola è una guardia per i commit futuri). La prima esecuzione ne
  ha lasciate vive altre due, V18 (marcatore con l'elenco vuoto) e N49 (copia vecchia con un
  file dell'utente rimessa al suo posto): ora hanno il loro test.

### Correzioni dopo la seconda verifica dell'installatore (manual-inst2: 0 critici, 8 avvisi)

- **W1 e W2, `settings.json` riscritto.** Ora si modifica come testo (`patchSettings`):
  `jsonSpans` ricava dal testo (già accettato da `JSON.parse`) le posizioni di ogni membro e
  elemento; si sostituisce il valore della voce, si aggiunge un membro dopo l'ultimo tenuto
  (con lo spazio prima del primo membro e lo spazio intorno ai suoi due punti), si tolgono
  membri ed elementi con i separatori giusti (una serie tolta prima di uno tenuto si taglia fino
  a quello; una serie in fondo si taglia dalla fine di quello tenuto prima). Sulle chiavi
  ripetute si modifica l'ultima, quella che legge `JSON.parse`. Il risultato si rilegge e deve
  essere, a chiavi ordinate, esattamente l'oggetto atteso; altrimenti si rifiuta senza toccare
  niente. Così numeri (`1e20`, `-0`, `1.0`, `1E5`, decimali lunghi), array in linea, spazi,
  escape e chiavi ripetute restano byte per byte, e `jsonHazards` non serve più: un file che
  l'installatore ha scritto si disinstalla sempre. Restano diversi, e i README lo dicono: la
  voce aggiunta segue i membri accanto; il valore di `CLAUDE_CODE_PLUGIN_DIRS` quando cambia è
  JSON standard; un file vuoto diventa `{}` e un `"env": {}` vuoto già presente sparisce. Le
  altre voci della lista restano come scritte (spazi compresi): si aggiunge in coda al testo e
  si tolgono solo i pezzi che sono la nostra cartella. La copia di sicurezza della 3.0 si chiama
  `settings.json.bak-perseveranza-3.0`, così chi viene dalla 2.x (che ha già il suo
  `.bak-perseveranza`) ha la copia di prima della 3.0. Test: i casi di `vi2/rt.mjs` (e altri)
  fanno installazione e disinstallazione con gli stessi byte e la copia identica; il testo
  esatto dopo la rimozione di hook in linea; il rifiuto di una chiave da togliere scritta due
  volte.
- **W3, la stessa cartella scritta in due modi.** `samePlace` confronta anche i percorsi reali
  (`realpathSync.native`, senza distinzione di maiuscole su Windows): junction, nome 8.3,
  `subst`. Test con una junction e con il nome 8.3 (ricavato con `for %I ... %~sI`; il volume
  di prova li ha); `--uninstall` toglie tutte le grafie.
- **W4, hook di uno script modificato.** `legacyHookPlan` toglie un hook 1.x/2.x solo se lo
  script che esegue non c'è più, è identico a una release, o è un file intatto
  dell'installazione riconosciuta (2.x per impronta, nostra per marcatore). Gli altri restano,
  elencati. Test con `hooks/loop-drive.mjs` modificato, con la copia 1.x vera, con la 2.x vera
  e con un file della nostra installazione modificato.
- **W5, cartelle collegate.** In `legacyLeftovers`, se `hooks/`, `agents/` o `commands/` è un
  link o una junction, o il suo percorso reale esce dalla cartella di configurazione, lì non si
  toglie niente e lo si dice. Test con junction e symlink di cartella.
- **W6, lucchetto corrotto.** `readOwner` accetta solo un proprietario valido (pid intero
  positivo, ora finita e non oltre un giorno nel futuro, nonce, file sotto 4 KB); altrimenti il
  lucchetto conta come senza proprietario: si aspetta, il messaggio dice di toglierlo, dopo 3 s
  si riprende. La data nel messaggio non può più lanciare. Test per ora e pid non numerici, ora
  nel futuro, JSON non valido, file vuoto, file enorme.
- **W7, M30 e M31.** Test: un `settings.json` esistente `{}` resta dopo la disinstallazione; un
  `settings.json` cancellato dopo l'installazione rende la reinstallazione non identica (il
  marcatore passa a `created`) e la disinstallazione lo toglie.
- **W8, la tabella dipende dai ref del clone.** `computeLegacyHashes` parte da
  `LEGACY_ANCHORS` (il commit completo di 2.6.0) invece che da `--all`: la tabella generata è
  identica. Un test clona il repository, ci aggiunge un ramo con un agente diverso e verifica
  che la tabella non cambi (e che con `--all` sarebbe cambiata).

#### Prove delle correzioni (manual-inst2)

- `node --test test/packaging/install.test.mjs test/packaging/legacy-hashes.test.mjs`: 43
  verdi; `%TEMP%` aveva 4298 `prs-*` prima e 4298 dopo.
- `npm test`: 537 test, 0 skip, 0 fail, tre volte: 172 s e 178 s da sola, 402 s con 6 loop
  di CPU. 4298 `prs-*` dopo.
- `claude plugin validate --strict` (manifest e radice): pulito. `claude plugin test`: 197
  verdi.
- **Installazione reale** in una home temporanea (token solo nell'ambiente del figlio):
  `{"env": { "MY_VAR": "1" }}` in linea resta in linea, la voce si aggiunge accanto; l'hook
  `Stop` 2.x tolto; copia `settings.json.bak-perseveranza-3.0`; `/pf help`, `/pf status`,
  `/pf arm`, `/pf disarm` rispondono; dopo `--uninstall` resta `"env": { "MY_VAR": "1" }` come
  era scritto e `/pf` non esiste più. Impronte di `settings.json` e `.credentials.json` reali
  uguali prima e dopo; nessun token in un file.
- **Testo di `settings.json`** (`vi2/rt.mjs`): ogni caso torna identico byte per byte dopo
  installazione e disinstallazione, e la copia è identica all'originale. Le eccezioni sono
  quelle dette: il file vuoto (diventa `{}`) e il file con commenti (rifiutato, non è JSON).
- **Lucchetto** (`vi2/lock.mjs`): proprietario vivo o di un altro host, si aspetta 10 s e poi
  un errore chiaro; morto, vecchio, senza proprietario o con `at` non numerico, si riprende
  (quest'ultimo dopo circa 3 s); un `.stale-*` con un file dell'utente resta.
- **Kill ed errori iniettati**: `vi2/kt.mjs` (16 serie: installazione 172 operazioni,
  reinstallazione 263, disinstallazione 105, migrazione 243; kill, kill dopo, EPERM, ENOSPC)
  nessuno stato rotto, nessun problema finale, nessun fallimento muto. `vi1/k/kt2.mjs`:
  nessuno stato rotto (i 4 fallimenti senza "ERROR" sono ancora il caricatore dei moduli di
  Node). `fv/kill.mjs` 60 e `fv/kill2.mjs` 150: JSON rotti 0, cartelle parziali 0.
- **Mutazioni** su copie con `.git` (`mut4/mut.mjs`): 131, cioè 39 nuove sul codice di
  questo giro più le 92 vecchie che si applicano ancora. 128 uccise. La prima esecuzione ha
  lasciato viva R17 (una cartella senza marcatore il cui script è copia di questo sorgente:
  l'hook restava): ora ha il suo test. Le 3 vive sono le equivalenti già note, V2, N28b e G5.
  Le 42 del verificatore (`vi2/mut.mjs`): M30 e M31 ora uccise; M01–M03 e M34 colpivano
  `jsonHazards`, che non c'è più; M06–M08 adattate al codice nuovo e uccise; viva solo M41,
  che il verificatore stesso dà per equivalente. In tutto 37 uccise su 38 applicabili.

#### Rilascio: la tabella delle impronte

Dalla 3.0 ogni installazione porta il suo marcatore, quindi le release nuove non aggiungono
niente a `src/shell/legacy-hashes.mjs`. Al rilascio: `npm test` (che la confronta con git). Se
mai un installatore tornasse a copiare file fuori dal marcatore, il commit di quella release va
in `LEGACY_ANCHORS` (`scripts/legacy-hashes.mjs`), poi `node scripts/legacy-hashes.mjs --write`
e il commit della tabella rigenerata.

## Correzioni 3.0.1

Cinque punti di una code review statica del diff della 3.0.0 (uno di sicurezza, tre di
affidabilità, la pulizia). Rimandati per decisione presa: il `tool-check` a ogni chiamata, le
costanti duplicate fra mod e shell, l'alias `writeFileResult`.

### 1. `resume` non è più dello strumento (sicurezza)

Il difetto: `resume` era in `TOOL_VERBS` (e in `TOOL_VIA_VERBS` del CLI); era rifiutato solo
`resume --takeover`. Nella sessione proprietaria il modello poteva chiamare `{"verb": "resume"}`
su un loop in pausa per l'approvazione del piano (`--approve-plan`) o per un'escalation dopo
`maxRetries`: `src/cli/verbs/resume.mjs` toglie `signals.paused` e azzera `retries`,
`finalFails`, `staleGates`. Il modello approvava il proprio piano e superava il limite che chiede
un umano, senza prompt dei permessi (in modalità shell la stessa chiamata passava da Bash, sotto i
permessi dell'utente).

Corretto:
- `hooks/lib/verbs.js`: `TOOL_VERBS` senza `resume`, che passa in `USER_VERBS` (con `arm` e
  `disarm`); `validateToolInput` riconosce il verbo senza badare alle maiuscole e rifiuta
  `resume` in ogni forma (il verbo, `"resume now"`, le parole, `RESUME`, accanto a un altro
  verbo come prima parola) con `user: 'resume'`, e come takeover se c'è `--takeover` in qualunque
  posto o il campo `takeover`. Come parole di un altro verbo (`{"verb": "pause", "args":
  "resume"}`) le rifiuta quel verbo. Il rifiuto dice "Ask the user to type /pf resume, and do not
  resume it any other way. Nothing was run.". Schema (l'enum) e descrizione dello strumento non
  lo elencano più e dicono che `/pf resume` è dell'utente.
- Il secondo muro (`src/cli/perseveranza.mjs` `toolViaRefusal`): `TOOL_VIA_VERBS` senza
  `resume`; il rifiuto di `resume` nomina `/pf resume` (o `/pf resume --takeover`); il controllo
  ora viene **prima** di quello del verbo sconosciuto, così da `PERSEVERANZA_VIA=tool` ogni verbo
  fuori lista, anche `RESUME` o uno inventato, esce con 2.
- Le parole per l'utente: `plan-approval` e gli avvisi `session-*` usavano già `{{USER}}`
  (`/pf` in modalità strumento). Le notifiche di approvazione del piano e di chiusura git non
  confermata dicono `/pf resume` per un loop armato per lo strumento (`resumeWord` in
  `machine.mjs`, dallo stato: armato dove gira la mod, l'utente ha `/pf`) e `resume` come prima
  per uno armato dalla shell. Aggiornati anche `ESCALATION.md`, l'uscita di `pause`,
  `commands/perseveranza.md` (non più `{"verb": "resume"}`; dopo un `pause` per chiedere qualcosa
  riprende l'utente), i README (lo strumento e "Sicurezza"), il CHANGELOG.
- `pause` resta allo strumento: il modello che si ferma per chiedere passa la mano all'utente, non
  scavalca niente. `report pass|fail` e `claim-done` restano, documentati nei README ("Sicurezza"):
  `report` registra l'esito di review o verifica finale solo dove il subagent non ha scritto il
  suo file (un file valido decide comunque; con le lenti un `pass` dichiarato non copre nessuna
  lente); `claim-done` è accettato solo con il piano tutto spuntato e, se il loop conosce una
  suite, un suo verde per l'albero corrente, e porta a pulizia e verifica finale, non alla
  chiusura. Nessuno dei due toglie una pausa. **Corretto dopo la verifica** (sezione 6): la prima
  stesura diceva anche "né azzera un contatore", falso: un `pass` della review azzera `retries`
  (`machine.mjs`, `case 'review'`) e così un claim accettato; e un esito mandato durante una pausa
  era usato dopo il resume. Ora i due verbi sono rifiutati su un loop in pausa.

### 2. Il watchdog e uno `state.json` che non si legge per un momento

Il difetto: `decide()` leggeva `state.json` grezzo e rispondeva `exit` per uno stato illeggibile
o solo in `.pending`: un `EBUSY` di Google Drive o di un antivirus, una scrittura in place a metà,
un crash. Il watchdog staccato non tornava fino al prossimo Stop, che una sessione bloccata non
porta: niente ripristino.

Corretto (`src/shell/watchdog.mjs`): `decide()` legge con `loadStateFile(paths, { promote: false,
journal: false })` (i tentativi brevi su un errore transitorio, la copia in sospeso letta e mai
promossa) e distingue:
- cartella segnata disarmata o trattenuta (`DISARMED_MARK`, `RETAINED_STATE`), o stato assente
  senza copia valida: `exit` ("disarmed");
- occupato a ogni tentativo, rotto o vuoto senza copia: `retry`, si riprova dopo
  `UNREADABLE_RETRY_MS` (15 s); `run()` conta i `retry` di fila e al `MAX_UNREADABLE`-esimo (40,
  10 minuti) esce scrivendo nel journal `{"type": "watchdog", "action": "exit", "why": ...}`; il
  conteggio riparte a ogni lettura riuscita;
- solo la copia in sospeso (o lo stato rotto con la copia accanto): letta come stato, così una
  sessione bloccata è sorvegliata anche lì. **Deviazione** dalla richiesta ("riprova al ciclo
  successivo"): riprovare non serve, perché la copia la promuove solo il prossimo Stop o verbo, che
  una sessione bloccata non porta; la copia è l'ultimo stato intero, e `markInterrupted` già non
  scrive su uno stato che sta solo lì. **Questo ha aperto un difetto** trovato dalla verifica
  (sezione 6): con `PERSEVERANZA_RESTORE=1` il ripristino partiva comunque e si ripeteva. Ora uno
  stato letto dalla sola copia è sorvegliato e avvisato, mai ripristinato.

`run()` accetta `decide`, `sleep`, `fs` e il tetto dai test e risponde `{ code, why }`.

### 3. Lo Stop dopo il ritorno del subagent durante l'attesa

Il difetto: in `runStopOnce` solo `w.landed` rieseguiva lo Stop. In `implement` non c'è un file
di verdetto, quindi l'uscita anticipata era sempre `w.returned`, e lo Stop usava il risultato di
prima: "a subagent is still running", una delle 3 attese spesa, uno Stop "quieto" in più.

Corretto (`src/shell/stop-core.mjs`): anche al ritorno lo Stop riparte (`waited: true`, una sola
attesa per Stop), con `facts.backgroundTasks` in cui `settleReturned` segna `completed` i task del
ruolo tornati: quanti di quelli `running` il record del ritorno (`activity.pending`) non elenca
ancora in sospeso, almeno uno. `waitForSubagent` restituisce il record (`activity`). In
`implement` lo Stop va in review; in review o nella verifica finale senza verdetto chiede l'esito
(`missing`); con il verdetto arrivato lo legge come prima. Il tetto (30 s, 3 attese per
richiesta) e l'uscita per tempo scaduto non cambiano.

Un test esistente era sbagliato: in `test/e2e/mod-bridge.test.mjs` il ritorno del revisore senza
verdetto durante l'attesa si aspettava `subagent-running`, cioè fissava il difetto. Ora vuole
`missing` e nessuna attesa in più.

### 4. Una sola lista delle cartelle del loop

`workTreeFingerprint` escludeva solo `.perseveranza`, `underLoop()` e `gitFinish()` anche la
cartella della 2.x: in un progetto migrato con quella cartella non ignorata e ancora scritta (un
watchdog 2.x rimasto), il suo journal entrava nell'impronta e il verde registrato cadeva come
"codice cambiato". Ora `LOOP_DIRS` (esportata da `src/shell/git.mjs`) vale per tutti e tre.

### 5. Pulizia

Tolti l'import `mergeModUsage` in `stop-core.mjs` e il doppio import da `../core/subagents.mjs` in
`mod-bridge.mjs`. Una scansione dei file toccati (import non usati, export che nessun file del
repository usa) ha trovato in più solo `isGitRepo` in `git.mjs`, esportata e mai usata: tolta.

### 6. Dopo la verifica manual-301

La verifica indipendente del primo giro ha dato `pass: false`: un difetto critico, due avvisi.

**Critico: il watchdog ripristinava più volte uno stato che c'era solo in `.pending`**
(`PERSEVERANZA_RESTORE=1`). `decide()` (sezione 2) leggeva la copia in sospeso; `markInterrupted`
non scrive su quella copia (`updateState` con `promote: false`), quindi `signals.interrupted` non
veniva impostato; la guardia contro un secondo `claude -r` stava solo in quel campo; il watchdog
sostitutivo, avviato dopo il lancio, ripristinava di nuovo: 3 `claude -r sess-H` in circa 2 s
nella riproduzione del verificatore (`vwd-restore.mjs pending`). Corretto in
`src/shell/watchdog.mjs`:
- `decide()` restituisce `restorable: false` quando lo stato viene dalla sola copia. `run()`
  avvisa una volta (journal e notifica: "No restore: state.json stands only in its pending copy
  ..."), poi continua a vegliare ogni `UNREADABLE_RETRY_MS` senza ripetere l'avviso: niente
  `restore()`, niente scrittura. Quando uno Stop o un verbo riscrive lo stato intero, la veglia
  prosegue come sempre. `restore()` rifiuta a sua volta `restorable === false` (due controlli).
- `restore()` scrive **prima** di terminare o lanciare: l'interruzione in `state.json`
  (`markInterrupted`; se non riesce, nessun ripristino) e la sentinella
  `.perseveranza/restore-launched.json` (`{ at, session, by }`; se non riesce, nessun
  ripristino). Un kill o un lancio falliti annullano entrambe (`clearInterrupted` toglie solo
  l'interruzione con lo stesso `at`). **Cambiato nel terzo giro** (sezione 7): la sentinella è
  creata in esclusiva, prima dell'interruzione, e porta nonce e fase.
- La guardia contro il secondo ripristino legge il più recente fra `interrupted.at` e la
  sentinella (`restoreLaunchedAt`): basta una delle due. Una sentinella illeggibile vale come
  lancio (si chiude, non si apre; nel terzo giro anche `null`, un `at` non valido, e con una
  scadenza: sezione 7); quella di un'altra sessione non conta. Il lancio vale anche
  come segno di vita in `decide()`, come già `interrupted.at`.
- `dropRestoreSentinel`, chiamata alla fine di ogni Stop (`runStopOnce`), toglie la sentinella
  quando `owner.lastFireAt` è dopo il lancio (la sessione ripristinata è ripartita e il suo
  processo è registrato) o quando è di un'altra sessione; `cleanStateResidues` (all'`arm`) toglie
  quella di un run vecchio.

Un test esistente (`hook.test.mjs`, il ripristino con processi veri) simulava "la sessione
ripristinata è arrivata a uno Stop" togliendo solo `interrupted`: ora toglie anche la
sentinella, come fa uno Stop vero.

**Avviso 1: `report`/`claim-done` durante una pausa.** Un `report pass` mandato dallo strumento
mentre il loop aspettava una persona restava in `signals.lastReport`; il primo Stop dopo il
`/pf resume` lo usava (la review passava senza essere rifatta). E il testo dei README, del
CHANGELOG e di questo piano diceva "nessuno dei due ... azzera un contatore", falso: un `pass`
della review e un claim accettato azzerano `retries`. Scelta la via più piccola che non tocca la
macchina: `changeOutcome` in `src/cli/shared.mjs`, usata da `report` e `claim-done`, controlla
`signals.paused` sullo stato letto da `updateState` al momento della scrittura (non su una
lettura precedente) e, se è in pausa, non scrive e lancia un `VerbError` (uscita 1):
"perseveranza is PAUSED: <verb> not recorded. ... the user resumes it with /pf resume ... Nothing
was changed.". Vale da ogni via (strumento, shell, `/pf` non li ha). `resume` non scarta niente:
dopo questa correzione un esito non può entrare durante una pausa, e uno registrato prima della
pausa era già lì prima anche nella 2.x. Un test esistente (`state-file.test.mjs`, i verbi durante
uno Stop lento) usava un loop in pausa come veicolo: ora scrive gli stessi campi con
`updateState`, come i verbi. **Nel terzo giro** (sezione 7) il controllo ha mostrato due corse
aperte, ora chiuse, e quel test è diventato due: loop in corsa (gli esiti si uniscono) e loop in
pausa (gli esiti si scartano).

**Avviso 2: una lacuna di test.** Togliere `a.at >= start` in `waitForSubagent` non rompeva
nessun test. Aggiunti: in `test/unit/mod.test.mjs` un ritorno registrato prima dell'inizio
dell'attesa (tutto il budget, niente ritorno) e uno nello stesso millisecondo (conta); in
`test/e2e/subagent-wait.test.mjs` uno Stop in `implement` con il ritorno dell'esecutore
precedente già su disco: tutta la finestra di 30 s, poi `subagent-running`.

### 7. Dopo la verifica manual-302

Nessun critico; cinque avvisi riprodotti e 11 mutanti sopravvissuti (`scratchpad/v302/`).

**1. Un esito durante lo Stop che mette in pausa.** Il verbo leggeva `paused: false` (lo Stop
che escala non aveva ancora salvato) e scriveva; il merge prima del salvataggio
(`mergeVerbFields`: `lastReport` e `claimedDone` sono campi dei verbi) lo riportava nello stato
in pausa; dopo `/pf resume` la review passava (`verdictSrc: 'verb'`). Corretto in
`src/shell/stop-core.mjs` (`reconcile`): quando lo stato unito è in pausa, gli esiti
(`OUTCOME_FIELDS`: `lastReport`, `claimedDone`) presi dal disco tornano ai valori dello Stop, gli
altri campi dei verbi si uniscono come prima, e il journal scrive `outcome-dropped-paused`
(`fields`, `values`, `by: 'stop'`). La regola guarda lo stato **risultante**: copre lo Stop che
mette in pausa e un `pause` arrivato durante lo Stop. Test: nel processo (`state-file.test.mjs`,
il loop in pausa con gli esiti scritti alla seconda lettura dello Stop) e con processi veri
(`mod-tool.test.mjs`: un precaricamento, `test/helpers/verb-on-read.mjs`, lancia `report pass` o
`claim-done` dallo strumento alla 2a e 3a lettura di `state.json` dello Stop che escala: il verbo
esce 0, lo stato in pausa ha `lastReport: 'none'` e `claimedDone: false`, e dopo `/pf resume` il
primo Stop non passa la review).

**2. Il verbo che diceva "Nothing was changed" con l'esito su disco.** `updateState`, se un altro
scrittore riscrive dopo il suo rename, riapplica la closure allo stato di quello (per vedere se
la modifica c'è): con un `pause` arrivato lì la closure impostava il flag "in pausa" e il verbo
rifiutava, mentre lo stato aveva `paused: true` con `lastReport: 'pass'`. Corretto in
`changeOutcome` (`src/cli/shared.mjs`, ora `(paths, verb, field, value)`): il controllo è dentro
la closure su ogni esecuzione e la risposta si decide sul risultato di `updateState`:
`unchanged` vuol dire rifiutato senza scrivere ("Nothing was changed."); scritto ma lo stato
risultante è in pausa (il `pause` ha tenuto la scrittura) vuol dire che l'esito si ritira, se
è ancora quello del verbo, con un'altra `updateState` che rimette il valore di prima,
`outcome-dropped-paused` nel journal (`by` = il verbo) e il rifiuto "The loop was paused while it
was being written, and it was taken back"; se il ritiro non riesce il verbo dice che l'esito
**è** registrato. Test con processi veri (`mod-tool.test.mjs`): un `pause` alla 1a, 2a, 3a, 4a
lettura del verbo; l'uscita 0 se e solo se l'esito è su disco, e le tre risposte (rifiutato,
ritirato, registrato) compaiono tutte.

**3. Due ripristini concorrenti.** Con `watchdog.json` vuoto o perso ogni watchdog si crede
proprietario, e la sentinella era scritta con un rename che sovrascrive: due `restore()`
lanciavano entrambi (8/8). Ora `restore()` crea la sentinella con `writeFileSync(..., { flag:
'wx' })` **prima** di marcare l'interruzione, terminare o lanciare: chi la crea vince, l'altro
trova `EEXIST` e rifiuta ("another watchdog has just claimed this restore"). La sentinella porta
`nonce` e `phase` (`claimed`, poi `launched` riscritta dopo il lancio riuscito); il proprio
annullamento toglie solo la sentinella con il proprio testo. Test: unitario (il concorrente che
crea la sentinella fra la lettura e la creazione) e con processi veri (`hook.test.mjs`, 10 corse
di due processi `test/helpers/restore-racer.mjs` a una barriera comune: un lancio per corsa).
`race2.mjs` del verificatore con 20 corse: 0 doppi lanci.

**4. Una sentinella datata nel futuro.** Bloccava ogni ripristino e gli Stop non la toglievano
(`fired < at`). Ora (`sentinelVerdict`) oltre `SENTINEL_FUTURE_MS` (5 minuti) è scaduta: il
watchdog la ritira (`sentinel-retired` nel journal) e procede; `dropRestoreSentinel` la toglie al
primo Stop del proprietario; `decide()` non la conta come vita (come prima). Anche un
`interrupted.at` oltre la stessa tolleranza non blocca più `restore()`. Entro la tolleranza resta
una guardia.

**5. Una sentinella abbandonata, una cartella al suo posto.** Un watchdog ucciso fra le marcature
e il lancio lasciava tutto, e ogni watchdog successivo rifiutava per sempre. Ora una sentinella
`claimed` più vecchia di `max(2 × PERSEVERANZA_RESTORE_AFTER_MS, 10 minuti)` (`restoreTimes().
abandonMs`) il cui watchdog (`by`) non è vivo è abbandonata: ritirata, l'interruzione con lo
stesso `at` tolta, `restore-abandoned` nel journal e contata fra i `MAX_RESTORES`, poi un nuovo
tentativo. Lo stesso per una sentinella illeggibile più vecchia dell'intervallo (dalla sua data
di modifica); prima dell'intervallo resta una guardia, e uno Stop dopo la sua data la toglie. Una
`launched` non scade col tempo: la sessione riaperta può essere viva su un prompt, e un secondo
`claude -r` accanto è proprio ciò che la sentinella impedisce. Qualcosa che non è un file al suo
percorso (una cartella) è spostato da parte (`.old`, tolto se vuoto) dal watchdog e dallo Stop,
e non blocca. Il ritiro sposta il file da parte, confronta il testo con quello letto e solo
allora lo cancella: fra due watchdog vince un rename, e una sentinella nuova presa per errore
torna al suo posto. Il rename è ritentato qualche volta (una cartella appena creata può essere
tenuta un momento da un antivirus: una corsa su sei del test la vedeva). Test unitari con tempo
simulato (`utimesSync`, date nel passato) e con un processo vero (`hook.test.mjs`: le marcature
di un watchdog ucciso due ore prima, il watchdog vero scrive `alerted`, `restore-abandoned`,
`restored` e lancia una volta).

**6. Mutanti.** Uccisi con test nuovi in `watchdog.test.mjs`: X2/X3/X4 (sentinella `null`,
array, `at` non valido o assente, senza `session`: bloccano), X12 (`clearInterrupted` con un
altro `at` non tocca niente), X13 (`markInterrupted` rimette `reconcileAsked` a `false`), X15
(senza `PERSEVERANZA_RESTORE` sulla sola copia l'avviso normale, niente "No restore"), X16 (vita
fra due silenzi: due avvisi), X17 (`run()` accetta `spawnWatchdog` iniettato: chiamato con
`replace: true`), e anche i tre "quasi equivalenti": X5 (lo Stop nello stesso millisecondo del
lancio toglie la sentinella), X7 (`interrupted.at` dopo l'ultimo Stop rifiuta senza sentinella),
X25 (il lancio è datato al momento della chiamata, fra due letture dell'orologio). `history`
mostra le voci nuove del watchdog e `outcome-dropped-paused` (prima una voce del watchdog senza
silenzio diceva "silent for NaN").

### Versione

3.0.1 in `.claude-plugin/plugin.json`, `package.json`, badge ed esempio di HUD dei README.
`.claude-plugin/marketplace.json` e `manifest.mjs` non hanno un campo versione: niente da
cambiare. Il bench chiede `>= 3.0.0`: va bene così. Il test di packaging confronta già
`plugin.json`, `package.json` e i badge. Nel CHANGELOG la sezione della 3.0.0, già pubblicata,
si chiama ora "3.0.0" invece di "Non rilasciato (3.0.0)".

### Prove dopo la verifica manual-302 (terzo giro)

- `npm test`: **592 test, 0 skip, 0 fail** sul codice finale: da solo (686 s), con 6 loop di
  CPU in parallelo (531 s), e di nuovo da solo dopo l'ultima modifica ai documenti. La macchina
  era carica anche di lavori di altri (un `vitest` di un altro progetto, `herdr`, PowerShell). Una
  prima corsa con i 6 loop sotto quel carico (1264 s) ha dato 4 rossi, tutti per processi che
  partono lenti: `processInfo` (una chiamata PowerShell con 15 s di tempo) non vedeva vivo un
  processo vivo (anche il test di `restore.mjs`, che questo giro non tocca) e, nel test nuovo
  delle corse, il secondo processo partiva dopo il lancio del primo e lo leggeva come segno di
  vita (sempre un solo lancio). Corretti i due test nuovi: il controllo "la sessione non è
  terminata" usa `alive()` (un segnale 0, non PowerShell), l'attesa dei watchdog aspetta il loro
  avviso nel journal invece di 4 s fissi, la barriera delle corse è a 4 s e "decide: sleep" è
  una risposta valida del perdente; l'invariante resta un lancio per corsa. Una seconda corsa con
  i 6 loop sotto un carico esterno sceso ha dato un rosso, lo stesso test di `restore.mjs`
  (non toccato); la terza, quella riportata sopra, è verde. I 21 test in più: 16 in `watchdog.test.mjs`, 2 in `hook.test.mjs` (due
  processi in corsa per 10 volte; le marcature di un watchdog ucciso, con il watchdog vero), 2
  in `mod-tool.test.mjs` (l'esito durante lo Stop che escala; un `pause` a ogni lettura del
  verbo), 1 in `state-file.test.mjs` (il test dei verbi durante uno Stop lento diviso in due).
- Le riproduzioni del verificatore sul codice finale (`scratchpad/v302/`): `race-report.test.mjs`
  4/4 verdi (prima 4/4 rosse), `readback.test.mjs` 8/8 (uscita 0 se e solo se l'esito è su
  disco), `race2.mjs 20`: **0 doppi lanci su 20** (prima 8/8), `restore-probe.test.mjs`: R1 un
  watchdog vero dopo le marcature abbandonate scrive `restore-abandoned` e lancia; R3 la
  sentinella nel futuro è tolta dallo Stop e il ripristino parte; R4c la cartella è spostata.
  `vwd-restore.mjs pending`: **0 lanci**; `whole`: **1 lancio**, il sostitutivo rifiuta.
- `claude plugin validate . --strict`: "Validation passed". `claude plugin test .`: 205 verdi.
- **e2e reali**: `--scenario hostile` riuscito (37 s), `--scenario tool` riuscito (168 s,
  `no-plan > ready > always > pass > claim-first > always > pass`).
- **Mutazioni** su copie con `.git`: `mut302.mjs` (le correzioni di questo giro), la copia senza
  mutazioni verde, **27 su 27 uccise** (merge dello Stop: nessuno scarto, solo `lastReport`, senza
  journal, regola sullo stato di partenza; `changeOutcome`: nessun controllo nella scrittura,
  nessun ritiro, ritiro che lascia il valore, ritiro senza journal; sentinella: senza `wx` anche
  con due processi veri, lasciata dopo una marcatura fallita, mai `launched`, lasciata
  dall'annullamento; futuro: blocca di nuovo, lo Stop la tiene, l'interruzione futura blocca,
  tolleranza zero; abbandono: con il watchdog vivo, anche `launched`, non contato,
  l'interruzione tenuta, l'illeggibile mai scaduta, la cartella che blocca, il ritiro che
  cancella ciò che ha spostato, l'intervallo senza la soglia, lo Stop che lascia la cartella;
  `history`). La batteria del verificatore `vmut302.mjs`: i 10 mutanti la cui ancora c'è ancora
  sono uccisi (X9, X11 ... X16, X18, X19, X20, X24); gli altri 15 (X1 ... X8, X10, X17, X21,
  X22, X23, X25, la cui ancora il terzo giro ha riscritto, e X10 che nella forma originale non
  compila più) sono stati spostati sul codice nuovo con la stessa mutazione (`vmut302b.mjs`,
  `vmut302-adapted-list.mjs`) e sono **tutti uccisi** con gli stessi file di test del
  verificatore. Totale 25 su 25, compresi i tre "quasi equivalenti" X5, X7, X25.
- Repository pulito alla fine (nessuna `.perseveranza`, copia delle mutazioni, vecchia cartella
  di stato, `tsconfig.json` o `.claude-plugin/types`); nessun TODO, `.skip` o `.only` nei file
  toccati; tutti LF; nessun watchdog o processo finto rimasto.

### Prove dopo la verifica manual-301 (secondo giro)

- `npm test`: **571 test, 0 skip, 0 fail**, tre volte sul codice finale: 174 s da solo, 342 s con
  6 loop di CPU in parallelo, e la terza da sola dopo l'ultima modifica ai documenti. I 13 test in
  più: 10 in `test/unit/watchdog.test.mjs` (`restorable`; `restore()` su sola copia: nessuna
  chiamata ai processi, niente scritto; interruzione e sentinella su disco prima del kill e del
  lancio, viste dai finti `killTree`/`launchRestore`; marcatura fallita; sentinella non
  scrivibile; kill e lancio falliti che annullano; la sentinella da sola che rifiuta il secondo
  ripristino e vale come vita, anche illeggibile; `dropRestoreSentinel`; `cleanStateResidues`;
  `run()` su sola copia: un avviso, 5 attese, nessun ripristino), 1 in `hook.test.mjs` (processi
  veri, tre watchdog di fila: 0 lanci sulla sola copia, nessuna scrittura, un avviso per
  watchdog; 1 lancio sullo stato intero con `interrupted` tolto dopo il primo; la sentinella
  tolta dal primo Stop vero), 1 in `mod-tool.test.mjs` (`report pass|fail` e `claim-done` su un
  loop in pausa dopo un'escalation, dallo strumento e dalla shell: uscita 1, stato e journal
  identici; dopo `/pf resume` registrati), 1 in `subagent-wait.test.mjs` (il ritorno di prima
  dell'attesa); più due asserzioni in `mod.test.mjs`.
- Riproduzione del verificatore (`vwd-restore.mjs`, watchdog veri, `claude` finto): `pending` dà
  **0 lanci**, journal `["alerted"]`, `state.json` non creato, `interrupted` nullo; `whole` dà
  **1 lancio** (`-r sess-H`), journal `alerted, restored(launched), alerted, alerted(the restored
  session has not reached a Stop yet ...)`: il watchdog sostitutivo vero ha rifiutato.
- `claude plugin validate . --strict`: "Validation passed". `claude plugin test .`: **205** verdi.
- **e2e reali**: `--scenario hostile` riuscito (27 s; i rifiuti di prima e le 4 chiamate di
  `resume` rifiutate, pausa e contatori invariati, controllo `/pf resume` riuscito);
  `--scenario tool` riuscito (148 s, `no-plan > ready > always > pass > claim-first > always >
  pass`).
- **Mutazioni** (`mut301b.mjs` nello scratchpad, su una copia con `.git`): la copia senza
  mutazioni passa i test mirati (118); **24 su 24 uccise**. Watchdog: sempre `restorable`; senza
  la guardia in `run()`; senza il rifiuto in `restore()`; ripristino con la marcatura fallita;
  sentinella non scritta; guardia che ignora la sentinella (nei test unitari e con i processi
  veri); sentinella non contata come vita; annullamento senza togliere l'interruzione o la
  sentinella; sentinella illeggibile che apre; lo Stop che non la toglie (processi veri); tolta
  prima dello Stop; `arm` che la lascia; il primo avviso che promette il ripristino; quella di
  un'altra sessione contata. Pausa: il controllo tolto; scrittura fatta e poi rifiuto; `report` e
  `claim-done` di nuovo su `changeState`; il rifiuto senza `/pf resume`. Attesa: senza `a.at >=
  start` (test unitario e Stop nel processo), `>` al posto di `>=`. La batteria del primo giro
  (`mut301.mjs`), rieseguita sullo stesso codice: **29 su 29** ancora uccise.
- Repository pulito alla fine (nessuna `.perseveranza`, copia delle mutazioni, vecchia cartella
  di stato, `tsconfig.json` o `.claude-plugin/types`); nessun TODO, `.skip` o `.only` nei file
  toccati; tutti LF. Nessun watchdog o processo finto rimasto acceso dopo le prove.

### Prove del primo giro

- `npm test`: **558 test, 0 skip, 0 fail**, tre volte sul codice finale: 164 s e 179 s da solo,
  374 s con 6 loop di CPU in parallelo. Una corsa precedente (557/558) aveva trovato il vecchio
  prefisso nel titolo di un test nuovo (`names.test.mjs`): titolo corretto.
- `claude plugin validate --strict` (radice e manifest): "Validation passed".
- `claude plugin test`: **205** verdi (197 di prima, meno `resume` fra i verbi eseguiti, più 9
  rifiuti di `resume`: il verbo, le parole, le parole vuote, `RESUME`, `Resume`, accanto a
  `pause`, come parole di `pause` e di `status`, con un campo tipizzato).
- Test Node nuovi o cambiati: `test/unit/watchdog.test.mjs` (8: `EBUSY` una volta e sempre, file
  troncato e vuoto, solo `.pending` vivo e silenzioso, `.pending` accanto allo stato rotto,
  disarmato con marcatore, trattenuto, assente; `run()` che aspetta e riparte, che esce al tetto
  e lo scrive, che esce per il disarmo dopo `EBUSY`), `test/e2e/subagent-wait.test.mjs` (9, nel
  processo con un orologio finto: `implement` con l'esecutore che torna e lascia il lavoro, due
  esecutori di cui uno torna, nessuno che torna per 3 volte da 30 s e poi `idle`, il ritorno di un
  altro agente; review con il verdetto e senza; verifica finale con il verdetto e senza;
  `settleReturned`), `test/e2e/git.test.mjs` (la cartella 2.x scritta, anche tracciata, e un `test
  --if-needed` che dopo una sua scrittura trova ancora il verde), `test/e2e/mod-tool.test.mjs` (il
  CLI con `PERSEVERANZA_VIA=tool` su un loop in pausa per l'approvazione con i contatori di
  un'escalation: `resume`, `resume --json`, `RESUME`, `Resume`, `resume pause`, `resume
  --takeover` escono con 2, stato e journal identici, `ESCALATION.md` resta; poi `resume` da `/pf`
  toglie la pausa e azzera), `test/unit/mod-verbs.test.mjs` (le liste, `resume` in ogni forma, le
  notifiche nelle due modalità), `test/e2e/hook.test.mjs` (`ESCALATION.md`).
- **e2e reali** (Claude Code 2.1.292): `--scenario hostile` esteso, tre esecuzioni riuscite (27 s,
  22 s, 26 s; la prima prima di due ritocchi: la modalità della notifica presa dallo stato e il
  titolo di un test). Dopo la parte di prima, il loop (armato con `--approve-plan`) diventa della
  sessione del `claude -p` (`--session-id`), in pausa per l'approvazione con `retries` 2,
  `finalFails` 1, `staleGates` 1. Il modello (Sonnet, il predefinito dello scenario), in modalità
  di permesso `default`, ha fatto le 4 chiamate (`{"verb": "resume"}`, `RESUME`, `resume` con
  parole, `resume` come parole di `pause`): tutte risultati d'errore con "Nothing was run", la
  prima rimanda a `/pf resume`. Lo Stop di quella sessione è partito come proprietario; pausa,
  `planPresented`, fase, proprietario e contatori invariati; nessuna riga `signal`. Controllo:
  `claude -p "/pf resume"` esce con 0, "RESUMED", pausa tolta e contatori a 0, `signal` con `via:
  'command'`. `--scenario tool`: riuscito (132 s), lo strumento per `status`, `complexity`,
  `claim-done` senza errori, la suite da Bash.
- **Mutazioni** (`mut301.mjs` nello scratchpad, su una copia del repository con `.git`): **29,
  tutte uccise** dai test mirati (`claude plugin test` per il testo del rifiuto). La copia senza
  mutazioni passa gli stessi test (150 Node, 205 della mod). Resume: di nuovo nella lista dello
  strumento; lo strumento della 3.0.0 intero; il controllo sensibile alle maiuscole; senza
  minuscole; il campo `takeover` ignorato; il rifiuto che non nomina `/pf resume`; di nuovo nella
  lista del CLI; il muro del CLI dopo il verbo sconosciuto; il CLI che non nomina `/pf resume`; le
  notifiche sempre `resume`; la notifica di approvazione dalla modalità del guidatore;
  `ESCALATION.md` e `pause` col testo di prima; `{"verb": "resume"}` di nuovo nel comando.
  Watchdog: illeggibile = uscita; la copia promossa; il marcatore ignorato; il conteggio che non
  riparte; nessun tetto (il test va in timeout); l'uscita al tetto non scritta; il nuovo
  tentativo senza pausa; l'assente riprovato. Stop: nessuna ripartenza al ritorno; la ripartenza
  con i task di prima; tutti i task del ruolo chiusi; nessuno chiuso; il record del ritorno non
  passato. Git: l'impronta senza la cartella 2.x; `LOOP_DIRS` senza la cartella 2.x.
- Nessun file estraneo nel repository alla fine (`.perseveranza`, la copia delle mutazioni, la
  vecchia cartella di stato, `tsconfig.json`, `.claude-plugin/types` assenti), nessun TODO,
  `.skip` o `.only` nei file toccati, tutti LF.

### Limiti

- Il CLI da Bash resta: un modello a cui l'utente ha permesso Bash per `node` (o che lavora in
  `bypassPermissions`) può ancora lanciare `resume` così, come nella 2.x. Lo decidono i permessi
  dell'utente; il comando e il rifiuto dello strumento dicono di non farlo.
- `/pf resume` senza `--takeover` gira anche per un'origine che non è l'utente (un altro plugin
  con `$.command.run`), come deciso nella fase 3 (solo `arm`, `disarm`, `test`, `ask` e il
  takeover sono legati all'origine). Il modello non arriva a `/pf` (`Skill` lo rifiuta).
- Il watchdog smette dopo 10 minuti di `state.json` illeggibile di fila; il prossimo Stop ne
  avvia uno nuovo.
- Con lo stato solo nella copia in sospeso il watchdog veglia senza ripristinare finché uno Stop
  o un verbo non lo riscrive intero (o fino alla sua durata massima, 48 ore): una sessione appesa
  proprio in quel momento resta all'avviso, che lo dice. È la scelta sicura: un ripristino senza
  l'interruzione segnata non avrebbe la riconciliazione in sola lettura.
- Un `report` o un `claim-done` registrato **prima** di una pausa (un `pause` dato fuori da uno
  Stop, dopo che il verbo ha finito) resta e il primo Stop dopo il resume lo legge, come nella
  2.x: il rifiuto riguarda ciò che arriva durante la pausa, durante lo Stop che la mette, o
  insieme al `pause`.
- Una sentinella `launched` aspetta lo Stop della sessione riaperta senza scadenza: se quella
  sessione muore subito, i ripristini restano rifiutati (con l'avviso) finché un umano non la
  riapre, la riprende o disarma. Scadere qui vorrebbe dire un secondo `claude -r` accanto a una
  sessione forse viva su un prompt.
- Se il watchdog muore dopo il lancio ma prima di riscrivere la sentinella come `launched`, essa
  resta `claimed` e dopo l'intervallo di abbandono un watchdog successivo può ripristinare di
  nuovo accanto a una sessione riaperta che non ha ancora fatto uno Stop. La finestra è quella di
  una scrittura dopo uno spawn già riuscito.
- La vita del watchdog di una sentinella si controlla dal pid (`by`): un pid riusato da un altro
  processo la fa sembrare viva, e la sentinella non scade (si chiude, non si apre).

## Correzioni 3.0.2: multi-piattaforma

La CI (`.github/workflows/ci.yml`: Ubuntu, macOS e Windows per Node 20 e 22, `npm test` da utente
non root) era rossa sui push della 3.0.0 (run 37418271949) e della 3.0.1 (run 37579624960): la
suite era stata provata solo su Windows. Nove test rossi; ognuno classificato come (a) test non
portabile, corretto senza togliergli ciò che prova, o (b) difetto vero del codice, corretto con un
test che lo prende. Versione lasciata a 3.0.1 in `plugin.json` e `package.json`: la decide chi
rilascia (la voce del CHANGELOG è "3.0.2").

### I nove test

| CI | Test | Dove | Classe | Causa |
|----|------|------|--------|-------|
| 44 | lo Stop e `arm` avviano UN watchdog vivo | ubuntu, macos | (a) | l'"incumbent" è un figlio del test: ucciso, resta zombie finché Node non lo raccoglie, e Node raccoglie solo dal ciclo degli eventi, che le attese sincrone (`spawnSync`) non lasciano girare. `process.kill(pid, 0)` raggiunge uno zombie: `alive()` vero per 60 s |
| 69 | `arm` rifiuta la cartella home | macos | **(b)** | `samePath` di `arm` confrontava stringhe: il processo figlio vede la cwd reale (`/private/var/...`), `PERSEVERANZA_HOME` è scritta con `/var/...` |
| 230 | inbox, `state.json` in sola lettura | ubuntu, macos | (a) | su POSIX il modo di un file non impedisce un rename sopra di lui (decide la cartella): il salvataggio temporaneo-e-rename riusciva, e il conto era giusto |
| 241 | il checkout a `<claude>/perseveranza`: la disinstallazione rifiuta | macos | **(b)** | `install.mjs` lanciato da un percorso con un collegamento non partiva (vedi sotto): exit 0 senza una parola |
| 246 | una copia che fallisce: `settings.json` non scritto | macos | **(b)** | lo stesso |
| 247 | una cartella di installazione dentro il checkout: rifiutata | macos | **(b)** | lo stesso, e dietro un secondo difetto: la cartella di installazione (che non esiste ancora) non era risolta col suo percorso reale |
| 551 | la sentinella fallisce chiusa | ubuntu | (a) | `alertOn` decideva all'ora `T` del caricamento del file: una sentinella "di un secondo fa", nel primo secondo della corsa, è più giovane di `T` e conta come vita; `decide` dormiva e non dava lo stato (TypeError su `d.state.owner`). Su una macchina lenta il secondo era già passato |
| 552 | `interrupted.at` dopo l'ultimo Stop rifiuta | ubuntu | (a) | lo stesso, con l'interruzione "di un secondo fa" |
| 558 | un tentativo abbandonato conta nel limite | ubuntu, macos | (a) | la sentinella era datata esattamente all'intervallo di abbandono (2 h con l'ambiente del test), che va superato strettamente: scadeva solo se passava un millisecondo prima della lettura dell'orologio |
| 559 | una sentinella illeggibile scade | macos; windows node 20, instabile | (a) | lo stesso con l'`mtime` (`utimes` in secondi frazionari, arrotondato dal file system): passava o no a seconda del millisecondo |

### (b) `install.mjs` da un percorso con un collegamento

Node carica il modulo principale dal percorso reale, quindi `import.meta.url` è `/private/var/...`
mentre `argv[1]` è `/var/...`: il confronto con `resolve(argv[1])` falliva e `main` non girava.
Su macOS succede a ogni checkout sotto le cartelle temporanee e a chiunque raggiunga il checkout
con un symlink o una junction (anche su Windows: provato con una junction). Ora `argv[1]` passa
da `realpathSync`, come negli altri punti di ingresso (`perseveranza.mjs`, `watchdog.mjs`,
`mod-bridge.mjs`...). `scripts/legacy-hashes.mjs` (uno script di chi rilascia, non installato)
ha lo stesso confronto senza realpath: lasciato, fuori dalla CI.

Il controllo "la cartella di installazione non sta dentro il checkout" risolveva la cartella di
installazione con `realpathSync` o, se non esiste (il caso normale prima del primo install), col
percorso scritto: il checkout reale (`/private/var/x`) non era un prefisso di `/var/x/inner/...`
e l'install procedeva dentro il checkout. Ora `realPathOr` (`src/shell/paths.mjs`, usato da
`install.mjs` e da `arm`) risolve l'antenato più profondo che esiste e vi appende il resto come
scritto.

### (b) `arm` e la cartella home sotto un altro nome

`samePath(gateDir, home)` ora sta in `src/shell/paths.mjs`: uguali come scritti (maiuscole
ignorate su Windows), altrimenti due cartelle che esistono sono la stessa se coincidono
dispositivo e inode (`statSync` con `bigint`: un collegamento in uno dei due percorsi, le
maiuscole su un volume che non le distingue, il default di macOS), altrimenti (una delle due non
c'è, un file system senza inode) i percorsi reali di `realPathOr`. Prima un progetto il cui
`.perseveranza` era la home raggiunta da un collegamento si armava, e `disarm` avrebbe archiviato
(spostato) config e archivio delle corse con la corsa.

### (a) I test corretti, e cosa provano ancora

- Test 44: aspetta l'evento `exit` dell'incumbent (arriva dopo la raccolta), con un tetto di
  60 s, poi controlla `!alive(pid)` come prima. Il watchdog vero non ha questo problema: lo
  avviano processi che escono subito (il bridge della mod, il CLI di `arm`, il watchdog che si
  sostituisce dopo un ripristino), quindi passa a init, che lo raccoglie.
- Test 230: il rifiuto del file system su ogni piattaforma. Windows: l'attributo di sola lettura
  su `state.json` (rifiuta rename e scrittura sul posto). POSIX da utente: la cartella del loop in
  sola lettura (rifiuta il temporaneo, `EACCES`). Root (un container): i permessi non rifiutano
  niente, quindi il rifiuto `EACCES` arriva dall'fs con cui lo Stop scrive `state.json` (`io.fs`).
  Le asserzioni sono le stesse: il salvataggio fallito, niente rimosso, niente segnato, poi il 777
  contato una volta.
- 551, 552, 558, 559 (`test/unit/watchdog.test.mjs`): `alertOn` decide all'ora della chiamata e
  verifica che la decisione sia un avviso (un errore chiaro invece di un TypeError); le sentinelle
  "scadute" stanno un minuto oltre l'intervallo (`restoreTimes(NOENV).abandonMs + 60 s`). Il test
  della rivendicazione esclusiva decide prima che l'altro watchdog rivendichi (com'è la corsa
  vera), invece di contare su una sentinella vista come futura dall'ora `T`. Un test nuovo prova
  il limite stesso con un orologio dato (`sentinelVerdict`): all'intervallo blocca, un
  millisecondo oltre scade, per una rivendicazione e per una sentinella illeggibile.
- Uno in più, solo da root (la CI non gira da root): "un `settings.json` che non si può scrivere"
  usava `chmod 444`, che per root non rifiuta niente; da root l'installatore ora gira come utente
  `nobody` padrone della home di prova, e il rifiuto è vero.

### Prove

- Linux in Docker (`node:20-bookworm`, `node:22-bookworm`; il repository montato in sola lettura
  e copiato nel container con `.git`): sul commit 205689a, da utente 1000 con `TMPDIR` dietro un
  symlink (la situazione di macOS), i file toccati danno 7 rossi: 44, 69, 230, 241, 246, 247, 558
  (551 e 552 dipendono da quanto è passato dal caricamento del file: in CI rossi, qui no). Gli
  stessi file dopo le correzioni: 143 verdi. La suite intera dopo le correzioni, due giri per
  Node 20 e 22, da root e da utente 1000, ognuno una volta con `TMPDIR` dietro un symlink:
  **596 test, 594 verdi, 0 rossi, 2 saltati** in tutti e otto (i due saltati sono i test I3 dei
  lock di condivisione, solo Windows, saltati anche nella CI Linux da prima).
- Windows: `npm test` **596 test, 0 skip, 0 fail** da solo (240 s) e con 6 loop di CPU in
  parallelo (534 s), e di nuovo da solo dopo l'ultima modifica al codice e ai test (237 s).
- Mutazioni mirate sui due difetti (b), 13: uccise 11 su Windows e 12 su Linux (TMPDIR dietro un
  symlink). Sopravvive "maiuscole distinte su win32 nel confronto rapido", equivalente: il
  confronto finale dei percorsi reali le ignora su win32 comunque. "Maiuscole ignorate ovunque"
  muore solo su un file system che le distingue (Linux, non Windows), "ordine invertito della
  coda mancante" è morta dopo un'asserzione aggiunta su `realPathOr`.
- `claude plugin validate . --strict`: passato. `claude plugin test .`: 205 pass, 0 fail.

### Limiti

- macOS non si prova da qui: le correzioni vengono dai log della CI (exit 0 senza output
  dell'installatore, la cwd reale in `/private/var`) e dalla stessa situazione riprodotta su
  Linux con `TMPDIR` dietro un symlink, che fa fallire e poi passare gli stessi test. Il volume
  che ignora le maiuscole è coperto da dispositivo e inode, non provato su APFS.
- Che la CI torni verde lo dice solo un push.
