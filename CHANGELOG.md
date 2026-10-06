# Changelog

Modifiche degne di nota, con il **perché** (non solo il cosa). La versione vive in
`.claude-plugin/plugin.json`, in `package.json` e nei badge dei README; non si usano tag git.

## Non rilasciato (3.0.0)

La 3.0 fa di Perseveranza una **mod** di Claude Code: un solo modulo dentro Claude Code guida il
loop, al posto dei cinque hook di impostazioni della 2.x, e vede quello che un hook non vedeva
(i subagent ancora al lavoro, i token per agente). Porta il comando `/pf` per l'utente e lo
strumento `perseveranza` per Claude, e rinomina tutto ciò che portava il nome di un altro
strumento. Due rotture dichiarate; la migrazione è più sotto in questa sezione e nei README
("Migrazione dalla 2.x alla 3.0").

### Rotture

- **Il loop lo guida la mod, non più gli hook di impostazioni.** `hooks/hooks.json` dichiara solo
  il modulo della mod (`"modules": ["./register.js"]`). Servono **Claude Code 2.1.287 o
  successivo** e **la CLI** (`claude`, anche `claude -p`): l'app Desktop e l'estensione VS Code
  non hanno `$.process.run`, con cui la mod raggiunge il motore. Dove le mod sono spente
  (`--bare`, `--safe-mode`, `disableAllHooks`, una policy, l'interruttore remoto) il loop non è
  guidato: nessun hook di impostazioni fa da riserva, perché due guidatori dello stesso loop
  sarebbero un guasto.
- **Nomi nuovi, senza ripiego.** La cartella del loop (`.perseveranza/`), il CLI
  (`src/cli/perseveranza.mjs`), la cartella del run nell'archivio (`loop/`) e le variabili
  d'ambiente (`PERSEVERANZA_*`) portavano ancora il prefisso di oh-my-claudecode, un altro
  plugin: chi trovava quei nomi non poteva sapere a quale strumento appartenessero. I vecchi
  nomi non si leggono più, nemmeno come ripiego silenzioso: un ripiego terrebbe vivi due nomi
  per sempre e renderebbe ambiguo quale vale. Tabella completa in "Migrazione".
- **L'installazione manuale non scrive più hook.** `node install.mjs` copia il plugin in
  `~/.claude/perseveranza/` e lo fa caricare con `CLAUDE_CODE_PLUGIN_DIRS` nell'`env` di
  `~/.claude/settings.json` (il modo documentato per un plugin fuori da un marketplace); toglie
  gli hook di impostazioni delle installazioni 1.x e 2.x. Comando e agenti vivono nella cartella
  del plugin (gli agenti si chiamano `perseveranza:pf-*` come dal marketplace), non più in
  `~/.claude/commands` e `~/.claude/agents`.
- **`arm` rifiuta se la mod non gira** nella sessione di Claude Code da cui arma: senza la mod
  nessuno guiderebbe il loop. Dice le cause probabili e come procedere; `--no-mod-check` arma
  comunque. Fuori da una sessione (un terminale, uno script) arma con un avviso.
- **Le istruzioni del loop nominano lo strumento** quando la mod è viva: Claude manda i verbi
  dello stato del loop allo strumento `perseveranza`, e lancia con Bash solo la suite (`test`) e
  i modelli esterni (`ask`). Un prompt pack personalizzato che usa `{{LOOP}}` resta valido;
  `{{USER}}` (nuovo) è la forma per ciò che tocca all'utente.

### Novità

- **`/pf <verbo>`**, il comando per l'utente: stato, journal, archivio, `arm`, `disarm`,
  `pause`/`resume [--takeover]`, i segnali (`report`, `complexity`, `claim-done`), `test` e
  `ask`. Risponde subito, anche a turno in corso, **senza un turno del modello** (in
  `claude -p "/pf status"`: costo 0, il codice d'uscita del verbo). `/perseveranza <task>`
  resta il comando che avvia un task.
- **Lo strumento `perseveranza`** (`mcp__perseveranza__perseveranza`) per Claude: i verbi che
  leggono o muovono lo stato del loop, con argomenti controllati prima di avviare qualunque
  processo, senza shell, solo su un loop di questa sessione. Non esegue niente che i permessi di
  Bash governerebbero (uno strumento di una mod gira senza prompt dei permessi).
- **Uno Stop aspetta un subagent `pf-*` ancora al lavoro**: la macchina chiede di aspettarlo
  invece di mandare in review il nulla o contare un verdetto mancante (al più 3 attese per
  richiesta), e lo Stop stesso aspetta fino a 30 s (`PERSEVERANZA_SUBAGENT_WAIT_MS`) che il
  verdetto arrivi.
- **Giudici rimandati indietro**: un `pf-reviewer` o `pf-verifier` che si ferma senza il
  verdetto richiesto torna al lavoro con il motivo, al massimo due volte.
- **Token esatti, per agente**: ogni richiesta al modello, del ciclo principale e di ogni
  subagent, cache compresa; niente più lettura delle trascrizioni. `status` mostra la
  ripartizione.
- **Il modello dei subagent `pf-*`** è quello della complessità del run, imposto allo spawn.
- **Niente processi dove non c'è un loop**: senza `.perseveranza/state.json` la mod non avvia
  nessun `node` (prima: un processo per ogni evento di ogni sessione).
- **`status`** ha la riga `mod:` (la versione di Claude Code su cui gira) e mostra
  `.perseveranza/mod-fault.json`, la traccia di uno Stop che non ha raggiunto il motore.
- **Il journal dice da dove arriva un verbo** (`via: 'tool'` o `'command'`).
- `PERSEVERANZA_NODE`: il `node` che la mod usa, se non è quello sul `PATH`.
- **`npm run test:mod`**: `claude plugin validate --strict`, `claude plugin test` e un e2e con un
  `claude -p` vero; senza `claude` sul `PATH` ogni passo dice `SKIPPED`.

### Correzioni

- **Lo stato non si perde né si sovrascrive**: ogni file di stato si scrive in modo atomico e
  riletto (un disco pieno svuotava `state.json`), con una copia `.pending` che sopravvive a un
  kill; un verbo rilegge lo stato prima di scrivere (prima un `test` lungo azzerava i token
  contati nel frattempo) e due Stop sovrapposti non si sovrascrivono più.
- **I token non si perdono e non si contano due volte**: una casella di posta senza lock
  (`.perseveranza/usage-inbox/`) al posto della scrittura concorrente di `state.json` (prima 8
  flush paralleli da 100 davano 500-600); conteggi limitati, un valore ostile conta 0. Resta
  solo l'istante senza lock descritto nei limiti, dove l'errore va per difetto.
- **Una review ancora in corso non è più "mancante"**: prima le attese si consumavano in pochi
  secondi e la review finiva contata come fallita.
- Il task di un run 2.x stampato da `arm` e `status` non porta più sequenze di escape nel
  terminale.

### Migrazione

| prima (2.x) | dalla 3.0 |
|---|---|
| `.omc-loop/` (cartella del loop nel progetto) | `.perseveranza/` |
| `<run>/omc-loop/` (nell'archivio `~/.perseveranza/runs/`) | `<run>/loop/` |
| `src/cli/omc-loop.mjs` | `src/cli/perseveranza.mjs` |
| `OMC_LOOP_STALE_MS` | `PERSEVERANZA_STALE_MS` |
| `OMC_LOOP_KILL` | `PERSEVERANZA_KILL` |
| `OMC_LOOP_NO_NOTIFY` | `PERSEVERANZA_NO_NOTIFY` |
| `OMC_LOOP_NO_WATCHDOG` | `PERSEVERANZA_NO_WATCHDOG` |
| `OMC_LOOP_RESTORE` | `PERSEVERANZA_RESTORE` |
| `OMC_LOOP_RESTORE_AFTER_MS` | `PERSEVERANZA_RESTORE_AFTER_MS` |
| `OMC_LOOP_CLAUDE_BIN` | `PERSEVERANZA_CLAUDE_BIN` |
| `OMC_ASK_TIMEOUT_MS` | `PERSEVERANZA_ASK_TIMEOUT_MS` |
| `OMC_ASK_RETRIES` | `PERSEVERANZA_ASK_RETRIES` |
| `OMC_ADVISOR_MODEL` | `PERSEVERANZA_ADVISOR_MODEL` |
| `OMC_PROMPT_PACK` | `PERSEVERANZA_PROMPT_PACK` |
| `OMC_ACTIVITY_HEARTBEAT_MS` | `PERSEVERANZA_ACTIVITY_HEARTBEAT_MS` |
| `OMC_TEST_TIMEOUT_MS` | `PERSEVERANZA_TEST_TIMEOUT_MS` |
| `OMC_HOOK_TIMEOUT_MS` | `PERSEVERANZA_HOOK_TIMEOUT_MS` |
| `OMC_STATUSLINE_BASE_TIMEOUT_MS` | `PERSEVERANZA_STATUSLINE_BASE_TIMEOUT_MS` |
| `OMC_NO_UPDATE_CHECK` | `PERSEVERANZA_NO_UPDATE_CHECK` |
| hook di impostazioni (Stop, SessionStart, Pre/PostToolUse, SubagentStop) | la mod, `hooks/register.js` |
| i verbi, per l'utente: il CLI | `/pf <verbo>`, o il CLI |

`PERSEVERANZA_HOME` e `PERSEVERANZA_LANG` non cambiano. Cosa fare:

1. **Aggiornare**: dal marketplace `claude plugin update perseveranza@perseveranza`; da
   un'installazione manuale, `node install.mjs` (toglie anche gli hook di impostazioni e i file
   delle installazioni 1.x e 2.x). Hook scritti a mano verso `src/shell/stop.mjs`,
   `src/shell/session-start.mjs` o `src/shell/activity-hook.mjs` vanno tolti a mano.
2. **Variabili**: rinominarle. Una vecchia ancora impostata non ha effetto; `arm` e `status` la
   nominano accanto al nome nuovo.
3. **Un loop armato con la 2.x** resta in `.omc-loop/` e la 3.0 non lo guida: `arm` e `status`
   lo segnalano con il task; copiare ciò che serve e cancellare la cartella a mano. Il commit di
   chiusura non la include mai. `runs list` / `runs show` leggono ancora i run archiviati dalla
   2.x, in sola lettura.
4. **Script e alias** che chiamano il vecchio CLI, e **prompt pack** che citano la vecchia
   cartella, vanno aggiornati.

I vecchi nomi vivono in un solo modulo, `src/shell/legacy.mjs`, che non scrive mai. `arm`
rifiuta anche una cartella la cui `.perseveranza/` sarebbe la home `~/.perseveranza/`: con il
nome nuovo le due coinciderebbero e il disarmo archivierebbe config e archivio insieme al run.

### Limiti

- Solo la CLI di Claude Code, 2.1.287 o successiva; né Desktop né VS Code.
- Con le mod spente (flag, policy, interruttore remoto) il loop non è guidato. `status` lo lascia
  vedere e la sentinella avvisa del silenzio.
- Il recupero di uno Stop fallito vale una volta per turno dell'utente: un motore che si guasta a
  metà loop lascia fermare Claude (con la traccia nel journal o in `mod-fault.json`).
- La mod perde con il suo processo i fatti non ancora scritti: fino a 15 s di token e 30 s di
  battito.
- Fra l'ultimo controllo dello stato e il rename resta una finestra senza lock: di solito un
  istante, su una CPU satura quanto lo scrittore resta fermo fra le due chiamate (misurati
  1,6 s). Un verbo sovrascritto lì perde la sua modifica. Uno Stop sovrascritto lì riconta i
  suoi token allo Stop dopo, tranne se un terzo Stop ha già cancellato i file della casella che
  contava: quei token si perdono. L'errore va sempre per difetto (un token non si conta mai due
  volte) e servono più scrittori sovrapposti. Nello stress della verifica finale (Stop, flush e
  verbi sovrapposti in processi veri, 6 loop di CPU, pause iniettate fra le chiamate di sistema)
  2 giri su 171 hanno perso 7 e 14 token su 4563; con il doppio del carico un giro ne ha persi
  1607.
- Un reload azzera i conteggi `askedTimes` dei giudici: al più 2 rinvii in più a un giudice.

### Dettagli delle fasi

Per chi segue il codice: cosa è cambiato in ogni fase di `docs/PIANO-MOD.md`, dove stanno anche
i fatti verificati, le prove e i limiti di ciascuna.

#### Fase 1 della mod

Il nucleo additivo e il ponte che la mod userà. **Nessun cambio di comportamento** con gli
hook di impostazioni: i fatti nuovi li vede solo la mod (fase 2), e senza di loro la macchina
decide come prima.

- **`subagent-running`.** Se a uno Stop un subagent del ruolo della fase (`pf-executor` in
  `implement`, `pf-reviewer` in `review`, `pf-verifier` in `final-verify`, anche con il
  prefisso `perseveranza:`) risulta ancora `running` in `ctx.backgroundTasks`, la macchina
  chiede di aspettarlo invece di mandare in review il nulla o contare un esito mancante; gli
  altri `pf-*` non fanno attendere. Al massimo 3 attese per richiesta di verdetto
  (`counters.subagentWaits`, azzerato da una nuova richiesta o da un cambio di fase, non da
  `missing`), e nessuna attesa dopo 5 stop di fila senza lavoro (`counters.quietStops`: si
  azzera solo con lavoro vero, cioè albero cambiato, test registrato, verdetto o `report`
  instradato, claim; mai con un'attesa, `missing`, `missing-twice` o `idle`): un subagent
  bloccato dà al più 3 attese in tutta la serie senza lavoro. Un'attesa non spende iterazioni, non sposta l'albero di riferimento
  (le modifiche fatte nel frattempo vanno in review, non in `idle`), non consuma né sposta
  alcun file di verdetto e lascia aperto il giro delle lenti. Un verdetto letto, un `report` o
  un `claim-done` decidono comunque. Riga nuova nella tabella delle transizioni.
- **Token della mod.** `ctx.usage` con `source: 'mod'`: la ripartizione `byAgent` (per
  `agentId`) è la lettura, i totali ne sono almeno la somma e gli agenti oltre il tetto
  finiscono in `other` invece di sparire, così il budget conta ogni token. `status` lo dice.
- **`src/core/subagents.mjs`** (puro, senza `node:`): `routeModel` (modello di
  `pf-reviewer`/`pf-verifier`/`pf-executor` per complessità, `MODEL_ROUTING.execute` nuovo) e
  `subagentVerdictCheck` (il verdetto che un giudice deve lasciare: assente, malformato o
  stantio non va bene; dopo 2 richiami lascia andare; senza id di richiesta non trattiene).
- **`{{LOOP}}` come strumento.** `ctx.loopMode = 'tool'` rende i verbi come "lo strumento
  `perseveranza` (verbo e argomenti): report pass" (chiave `loop-tool`, en e it).
- **Ponte `src/shell/mod-bridge.mjs`.** JSON su stdin, JSON su stdout, mai un'eccezione:
  `stop` (la logica di `stop.mjs`, ora in `stop-core.mjs` con `stop.mjs` involucro sottile),
  `subagent-stop` (il motivo nella lingua del loop), `activity-flush`, `usage-flush`.
  Lo stato si scrive ora in modo atomico anche dallo Stop (file temporaneo + rename), e ogni
  salvataggio si rilegge: uno stato che non è arrivato intero su disco è un salvataggio
  fallito (`state-save-failed` nel journal). Dopo un salvataggio fallito non si cancella
  nessun file della casella e non si archivia né disarma (l'archivio procede solo se lo stato
  finale riesce almeno in `state.unsaved.json`, accanto a `state.json`).
- **Casella di posta dei token** (`.perseveranza/usage-inbox/`, `src/shell/usage-inbox.mjs`), senza
  lock. `usage-flush` non tocca mai `state.json`: crea un file suo, atomico. Lo Stop, unico
  scrittore dello stato oltre ai verbi, elenca la casella prima di leggere lo stato, somma i
  delta e salva con i nomi contati in `state.usageInboxSeen`. Il file lo cancella uno Stop
  successivo, solo se lo stato che ha caricato lo nomina: un crash o un salvataggio
  sovrascritto non fanno contare due volte un file né perdere i suoi token (il limite che
  resta è descritto più sotto). Un file illeggibile (vecchio di 5 s) diventa
  `<nome>.invalid` e si annota. `status` mostra anche i token ancora in casella. Prima, flush
  e Stop sovrapposti perdevano token (8 flush paralleli da 100 davano 500-600). I nomi
  contati escono da `state.usageInboxSeen` solo quando il loro file risulta davvero assente
  (un file che Google Drive o un antivirus non lascia cancellare non si riconta mai); nessun
  taglio per numero, solo una guardia a 5000 annotata nel journal. Ogni file porta sessione e
  arm (`state.armedAt`): un file di un'altra sessione o di un'altra armata si scarta. Un flush
  senza loop risponde `no-loop` e non crea nulla. Con `state.json` bloccato (EBUSY) o corrotto il
  delta si accoda comunque (`armUnknown`): `no-loop` vuol dire nessun run (la cartella si crea solo dentro un
  `.perseveranza/` che esiste ancora, mai ricorsivamente).
- **Conti dei token limitati.** Ogni conteggio è un intero finito non negativo
  (`tokenCount`); un valore troppo grande satura a `Number.MAX_SAFE_INTEGER` invece di
  diventare `Infinity` e poi 0; ogni campo di un delta della mod è troncato a 1e12 e
  annotato (`usage-clamped`); le somme saturano; un valore ostile (negativo, NaN, stringa)
  conta 0 e non toglie mai nulla al totale. Una stringa conta solo se è fatta di cifre
  decimali (con decimali facoltativi): niente `0x10`, `0b11`, esponenti, segni o spazi, che
  `Number()` leggerebbe.

- **Lo stato non si perde.** Tutti i file di stato si scrivono in un modo solo
  (`src/shell/state-file.mjs`):
  - un temporaneo riletto, e se non arriva intero non si tocca nulla: prima un disco pieno
    svuotava `state.json`;
  - il rename riprovato;
  - la scrittura sul posto solo dopo che la copia completa è diventata `state.json.pending`,
    che il caricamento dopo promuove se la scrittura si interrompe, anche con un kill -9
    (`state-recovered`);
  - prima di ogni tentativo, nuovi tentativi compresi, si ricontrolla che il file sia ancora
    quello letto: se un altro ha salvato nel frattempo, il verbo riparte dal suo stato e lo
    Stop rifà l'unione, invece di sovrascriverlo.

  I verbi non salvano più una copia vecchia: `updateState` rilegge lo stato subito prima di
  scrivere, con un `rev` incrementato a ogni salvataggio e fino a 3 tentativi. Prima un
  `test` lungo riportava a zero i token contati da uno Stop durante la suite. Lo Stop tiene
  ciò che un verbo ha scritto mentre girava (`state-merged`). I file della casella si
  cancellano solo quando lo stato su disco li nomina. Dopo un archivio fallito, `status` e
  `disarm` usano lo stato più recente del run. `arm` toglie ciò che un run vecchio lascia. Un
  gate che un file bloccato tiene in vita dopo il disarmo riceve `state.disarmed.mark` e non
  si riarma più.

  Due Stop sovrapposti non si sovrascrivono più: chi trova il salvataggio dell'altro prima di
  scrivere riparte da quello, chi lo trova al salvataggio abbandona il suo. Un file della
  casella dei token lo cancella solo uno Stop successivo, e solo perché lo stato che ha caricato
  lo nomina. Così un salvataggio sovrascritto perde nome e token insieme, e il file si conta
  dopo, una volta sola. Anche il delta portato da `stop` passa dalla casella. Uno Stop non
  riscrive uno stato che un `disarm` ha tolto mentre girava. Un EBUSY in lettura non fa
  promuovere una copia vecchia. `arm` rifiuta se il marcatore di disarmo resta, e
  `disarm --no-archive` con lo stato bloccato dice che non ha disarmato.

  Il delta portato da `stop` si scrive nella casella per primo, anche quando `state.json` resta
  bloccato (EBUSY): il file dice `armUnknown` e vale per il run armato prima della sua
  scrittura. Prima, uno Stop che usciva con `state-busy` perdeva quel delta. Un file della
  casella si conta solo se è ancora su disco dopo la lettura dello stato: uno Stop che l'ha
  elencato mentre un altro lo contava e poi lo cancellava non lo conta di nuovo. Il delta si
  scrive una volta per Stop, non a ogni ripartenza. La rilettura dello stato prima del
  salvataggio riprova tre volte. Se lo stato resta illeggibile, il salvataggio si abbandona
  e il journal ne dice il motivo vero: bloccato, tolto o disarmato. I token non si perdono:
  li conta lo Stop dopo.

  Il bridge non confonde più uno `state.json` bloccato con un loop assente. `usage-flush`
  accoda il delta (`armUnknown`). `subagent-stop` rimanda indietro un giudice con il motivo,
  al massimo due volte. `activity-flush` risponde `busy` con `retry: true`. Uno Stop il cui
  delta non entra nella casella lo dice nella risposta (`usageDropped`), e la mod lo rimanda.
  Tre risposte per il delta di uno Stop o di un flush:
  - accodato: si conta una volta;
  - scartato (`usageDropped`, o `{ ok: false }` al flush): il guasto è avvenuto prima che un
    file col nome della casella potesse esistere, quindi nessuno Stop l'ha visto e la mod lo
    rimanda;
  - non confermato (`usageUnverified`, o `unverified: true` al flush): il file è stato scritto
    sul posto senza conferma, uno Stop può averlo già contato, e la mod non lo rimanda.

  Un delta scartato non si conta mai. Uno non confermato che non è arrivato intero si perde:
  lo Stop e il flush lo annotano nel journal, se il journal si può scrivere. Senza risposta (timeout, crash) la mod non rimanda. Uno `state.json`
  corrotto vale come bloccato, non come loop assente. Una lettura rifiutata di un file della
  casella non lo scarta più come `.invalid`; se dura, il journal lo annota una volta e `status`
  lo elenca. La nota si scrive prima del marcatore o dello spostamento, da qualunque Stop
  incontri il file per primo (anche di un'altra sessione, o uno che esce perché lo stato è
  bloccato). Un `background_tasks` ostile, per esempio con `status` non stringa, non fa più
  fallire lo Stop: la voce si ignora.

  Resta un limite, documentato: l'istante fra l'ultimo controllo e il rename (due chiamate,
  nessun lock). Un verbo sovrascritto proprio lì perde la sua modifica. I token si perdono solo
  con tre scrittori sovrapposti e uno di essi fermo fra due chiamate di sistema, e sempre per
  difetto. La durabilità vale
  contro la morte del processo, non contro una mancanza di corrente.

#### Fase 2 della mod: perseveranza guida il loop come mod di Claude Code

**Rottura voluta**: il plugin non registra più hook di impostazioni. `hooks/hooks.json` nomina
solo il modulo della mod (`"modules": ["./register.js"]`), che richiede Claude Code 2.1.287 o
successivo e gira solo nella CLI (`claude`, anche `claude -p`): la mod raggiunge il loop con
`$.process.run`, che l'app Desktop e l'estensione VS Code non hanno. Dove le mod sono spente
(`--bare`, `--safe-mode`, `disableAllHooks`, una policy) il loop non è guidato. Prima c'erano
cinque hook di impostazioni (Stop, SessionStart, Pre/PostToolUse, SubagentStop), ciascuno un
processo `node` a ogni evento; adesso c'è un solo guidatore, e un progetto senza un loop
armato non avvia nessun processo: conta `.perseveranza/state.json` (o la sua copia `.pending`
di un salvataggio interrotto, se il run non è stato disarmato), non la cartella, che esiste
anche in `~/.perseveranza` e in un progetto dopo un run archiviato. L'installazione manuale (`install.mjs`) ha
scritto gli hook di impostazioni fino alla fase 4.

- **Stop** (`classic.Stop`): il ponte (`src/shell/mod-bridge.mjs`) esegue la logica di
  `stop.mjs` con i fatti che solo la mod vede (i subagent ancora in corsa, i token esatti per
  agente). Se il ponte non risponde, un solo blocco di recupero, e solo per il loop di questa
  sessione; con `stop_hook_active` già vero lascia fermare (mai un blocco infinito), e una
  sessione senza loop, o con il loop di un'altra sessione, non si blocca mai. Quel fermarsi non
  è muto: il guasto va nel journal o, se il ponte non risponde nemmeno a quello (`node`
  irraggiungibile), in `.perseveranza/mod-fault.json`, che `status` mostra, la notifica del
  watchdog nomina, lo Stop successivo annota e toglie, e `arm` segnala se è rimasto. Lo Stop
  aspetta (al più 5 s) un flush dei token già partito, così un delta rifiutato dal ponte parte
  con lui.
- **Giudici** (`classic.SubagentStop`): un `pf-reviewer` o `pf-verifier` che si ferma senza il
  verdetto richiesto (assente, vecchio, illeggibile) viene rimandato indietro con il motivo, al
  massimo due volte; prima l'esito `missing` arrivava solo allo Stop del ciclo principale.
- **Modelli** (`agent.spawn`): i subagent `pf-*` girano sul modello di `MODEL_ROUTING` per la
  complessità del run, non più solo su quello suggerito dal prompt (riga `model-route` nel
  journal). Se il routing fallisce vale il modello del prompt.
- **Token** (`turn.step`): ogni richiesta al modello, del ciclo principale e di ogni subagent,
  cache compresa, contata per agente; niente più lettura delle trascrizioni. `status` mostra la
  ripartizione.
- **Battito** (`tool.call`, `SubagentStop`): deleghe, ritorni e attività in `activity.json`,
  con debounce (2 s per deleghe e ritorni, al più ogni 30 s per il resto). Il ritorno chiude la
  delega di QUEL subagent (per `agent_id`, legato alla chiamata Agent da `agent.spawn`), una
  volta, e solo quando il subagent è lasciato andare: due verificatori in parallelo restano
  distinti, e un giudice rimandato indietro resta in attesa.
- **Riconciliazione** (`tool.call`): durante la riconciliazione dopo un ripristino gli strumenti
  che modificano restano rifiutati, come con il `PreToolUse` di prima.
- **Avviso di sessione** (`classic.SessionStart`): lo stesso testo di `session-start.mjs` per
  un loop che la sessione non possiede, e dopo una compattazione.
- **Versione di Claude Code** (`session.start`): una versione vecchia o illeggibile è detta
  sotto il prompt e nel journal; `status` ha la riga `mod:` con la versione su cui gira la mod.
  Le righe della mod nel journal sono solo della sessione che possiede il loop (portano la
  sessione); `status` legge solo quelle.
- Versione 3.0.0 in `plugin.json`, `package.json` e nei badge dei README.
- `PERSEVERANZA_NODE`: il `node` che la mod usa per il ponte, se non è quello sul PATH.
- Il task di un run 2.x stampato da `arm` e `status` non porta più sequenze di escape, caratteri
  di controllo o a capo nel terminale.
- Test: `npm run test:mod` (`claude plugin validate --strict`, `claude plugin test` con
  `test/mod/*.test.ts`, e un e2e con un `claude -p` vero che porta un mini-task dal piano al
  commit finale); senza `claude` sul PATH ogni passo dice `SKIPPED`. `npm test` resta locale e
  deterministico. Dettagli, prove e limiti in `docs/PIANO-MOD.md` ("Stato fase 2").

#### Fase 3 della mod: lo strumento `perseveranza`, il comando `/pf`, `arm` che controlla la mod

- **Lo strumento** `mcp__perseveranza__perseveranza`: Claude esegue i verbi che leggono o
  muovono lo stato del loop (`status`, `history`, `explain`, `report`, `complexity`,
  `claim-done`, `pause`, `resume`) con argomenti tipizzati invece di comporre
  `node ".../perseveranza.mjs" ...` in Bash: `{"verb": "report", "args": "pass"}` (le parole
  dell'istruzione così come sono) o `{"verb": "report", "outcome": "pass"}`. La mod controlla
  tutto **prima** di avviare un processo (Claude Code non applica lo schema), poi esegue il CLI
  con `$.process.run`, una lista di argomenti e nessuna shell, nella cartella della sessione.
  Uno strumento di una mod gira **senza il prompt dei permessi**, quindi non esegue niente che i
  permessi di Bash governerebbero: la suite (`test`) e i modelli esterni (`ask`, che avvia la
  CLI di un agente) restano comandi di shell che Claude lancia con Bash, e lo strumento li
  rifiuta; `arm`, `disarm` e `resume --takeover` sono dell'utente; su un loop di un'altra
  sessione ogni verbo che cambia qualcosa è rifiutato. Il CLI rifiuta a sua volta tutto questo
  quando l'esecuzione dice di venire dallo strumento (`PERSEVERANZA_VIA=tool`). Senza un loop
  armato ogni verbo tranne `status` è rifiutato e nessun `node` parte. Un errore dello
  strumento è un risultato d'errore, mai un'eccezione: il CLI resta il ripiego nominato.
- **Il comando** `/pf <verbo> [argomenti]` per l'utente: i verbi dello strumento più `test`,
  `ask`, `arm` (con gli argomenti del CLI), `disarm`, `resume --takeover` e `runs`; gira
  subito anche a turno in corso, e la risposta è testo nella trascrizione, **senza un turno del
  modello** (in `claude -p "/pf status"`: 0 turni, costo 0, il codice d'uscita del verbo). Un
  verbo che non prende parole rifiuta quelle in più (`/pf disarm la sveglia` non disarma
  niente). Claude non può eseguirlo (Claude Code rifiuta un comando di una mod dallo strumento
  `Skill`), e `arm`, `disarm`, `test`, `ask` e la presa di un loop girano solo per quello che
  l'utente digita (non per il `$.command.run` di un altro plugin). Si chiama `/pf` perché un
  comando registrato prende il nome al comando markdown omonimo: `/perseveranza <task>` resta
  il comando che avvia un task.
- **`arm` controlla la mod**: dentro una sessione di Claude Code (`CLAUDE_CODE_SESSION_ID`,
  che Claude Code dà alla Bash ed è lo stesso id di `$.session.id()`) cerca il segno di vita che
  la mod scrive all'avvio di ogni sessione della CLI, `~/.perseveranza/mod-alive/<sessione>.json`
  (`PERSEVERANZA_HOME` se impostata). Se manca **rifiuta** e dice le cause probabili e come
  procedere: senza la mod nessuno guiderebbe il loop. `--no-mod-check` arma comunque; fuori da
  una sessione (un terminale, uno script) `arm` arma con un avviso. Nelle sessioni disegnate
  solo da Desktop o VS Code la mod non lascia il segno (`$.process.run` è "solo CLI"). I segni
  di vita vecchi (30 giorni) e quelli oltre i 100 si potano, da `arm` e, quando sono troppi,
  dalla mod all'avvio.
- **Le istruzioni nominano lo strumento** (`options.loopMode: 'tool'`, scelto da `arm` quando la
  mod è viva) solo se anche chi guida lo Stop ha lo strumento; altrimenti il comando di shell,
  identico a prima byte per byte. In modalità strumento la suite e i modelli esterni sono il
  comando di shell "da eseguire con Bash", e quello che tocca all'utente (approvare il piano,
  riprendere, disarmare, prendere un loop) è `/pf`: la nuova variabile di prompt `USER`, nei
  pacchetti en/it.
- **Uno Stop aspetta un subagent `pf-*` ancora al lavoro** (fino a 30 s,
  `PERSEVERANZA_SUBAGENT_WAIT_MS`, mai oltre la scadenza dello Stop): se il suo verdetto arriva
  intanto, lo Stop lo legge subito. Prima le tre attese concesse si consumavano in pochi secondi
  e una review ancora in corso finiva contata come mancante due volte, cioè fallita.
- **Il journal dice da dove arriva un verbo**: `via: 'tool'` o `'command'` (`/pf`), anche nel
  riassunto archiviato (`verbs`, `tests[].via`).
- `commands/perseveranza.md`, gli agenti `pf-*` e i README: lo strumento per i verbi del loop,
  Bash per `test` e `ask`, `/pf` per l'utente. Dettagli, prove e limiti in
  `docs/PIANO-MOD.md` ("Stato fase 3", "Correzioni dopo la verifica 3").

#### Fase 4 della mod: il pacchetto

- **`install.mjs`** carica il plugin con `CLAUDE_CODE_PLUGIN_DIRS` (vedi "Rotture"): copia la
  cartella del plugin (il manifest), aggiunge la sua cartella alla lista nell'`env` di
  `settings.json` lasciando le altre voci e le altre chiavi, toglie gli hook di impostazioni
  1.x/2.x (solo un comando che esegue esattamente uno dei loro script:
  `LEGACY_SETTINGS_HOOK_SCRIPTS` in `src/shell/legacy.mjs`), i file della 1.x e le copie 2.x di
  comando e agenti (solo le nostre, riconosciute dal contenuto). Legge e controlla
  `settings.json` prima di toccare qualunque cosa (non JSON, non un oggetto, `env` o la lista
  di un tipo sbagliato, non scrivibile: rifiuta e non cambia niente). Al primo cambiamento ne fa
  una copia che non sovrascrive più; lo scrive solo se cambia, con un rename, tenendo permessi,
  BOM e link simbolico. Sostituisce o toglie solo una cartella sua: un marcatore
  (`.perseveranza-install.json`, i file con la loro impronta) o, per la 2.x, soltanto file suoi;
  rifiuta un checkout git, un link o una junction, il checkout da cui gira, un marcatore corrotto,
  e all'installazione file non suoi. La copia si prepara a parte, si verifica e prende il posto
  della vecchia con due rename; `settings.json` si scrive dopo; un'installazione interrotta si
  ripara alla successiva. `--uninstall` toglie la voce (e la chiave, e `env`, se restano
  vuote), i file del marcatore (non i tuoi) e gli avanzi.
  Provato con un `claude -p` vero in una home temporanea: `/pf` e lo strumento rispondono,
  `arm` trova la mod; dopo `--uninstall` `/pf` non c'è più.
- **`manifest.mjs`** non dichiara più hook (`HOOK_SPECS` e le loro entrate tolti); un test
  controlla che né il manifest né `install.mjs` ne dichiarino, e `test/packaging/install.test.mjs`
  prova l'installazione in una home temporanea (installare, reinstallare, disinstallare, JSON
  ostile, `settings.json` assente o non scrivibile, avanzi 1.x/2.x).
- **Riferimenti controllati**: `test/packaging/references.test.mjs` verifica che ogni percorso,
  verbo del CLI, di `/pf` e dello strumento, variabile, script npm, agente, link e ancora citati
  da README, comando, agenti e prompt esistano.
- **Il segno di vita resta giovane**: la mod lo riscrive alle chiamate di strumenti della
  sessione (al più ogni 10 minuti) e la potatura non tocca mai un file di meno di un giorno.
  Prima una sessione lunga perdeva il suo file dietro a cento `claude -p` più giovani, e il suo
  `arm` rifiutava.
- **`/pf runs show`** accetta gli id come li stampa `runs list` (`<progetto>/<data>`), con
  una convalida stretta (al più una `/`, niente `..` o percorsi assoluti).
- **Il bench** arma con `--no-mod-check` e senza `CLAUDE_CODE_SESSION_ID` nell'ambiente dei
  suoi processi: lanciato da dentro una sessione di Claude Code non trova più la sessione
  sbagliata.
- Il test di `restore.mjs` che voleva "nessun Claude Code sopra" un processo del test accetta il
  Claude Code vero sopra la suite (lanciata da una sessione, da una copia, la ricerca lo
  raggiungeva): mai il processo di partenza né un `node` qualunque.
- README (it/en) con la sezione della mod: cos'è, requisiti, installazione, uso, sicurezza,
  risoluzione dei problemi, limiti, migrazione. `npm run test:mod` passa
  `ENABLE_CLAUDEAI_MCP_SERVERS=0` ai suoi processi e nomina l'interruttore remoto quando è lui a
  fermarlo.
- **Correzioni dopo la verifica finale** (dettagli in `docs/PIANO-MOD.md`):
  - `install.mjs` non cancella più una `<claude>/perseveranza` che non riconosce come sua:
    prima la toglieva ricorsivamente, anche se era un checkout con lavoro non salvato. Il
    marcatore, i rifiuti, il recupero delle interruzioni e il trattamento di `settings.json`
    sono quelli descritti sopra. Un `settings.json` che è un link a un file inesistente ora è
    rifiutato; prima il link veniva sostituito da un file.
  - L'istante senza lock dello stato è descritto con la direzione giusta: può far perdere
    token, mai contarli due volte, e su una CPU satura dura secondi (vedi "Limiti"). Un test
    fissa la sequenza dei tre scrittori.
  - I test che dipendevano dai tempi di una macchina carica ora aspettano i fatti: il verdetto
    arriva dentro l'attesa del ponte, le durate sono quelle misurate dal ponte e il watchdog si
    attende finché esce. Un figlio `node` che finisce senza scrivere nulla viene rilanciato.
  - I test rimuovono le loro cartelle temporanee.
- **Correzioni dopo la verifica dell'installatore** (manual-inst1, dettagli in
  `docs/PIANO-MOD.md`). La pulizia dei residui 1.x/2.x riconosceva i file per nome o per un
  contenuto approssimato, e poteva cancellare file dell'utente. Ora `install.mjs` **cancella
  solo** (a) i file del suo marcatore ancora intatti, (b) i file vecchi identici byte per byte a
  quelli di una release passata (`src/shell/legacy-hashes.mjs`, generata dalla storia git da
  `scripts/legacy-hashes.mjs` e confrontata con git da `test/packaging/legacy-hashes.test.mjs`),
  (c) gli avanzi di una sua esecuzione interrotta, riconosciuti dal file sentinella che ci
  scrive per primo e solo se quel processo non c'è più. Tutto il resto lo **segnala**, mai lo
  cancella. In concreto:
  - i file in `~/.claude/hooks/` con il nome di un file 1.x restano se il contenuto non è
    quello di una release (prima si cancellavano per nome);
  - un agente `pf-*` in `~/.claude/agents/` che cita `.perseveranza/` (la cartella della 3.0,
    quindi una copia personalizzata) non viene più preso per una copia 2.x;
  - una cartella `perseveranza.old-*` o `perseveranza.tmp-*` non sua (senza sentinella, o con il
    processo ancora vivo, o con nome e sentinella diversi) resta dov'è; una rimozione che non
    riesce a togliere un file tiene marcatore e sentinella, così la successiva la finisce;
  - modificare un file dell'installazione, disinstallare (il file resta, il marcatore se ne va)
    e reinstallare non cancella più il file modificato: una cartella senza marcatore si
    sostituisce solo se ogni file è di una release, altrimenti l'installazione rifiuta e lo dice.
- **Lucchetto**: due `install.mjs` sulla stessa cartella di configurazione non girano insieme
  (`<claude>/.perseveranza-install.lock`, una cartella creata in modo atomico con il pid del
  proprietario). Il secondo aspetta fino a 10 s e poi si ferma spiegando cosa fare; un lucchetto
  il cui processo non c'è più si riprende subito, uno di un processo vivo dopo 5 minuti (pid
  riusato). Prima la pulizia di un'installazione cancellava la copia in preparazione dell'altra.
- **`settings.json` modificato come testo** (seconda verifica dell'installatore,
  manual-inst2): si scrive o si toglie la nostra voce e si tolgono gli hook vecchi, e ogni altro
  byte resta com'era. Prima il file veniva riscritto: gli array in linea si espandevano,
  `"a":1` diventava `"a": 1`, `-0`, `1.0`, `1E5` e `1e20` diventavano `0`, `1`, `100000` e
  `100000000000000000000`, e dopo un `1e20` ogni `--uninstall` si rifiutava. Il risultato deve
  dare esattamente le impostazioni attese, altrimenti si rifiuta (solo se una chiave da cambiare
  è scritta due volte). Installare e disinstallare restituisce gli stessi byte, tranne: la voce
  aggiunta è scritta come i membri accanto; il valore di `CLAUDE_CODE_PLUGIN_DIRS`, quando
  cambia, è in JSON standard; un file vuoto diventa `{}` e un `"env": {}` vuoto già presente
  sparisce.
- La voce di `CLAUDE_CODE_PLUGIN_DIRS` si confronta sul **percorso reale**: la stessa cartella
  scritta con un nome 8.3, una junction o `subst` non si aggiunge una seconda volta (Claude Code
  caricava la mod due volte), e `--uninstall` toglie ogni grafia. Le altre voci della lista
  restano come sono scritte, spazi compresi.
- **La copia di sicurezza della 3.0** si chiama `settings.json.bak-perseveranza-3.0` e si fa
  anche quando c'è il `settings.json.bak-perseveranza` della 2.x (che resta com'è): prima chi
  veniva dalla 2.x non aveva nessuna copia del file di prima della 3.0. Non si scrive mai sopra
  o attraverso qualcosa che ha già quel nome; se `settings.json` l'aveva creato l'installazione
  non si fa nessuna copia e `--uninstall` lo cancella quando contiene solo la nostra voce.
- **Un hook 1.x/2.x** si toglie da `settings.json` solo se lo script che esegue è ancora
  loro (non c'è più, o è identico a una release): uno che esegue un loro script modificato resta
  ed è elencato.
- Se `~/.claude/hooks`, `agents` o `commands` è un **link o una junction**, lì dentro non si
  cancella niente (prima una copia identica a una release veniva tolta dalla cartella di
  destinazione, per esempio un repository di dotfiles).
- Un **lucchetto con un proprietario corrotto** (pid o ora non numerici, JSON non valido, vuoto,
  troppo grande, un'ora nel futuro) si tratta come uno senza proprietario: dopo pochi secondi si
  riprende, e intanto il messaggio dice di toglierlo. Prima finiva con "Invalid time value".
- La tabella delle impronte vecchie si calcola dai commit raggiungibili da 2.6.0
  (`LEGACY_ANCHORS` in `scripts/legacy-hashes.mjs`), non da tutti i ref del clone: un ramo o uno
  stash locale non la cambia più.
- **Reinstallare la stessa versione non riscrive niente**: con il marcatore e ogni impronta
  uguali alla sorgente non copia nulla (né impronte né date cambiano) e lo dice.
- La CI clona con tutta la storia (`fetch-depth: 0`): i test ricostruiscono le installazioni
  1.x e 2.x con i loro installatori, letti da git.

## 2.6.0

La fase 1 di `docs/PIANO-GIUDICI-PARALLELI.md`: la verifica finale con più lenti, e due
pezzi indipendenti dai giudici in parallelo e utili comunque (token con i subagent,
severità tolleranti).

**Cambio di comportamento:** con complessità `high` la verifica finale non è più un
verificatore solo con l'accenno alla sicurezza, ma tre verificatori in parallelo
(`correctness`, `security`, `tests`). Chi vuole il comportamento di prima arma con
`--verifiers general`.

- **Verifica finale con più lenti.** `arm --verifiers <lenti>` sceglie tra `general`,
  `correctness`, `security`, `tests` (una lente sconosciuta è un errore che elenca quelle
  ammesse); senza, `auto`: le ultime tre con complessità `high`, altrimenti `general`. La
  lista si fissa quando il giro viene richiesto, non all'arm: la complessità può cambiare
  nel frattempo. Il prompt chiede di delegare nello stesso messaggio e in primo piano un
  verificatore per lente, ciascuno con il suo file (`verify-<lente>.json`), lo stesso id
  richiesta e il mandato della lente; la lente `security` sostituisce l'accenno alla
  sicurezza del verificatore singolo, e `tests` controlla anche che commenti e
  documentazione dicano il vero (nei run reali è saltata fuori documentazione falsa due
  volte). `pf-verifier` sa scrivere il file della sua lente.
- **Come si combina il giro: poche regole uniformi.** Nessuna riga nuova nella tabella delle
  transizioni: cambia come si calcola l'esito di `final-verify`, non dove va il loop. Il gate
  di uscita (piano spuntato, verde sul codice giudicato, codice invariato) è lo stesso di
  prima e si applica al pass del giro.
  1. Si leggono tutti i file di verdetto della cartella (`verify.json` e i `verify-<lente>.json`).
     Ognuno è valido per il giro (id della richiesta corrente, o senza id ma scritto dopo la
     richiesta), vecchio (un'altra richiesta, o scritto prima: messo da parte subito, mai
     letto) o illeggibile (malformato: mai un pass; resta su disco finché il giro è aperto).
  2. Un file valido che blocca boccia il giro, qualunque nome abbia e qualunque lente sia
     arrivata. `verify.json`, e `verify-general.json` nel giro del verificatore singolo,
     bloccano con la regola di sempre (`pass: false`); un file di lente blocca con un finding
     `critical`, o con un `pass: false` dichiarato sopra findings scritti `high`/`major` (vedi
     sotto). Un critical vince sempre: aggiungere una lente che passa non trasforma mai una
     bocciatura in un pass.
  3. Una lente attesa è coperta solo dal suo file valido. Un `verify.json` valido copre le
     lenti attese che non hanno nessun file (pack di prompt personalizzati o vecchi, agenti
     che non hanno letto le lenti: `lens-fallback` nel journal; meglio un giro meno fine che
     un loop bloccato). Una lente con il file illeggibile non la copre nessuno: resta
     mancante. Le lenti mancanti si chiedono da sole (`verify-missing-lenses`), le altre
     restano valide per lo stesso giro; la seconda volta è una bocciatura. Rigore, non
     quorum: un giudice che non risponde non è un voto a favore.
  4. `verify.json` vuol dire la stessa cosa qualunque cosa sia arrivata: se boccia, boccia
     anche con tutte le lenti scritte; se passa, copre solo le lenti senza file. Valido, non
     viene mai messo da parte.
  5. Nel giro del verificatore singolo `verify-general.json` vale come `verify.json`.
  6. Un file valido di una lente non chiesta boccia se blocca, altrimenti è solo annotato;
     non copre niente.
  7. **[deviazione]** In un giro a lenti `report pass` non copre le lenti mancanti (resta un
     esito mancante, e il journal lo dice): nessun pass con una lente mancante, e un pass
     dichiarato non è una prova. `report fail` boccia come sempre. Il verificatore singolo
     resta com'era: il verbo vale, salvo che il suo file sia illeggibile.
  8. Chiuso il giro, ogni file letto è conservato (`verify-<lente>-<n>.json`,
     `verify-main-<n>.json` per `verify.json`, `-invalid-` per un illeggibile) e tutti i
     findings, ciascuno con la sua lente e il file da cui viene (`from`), finiscono in un solo
     `verify-<n>.json` (scritto in modo atomico): il fix rilegge un file, non quattro.
     `pass` lì coincide con l'esito del giro, `blockedBy` dice chi ha bocciato, e il journal
     non elenca mai il file che boccia tra i "pass con warning".
  Il verificatore singolo con il solo `verify.json` si legge esattamente come prima.
- **[scelta] Il `pass: false` di una lente sopra findings `high`/`major` blocca.** Le
  severità `high`, `major`, `grave`, `alta`, `alto`, `maggiore` si leggono `warning`, e in un
  giro a lenti un `pass: false` con soli warning non blocca: così lo stesso verdetto bocciava
  come `verify.json` e passava come `verify-security.json`, e la bocciatura dichiarata dal
  giudice spariva in silenzio. Ora una lente che dichiara `pass: false` e ha almeno un
  finding scritto con una di quelle parole blocca il giro, con una nota nel journal. Resta la
  decisione di progetto: `pass: false` con soli `warning`/`suggestion` canonici (o con
  `medium`, `low` e gli altri alias più deboli) è un pass con warning; e un `pass: true`
  sopra un `high` resta un pass, perché `high` non è `critical`.
- **Un pack che personalizza il prompt del verificatore singolo** e non quello per lenti
  tiene il suo testo; il suo `verify.json` copre il giro per la regola 3.
- **Ogni bocciatura rende più forte il giro dopo.** Il loop ricorda i `verify-<n>.json` degli
  ultimi tre giri bocciati, e il prompt della verifica successiva (singola o per lenti)
  chiede a ogni verificatore di controllare che quei difetti siano risolti e che i fix non
  abbiano introdotto regressioni.
- **Dati per imparare dai run.** Il journal registra a ogni giro le lenti attese, arrivate,
  mancanti, scartate e i critical per lente; `history` li rende leggibili. `status` mostra
  le lenti scelte, e in verifica finale quelle attese e arrivate. Il bench `--dry-run`
  scrive un verdetto per lente quando è armato con più lenti (`BENCH_VERIFIERS`), e la CI lo
  prova.
- **[scelta] Il verificatore singolo non cambia.** Con la sola lente `general` tutto resta
  come prima: `verify.json`, e un `pass: false` senza critical è ancora una bocciatura (la
  lettura più severa). Estendere a lui la regola "blocca solo il critical" (decisione 6.2
  del piano) è rimandato: sarebbe un cambio di comportamento da misurare prima sui run.

La misura dei token cambia in due modi opposti. **Cambio di comportamento:** lo stesso
`--budget-tokens` non vale più la stessa quantità di lavoro. Il nuovo totale va da un terzo
a oltre quattro volte il vecchio: sulle sessioni reali con subagent la mediana è circa 0,6,
e più di due su tre scendono. Conviene rivedere il tetto guardando la ripartizione in `status`.

- **Ogni messaggio si conta una volta.** Claude Code scrive un messaggio dell'API su più
  righe (una per blocco di contenuto), che ripetono l'`usage`: l'input sempre, l'output
  quasi sempre. Il budget le sommava tutte, e la cifra della sessione era circa il doppio
  del reale (su 50 trascrizioni: 4,7M di output contati contro 2,3M veri). Ora ogni
  `message.id` conta una volta, con l'ultima riga.
- **Il budget in token conta anche i subagent.** Reviewer, verificatori ed executor
  scrivono trascrizioni loro (`<sessione>/subagents/agent-*.jsonl`) che il budget non
  leggeva: nei run archiviati erano circa metà della spesa. Ora si sommano a quella della
  sessione, dall'arm in poi, e `status` mostra la ripartizione per tipo di agente (dal
  `.meta.json` accanto a ogni trascrizione), conservata anche nel `summary.json` del
  run. Il formato delle trascrizioni dei subagent è di Claude Code, non documentato: senza
  la cartella si conta la sola sessione, come prima, e `status`/`history` lo dicono. Un
  subagent finito si legge una volta per run (`.omc-loop/usage-cache.json`); se l'hook
  finisce il tempo valgono gli ultimi valori letti e il journal marca la lettura come
  parziale. Una sessione che non guida il loop non legge nulla.
- **Severità tolleranti nei verdetti.** Un verdetto giusto nel merito veniva buttato per un
  sinonimo (in un run reale: `"severity": "medium"`). Ora `blocker`/`bloccante` si leggono
  `critical`; `high`/`medium`/`major`/`alta`/`maggiore` `warning`; `low`/`minor`/`info`/`nit`/
  `minore` `suggestion`; il journal annota la mappatura. `high` non diventa `critical`: nella
  scala critical/high/medium/low sta sotto, e un `critical` rovescia il `blocking`/`pass`
  dichiarato dal giudice. Una severità ancora sconosciuta resta un
  errore (esito mancante), come prima: un verdetto letto con un dubbio non è un verdetto.

Un advisor interno per il caso "nessun modello esterno disponibile", e per i momenti in cui
un secondo parere serve davvero: prima di consegnare il piano, e quando lo stesso errore si
ripresenta. La verifica finale resta coperta dalle lenti.

- **Nuovo agente `pf-advisor`.** Contesto pulito, sola lettura sul sorgente, `effort: high`.
  Scrive un solo file di testo libero, `.omc-loop/advisor-<slot>-<n>.md` (`plan` o `fix`):
  diagnosi o critica, i tre rischi principali, cosa cambierebbe, cosa non ha potuto
  verificare. Niente JSON, niente `requestId`, niente verdetto: non instrada. Lo installano
  il plugin e `install.mjs` (che lo rimuove alla disinstallazione).
- **Dove interviene.** Nel piano: con modelli esterni resta la critica esterna e l'advisor è
  il ripiego se nessuno risponde; senza esterni è lui il secondo parere. Nel fix dopo una
  review bocciata, dal 2º tentativo; nel fix dopo la verifica finale, dalla 2ª bocciatura
  (prima senza alcun parere: ora con la diagnosi esterna, se c'è, e con l'advisor). Nuovi
  hint `hint-advisor-plan`, `hint-advisor-fix`, `hint-advisor-verify-fix` (più
  `hint-advisor-fallback`, la clausola "se nessun esterno risponde"), in inglese e in
  `packs/it.json`; nuove variabili `advPlanHint` in `plan-write` e `advFixHint` in
  `review-fix` e `verify-postfix`.
- **Impara dai tentativi falliti.** Il loop ricorda i `review-<n>.json` bocciati dello step
  corrente (`priorReviews`, azzerato quando lo step passa) e l'advisor del fix li riceve
  tutti, come i `verify-<n>.json` delle verifiche bocciate: non deve riproporre un approccio
  già fallito e dice se il problema è di piano. Se lo è, Claude riscrive lo step in
  `plan.md` prima di riprovare. Nessuna transizione nuova.
- **Antifragile.** Consultivo: un parere mancante, vuoto o in errore non è un finding e non
  blocca; Claude integra solo le osservazioni fondate e motiva in `notes.md` quelle scartate
  (o annota che il parere manca). Le transizioni, i retry e le pause sono gli stessi con
  l'advisor acceso o spento.
- **Opzioni e misura.** `arm --advisor on|off` (default `on`) e `arm --advisor-model <nome>`
  (default `OMC_ADVISOR_MODEL`, altrimenti `opus`; un nome non valido è un errore, nella
  variabile d'ambiente è ignorato con un avviso). Uno `state.json` di prima si carica con i
  default. Il journal registra ogni hint (`advisor-hint`, con slot e motivo `no-external`,
  `fallback` o `off`), anche quello del piano iniziale all'arm; `status` mostra
  `Advisor: on (opus)` o `off`.

## 2.5.3

Tre correzioni (verdetti legati alla loro richiesta, prove ricontrollate alla chiusura,
tregua per la sessione ripristinata) e la revisione che ne ha trovato i difetti prima del
rilascio: in quella forma un progetto fuori da git con `--test` non chiudeva più, e il job
`bench-dry` della CI falliva.

- **Ogni verdetto risponde a una richiesta precisa.** Ogni prompt che chiede un verdetto
  emette un `requestId` nuovo, anche restando nella stessa fase (un nuovo giro di verifica
  da `final-verify`, una riconciliazione, una pausa dopo un ripristino), e l'agente lo
  copia nel file. Un id diverso è una richiesta precedente, anche se scritto dopo: prima
  un verificatore del giro vecchio che finiva tardi veniva preso per buono. L'id giusto
  vale anche se l'orologio del file è indietro (share di rete, WSL). Un verdetto senza id
  (pack di prompt vecchi, riconsegne dopo una compattazione) torna alla regola
  dell'orario: rifiutarlo sempre, come nella prima stesura, bloccava i pack esistenti e
  il bench. `status` mostra l'id, `prompts validate` avvisa se un pack non lo passa,
  `history` dice perché un verdetto è stato scartato. Un file scartato non cancella più
  l'esito registrato col verbo `report` nello stesso turno.
- **Un pass finale chiude solo ciò che ha giudicato.** Al pass si ricontrolla: piano
  ancora tutto spuntato, ultimo verde eseguito sul codice giudicato, codice invariato dalla
  richiesta di verifica. Non le regole di freschezza del claim-done: il test gira prima
  della richiesta, quindi "eseguito in questa iterazione" al verdetto non vale mai, ed è
  per questo che fuori da git non si chiudeva più. Se il pass non copre il lavoro non si
  committa nulla e si torna in implement con un prompt dedicato (`pass-open`,
  `pass-stale`), non con un "claim-done RIFIUTATO" per un claim mai fatto.
- **Cambio di comportamento: l'output di build e di test va in `.gitignore`.** Il codice
  confrontato è tutto ciò che git non ignora, documentazione esclusa: solo così un file
  nuovo modificato durante la verifica non viene committato senza essere stato giudicato.
  Il prezzo: se i run del verificatore riscrivono output non ignorato (coverage, build),
  ogni pass lo vede come codice cambiato. Dopo quattro pass così, senza bocciature in
  mezzo, il loop si mette in pausa e spiega cosa ignorare; prima avrebbe chiuso.
- **Un claim-done nello stesso turno di un verdetto non lo perde più.** Se il claim viene
  rifiutato, decide il verdetto già consumato: prima il loop restava in `final-verify`
  senza verdetto da leggere, e una bocciatura veniva contata due volte o un pass diventava
  una bocciatura. Una bocciatura seguita da un claim-done accettato conta comunque.
- **Nessun rilancio alla cieca dopo un ripristino.** La sentinella concede alla sessione
  ripristinata un intervallo di avvio; se poi la sessione tace senza aver mai raggiunto uno
  Stop, non la rilancia una seconda volta: il pid registrato è quello appena terminato, e
  trovarlo morto non prova niente. Resta l'avviso per l'umano.
- **Ripristino su Linux e macOS.** `processInfo` leggeva come vivo un processo zombie
  (terminato ma non ancora raccolto dal padre), e il ripristino falliva con "could not
  terminate"; su macOS, inoltre, `ps -o comm=` dà il percorso completo troncato a 16
  caratteri, quindi nessun processo risultava `node` o `claude`: ora si legge `ucomm`.
  Sono i motivi per cui la CI su Linux e macOS falliva dal 7 settembre.
- **Test.** I due test e2e del ripristino chiudono sempre i processi che avviano (un
  processo rimasto teneva appesa l'intera suite: le CI cancellate dopo sei ore), e la
  ricerca del processo nipote non chiama più `powershell` fuori da Windows.

## 2.5.2

Riletta la tabella dei campi frontmatter dei subagent di Claude Code contro i tre agenti del
plugin: niente da correggere, due campi da prendere.

- **Giudici con un tetto, misurato.** `maxTurns: 120` su `pf-reviewer` e `maxTurns: 300` su
  `pf-verifier`: un giudice che non si ferma non tiene più il turno in ostaggio. I numeri
  vengono dalle trascrizioni dei run reali (48 subagent su quattro progetti): il reviewer
  sta a 18 turni di mediana e 52 di massimo su 28 run, il verificatore a 64 di mediana e
  150 di massimo su 8, con il verdetto scritto al turno 148 dopo 32 minuti di lavoro
  legittimo. La prima stesura metteva il tetto proprio a 150: avrebbe tagliato quel giro
  sul filo. Il tetto è circa il doppio del massimo visto, perché un giudice tagliato non
  scrive il verdetto e la macchina lo legge come esito mancante (chiesto una volta, poi
  bocciatura). `pf-executor` resta senza tetto: un passo tagliato a metà è peggio di uno lungo.
- **Sforzo del verificatore fissato.** `effort: high` su `pf-verifier`: il giro avversariale
  non dipende più dallo sforzo della sessione che lo lancia.
- **Scartati, con il motivo.** `omitClaudeMd` toglierebbe al giudice le note di macchina del
  CLAUDE.md (l'interprete giusto per lanciare i test, per esempio); `isolation: worktree`
  parte dal ramo di default e non dall'albero di lavoro, quindi giudicherebbe altro codice;
  `hooks`, `mcpServers` e `permissionMode` sono ignorati per i subagent dei plugin, e il
  test di packaging ora vieta di scriverli.

## 2.5.1

Visto in un run reale: undici giri di verifica finale, gli ultimi due su un albero già
approvato. Il giro 9 aveva dato `pass:true`, ma nello stesso turno l'agente aveva ritoccato
la documentazione e ridichiarato `claim-done`.

- **Un pass finale non si butta via.** In `step` il ramo `claim-done` veniva valutato
  prima dello switch sulle fasi: con `verify.json` `pass:true` e un claim nello stesso
  turno vinceva il claim, esito `claim-again`, verdetto pulito scartato e verifica
  ripartita da zero (un giro intero di token per nulla, ogni volta). Ora in `final-verify`
  con verdetto `pass` il claim è ignorato, annotato nel journal (`claim`, `ignored`), e il
  loop va a `git-finish`. Con una bocciatura il claim prevale come prima.

## 2.5.0

Due lezioni prese da `osolmaz/pi-workflows`, che risolve gli stessi problemi su Pi con
un'API di estensione che Claude Code non ha: il timeout non chiude il run ma instrada a una
riconciliazione in sola lettura, e una risposta a una richiesta scaduta non avanza nulla.

- **Riconciliazione dopo un ripristino.** La sentinella, prima di riaprire la sessione,
  scrive `signals.interrupted`; il prompt di ripristino chiede un'ispezione in sola lettura
  e `.omc-loop/reconcile.json` (`disposition` complete/partial/uncertain, `running`, `next`).
  Allo Stop la macchina riconcilia prima di ogni altra cosa: file mancante o invalido →
  chiesto una volta, poi pausa; `uncertain` o un comando ancora vivo → pausa con escalation
  (un comando incerto blocca ogni nuovo tentativo mutante); `partial` → `implement` con
  `reconcile-implement` (continua, non rifare); `complete` → `review`. I contatori di retry
  restano: l'interruzione conta nel limite. Quattro righe nella tabella delle transizioni.
- **Sola lettura per enforcement.** L'hook `PreToolUse` ora copre anche Bash, PowerShell,
  Edit, Write, MultiEdit e NotebookEdit: con `interrupted` attivo risponde `deny`, con il
  motivo, a ogni tool che muterebbe e a ogni comando fuori dalla lista di ispezione. Anche
  loro hanno scoperto in review che le istruzioni nel prompt non bastano. L'unica scrittura
  ammessa è `reconcile.json` stesso: la revisione ha trovato che la prima stesura la negava,
  e la riconciliazione non poteva mai chiudersi (il test e2e scriveva il file dall'harness);
  la lista giudica ogni segmento del comando, non solo il primo (`ls & git commit` passava).
- **Verdetti tardivi.** Entrando in `review` o `final-verify` la macchina registra
  `verdictRequestedAt`; lo Stop hook passa l'mtime di `review.json`/`verify.json`; un file
  più vecchio della richiesta (tolleranza 1 s) è messo da parte come `<nome>-stale-<n>.json`
  e trattato come mancante. Chiude il caso del subagent di un turno ucciso che scrive dopo
  il ripristino, e quello del file rimasto attraverso un takeover.

## 2.4.0

La sentinella della 2.3.0 avvisava e basta: non esiste un'interfaccia per interrompere un
tool in corso in Claude Code, l'unico interrupt è Esc. Questa versione fa premere Esc alla
sentinella. Tutto è stato provato a mano prima di scriverlo (`docs/REVIEW-NOTES.md`): una
sessione reale uccisa a metà comando, ripristinata con `--resume`, stesso id, prompt
eseguito sette secondi dopo.

- **Kill e ripristino (`OMC_LOOP_RESTORE=1`, disattivo di default).** Lo Stop hook registra
  il processo Claude Code che lo ha lanciato (pid e istante di avvio, risalendo l'albero) e
  il percorso della trascrizione. A silenzio accertato la sentinella termina l'albero di
  processi e riapre la stessa sessione in una nuova console, dalla cartella del progetto,
  con il prompt `session-restore` (nel pack: fase, task, deleghe mai tornate, "non ripetere
  ciecamente"). Due stadi: avviso alla soglia, kill dopo una seconda soglia
  (`OMC_LOOP_RESTORE_AFTER_MS`, default il doppio: una sessione ferma su una domanda
  all'utente non scrive nulla, e l'avviso è la sua occasione). Massimo tre ripristini per
  run, contati sull'intero journal; un pid riusato o senza istante di avvio registrato non
  viene mai ucciso; nessun rilancio senza un processo registrato (sarebbero due processi
  sulla stessa sessione); una sessione già morta viene riaperta senza uccidere nulla, e
  quella ripristinata ha subito la sua sentinella. La ricerca del processo parte SOPRA
  l'hook e riconosce solo il binario nativo o node con `cli.js` del pacchetto: il plugin
  installato vive sotto `~/.claude/plugins/`, e "qualunque cosa con claude nel nome"
  avrebbe trovato l'hook stesso (difetto trovato in revisione, non nella prova a mano fatta
  dalla copia di lavoro). Windows completo; macOS/Linux best-effort. Le tre lezioni del test sono nel codice: via `CLAUDE_CODE_CHILD_SESSION`
  dall'ambiente (o la sessione figlia non salva la trascrizione), prompt come argomento
  unico, lancio dal progetto.
- **Terzo segno di vita: la trascrizione.** Scritta a ogni messaggio, con quelle dei
  subagent in `<sessione>/subagents/`: un modello che genera per un'ora non è silenzio.
  `status` la mostra (`transcript: written 5s ago`).
- **Il verbo `test` batte il cuore** mentre la suite gira (`OMC_ACTIVITY_HEARTBEAT_MS`,
  60 s): una suite da mezz'ora non è mai un loop morto.
- **Soglia a trenta minuti.** Con tre segnali il silenzio legittimo più lungo è un singolo
  tool: una `Bash` arriva a dieci minuti. Trenta sono tre volte il caso peggiore; il loop
  orfano della segnalazione ne aveva quaranta volte tanti. Un turno morto alle 11:10 riparte
  alle 11:40 invece del giorno dopo.

## 2.3.0

La 2.2.0 rendeva visibile un loop orfano quando l'utente tornava. Ma il blocco vero, il
subagent che non torna, restava invisibile finché il turno non finiva, e nessuno avvisava
mentre le ore passavano. Il plugin eseguiva codice solo negli hook di fine turno: qui
guadagna un battito dentro il turno e una voce quando il battito si ferma.

- **Battito dentro il turno.** Tre hook nuovi, `PreToolUse` sull'Agent, `PostToolUse` sui
  tool di lavoro (non Read/Grep/Glob: frequenti e a buon mercato, non vale un processo) e
  `SubagentStop`, scrivono `.omc-loop/activity.json` (file proprio, scrittura atomica, una
  ogni 30 s): l'ultimo segno di vita del loop. Le deleghe restano "pendenti" finché i
  subagent non tornano (una lista: le deleghe parallele sono la norma), così `status`, HUD, `SessionStart` e la sentinella dicono "delegato a
  pf-reviewer alle 11:10, non ancora tornato" invece di "silenzio". `status` ha la riga
  `activity:`, il journal le voci `activity` (deleghe e ritorni), la HUD e lo `STALE` si
  misurano dall'ultimo segno di vita; un turno lungo che lavora non è più un `gap`.
- **Sentinella staccata (`watchdog`).** A ogni Stop e ad `arm` parte un processo staccato
  che dorme fino a `lastSeen + OMC_LOOP_STALE_MS`, si riallinea finché il loop dà segni di
  vita, esce se il loop è in pausa o disarmato, cede il posto a una sentinella più recente
  (`.omc-loop/watchdog.json` tiene il pid) e, se il silenzio è vero, manda la notifica
  desktop e scrive `watchdog` nel journal, con le deleghe pendenti se ci sono;
  `summary.json` conserva `watchdogAlerts`. Una sola sentinella per loop: se quella in
  carica è viva, lo Stop non ne lancia un'altra. Vita massima 48 h, sonno massimo 1 h. `OMC_LOOP_NO_WATCHDOG=1`
  la spegne (i test la esercitano in modo sincrono, e una volta per davvero).
- **Una tabella per gli hook.** `manifest.mjs` espone `HOOK_SPECS`; `hooks/hooks.json`
  deve coincidere (test di packaging) e `install.mjs` registra esattamente quelli.

Cosa resta fuori, onestamente: la sentinella avvisa, non sblocca. Un subagent appeso va
interrotto a mano (Esc) e il loop riparte al prossimo Stop; un client morto senza chiudere
nulla si vede solo dalla sentinella.

## 2.2.0

Nasce da un loop orfano (`docs/SEGNALAZIONE-2026-09-07-loop-orfano.md`): dopo 17 iterazioni
buone la sessione proprietaria è sparita a metà review e il loop è rimasto "in corso" per 20
ore senza che nulla lo dicesse. Il loop vive solo nello Stop hook di una sessione: se quella
non chiude più un turno, il plugin non esegue più codice e il journal non distingue "sta
lavorando" da "è morto". Il silenzio diventa un fatto di prima classe.

- **Hook `SessionStart`: il loop orfano fa una domanda.** Una nuova sessione aperta in una
  cartella con un loop di un'altra sessione riceve un contesto con proprietario, fase, età
  dell'ultimo fire, passi fatti e ultima istruzione iniettata, con l'ordine di non toccare
  `.omc-loop/` e di chiedere all'utente se riprendere (`resume --takeover`) o fermare
  (`disarm`). Se il proprietario è vivo (fire recente) il messaggio è solo informativo.
  Un loop appena armato e non ancora rivendicato, o appena rilasciato con `--takeover`,
  riceve un avviso diverso (non è abbandonato). Dopo una compattazione la sessione
  proprietaria riceve un promemoria della fase, perché l'istruzione iniettata può essere
  andata persa. Gli avvisi sono chiavi del prompt pack (`session-*`, `hint-last-fire`...):
  parlano la lingua del loop e si sovrascrivono come le altre. L'hook legge solo la coda
  del journal. Dormiente senza `state.json`.
- **Takeover esplicito, mai implicito.** Il ramo che dopo 6 ore (`OMC_SESSION_TAKEOVER_MS`)
  faceva subentrare la prima sessione che passava di lì è rimosso: una sessione aperta per
  tutt'altro si sarebbe ritrovata a guidare la review del passo 12 (peggio: in `implement`
  con `--commit` e albero sporco). Ora `resume --takeover` libera il proprietario e il
  prossimo Stop nel progetto, da qualunque sessione arrivi, rivendica il loop dalla fase
  corrente (`session released` e `session takeover` nel journal). Il rilascio ha una
  finestra (la stessa soglia di `OMC_LOOP_STALE_MS`): scaduta, nessuno lo rivendica per
  sbaglio e serve un nuovo `--takeover`. Su un loop che non era in pausa il takeover è un
  recupero, non la chiusura di una pausa: contatori di retry e `ESCALATION.md` restano.
  Un `resume` semplice dice chi possiede il loop e da quanto tace.
- **Un loop in pausa non è abbandonato.** Escalation, approvazione del piano e chiusura git
  non confermata mettono il loop in pausa proprio perché un umano tornerà con calma: `status`
  e HUD mostrano l'età ma mai `STALE`, e l'avviso di `SessionStart` (`session-waiting`) dice
  di leggere `ESCALATION.md` e fare `resume`, non di prenderlo in mano.
- **`status` mostra "da quanto".** Riga `last fire: 20h43m ago (2026-09-06 11:10 UTC)  STALE`
  oltre la soglia (2 h, `OMC_LOOP_STALE_MS`: un passo `high` con subagent e una suite lunga
  può tenere aperto un turno oltre l'ora, e un falso STALE è una domanda inutile all'utente),
  con il suggerimento di cosa fare. La HUD aggiunge `⏱20h43m STALE` in rosso; sotto i dieci
  minuti non mostra nulla, perché un loop vivo merita una statusline silenziosa. Un loop morto da una notte e uno che ha appena
  delegato la review erano indistinguibili a colpo d'occhio.
- **Il journal registra il buco.** Al primo fire dopo un silenzio oltre soglia l'hook scrive
  `{type:'gap', since, ms, paused}`; `history` lo stampa (`GAP: no fire for 20h43m`, con
  `while paused` se il silenzio era una pausa voluta) e `summary.json` lo conserva (`gaps`,
  `lastFireAt`). Prima: 17 transizioni pulite seguite da
  un disarm senza motivo.
- **`disarm` risponde a "aveva finito?".** Prima di archiviare stampa task, fase, iterazioni,
  passi fatti/aperti (con i titoli dei primi aperti) e l'età dell'ultimo fire.

Non fatto, per scelta: la notifica desktop "il loop tace da N ore" e il controllo di
`~/.perseveranza/` da altri progetti (proposta 5). Il caso coperto è quello in cui l'utente
torna; un cron o un `status --all` restano possibili sopra `core/staleness.mjs`.

## 2.1.0

Nasce da un run reale di 14 ore su un progetto con una suite da 27 minuti: il lavoro era
riuscito (tre difetti veri intercettati dalle review), ma il 40% del wall-clock era la
stessa suite eseguita ~12 volte per lo stesso diff, dall'executor, dal reviewer, dal fix e
dalla ri-review, mentre il verbo `test` ne aveva registrate 3. Il rigore del gate non
cambia: cambia quante volte si paga la stessa prova.

- **`test --if-needed`: la suite gira una volta per albero.** Se esiste un run verde con la
  stessa impronta del working tree, il verbo non rilancia nulla, aggiorna la prova
  all'iterazione corrente e lo dice (`green reused` nel journal). Il `claim-done` accetta
  un verde di un'iterazione precedente quando l'impronta coincide ancora: l'impronta è
  una prova più forte del numero di iterazione. Prima claim-done e cleanup pretendevano un
  run nuovo anche a codice identico.
- **La documentazione non fa scadere la prova.** Accanto all'impronta completa il verbo
  registra un'impronta del solo codice (esclusi `*.md`, `docs/`, `LICENSE*`,
  `CHANGELOG*`...). Se da un verde è cambiata solo la documentazione, `--if-needed` non
  rilancia la suite e il claim è accettato con `test-proof=docs-only` nel journal. Nel run
  di riferimento il cleanup aveva imposto una suite intera per due file markdown.
- **Ogni fase riceve la "prova dei test".** Gli hint `hint-test-green` / `hint-test-none`
  dicono a Claude se il verde registrato vale ancora per l'albero attuale, di non rilanciare
  la suite e di dirlo ai subagent; i prompt di `pf-executor`, `pf-reviewer` e `pf-verifier`
  chiedono test mirati e vietano la suite intera, perché un run fuori dal verbo non prova
  nulla al loop. `{{testRun}}` usa `--if-needed` ovunque.
- **Il verdetto consumato resta leggibile.** `review.json` / `verify.json` sono rinominati
  in `review-<n>.json` / `verify-<n>.json` (effetto `keepArtifact`) invece di essere
  cancellati; l'istruzione di fix indica il file (`hint-verdict-file`) e l'evento `verdict`
  del journal porta i findings (`details`). Prima la fase di fix aveva solo i conteggi e
  doveva risvegliare il reviewer per farsi rimandare l'elenco.
- **Uno stop senza modifiche non avanza di fase.** L'hook calcola l'impronta a ogni fire e
  la confronta con quella dello stop precedente (`state.tree`). In `implement`, albero
  identico e nessun test registrato → esito `idle`, istruzione `implement-idle`, una volta
  sola; poi la review procede comunque. Prima un turno chiuso con l'executor ancora in
  esecuzione contava come "implementato" e la review era di niente.
- **Test falliti registrati, rosso non riproducibile segnalato.** Il verbo `test` cattura
  l'output (echo dal vivo), estrae i nomi dei test falliti (pytest, TAP, node:test/jest,
  go, cargo) in `lastTest.failed`, e se sullo stesso albero un rosso diventa verde, o
  falliscono test diversi, lo annota come `FLAKY` nel journal e a schermo. Nel run di
  riferimento due suite intere sono andate a due test che contano battiti con la CPU al
  100% per un client di sync.
- **Provider: timeout spiegato e ritentato, raggiungibilità all'arm.** `ETIMEDOUT` di una
  CLI diventa "timeout after Ns (raise it with OMC_ASK_TIMEOUT_MS or providers.timeouts.<id>)";
  timeout ed errori di rete sono ritentati `OMC_ASK_RETRIES` volte (default 1, mai per un
  exit code o un rifiuto). `providers check` e `arm --check` registrano l'esito in
  `providers.lastCheck` e `arm` riporta chi ha risposto all'ultimo check, chi ha fallito e
  chi non è mai stato provato: "rilevato" significava installato, e nel run di riferimento
  dei 4 annunciati ne aveva risposto 1. Con `--check` i provider sono provati subito, in
  parallelo, e quelli morti sono scartati per il run e disabilitati nel config.
- Il bug di `ask ollama-cloud` con il modello passato come `glm-5.3#low` (HTTP 404) era
  della 2.0.0 ed è già risolto dalla 2.0.1: il nome inviato è quello prima del `#`.

## 2.0.2

Due passate di review sulla 2.0.1: una locale di Codex (`docs/CODE-REVIEW-2026-09-05.md`),
concentrata sulle garanzie di completamento, e una seconda lettura di quel diff. Nessuna
nuova funzionalità: solo casi in cui il loop diceva una cosa e ne faceva un'altra.

- **La chiusura git non si conferma più senza prove leggibili.** Una deadline esaurita
  durante `rev-parse` veniva letta come "non è un repo" e il progetto si chiudeva; un
  `git status` fallito passava per working tree pulito; un `rev-list` fallito per zero
  commit da pubblicare. Ora ogni fatto vale solo dopo una query git riuscita, il push deve
  riuscire oltre a lasciare HEAD allineato, e un errore di staging o di esclusione di
  `.omc-loop` ferma tutto prima del commit. Se `git commit` fallisce, l'ultima riga del
  suo stderr (identità sconosciuta, hook, indice bloccato) arriva nella notifica e in
  `ESCALATION.md`: prima si leggeva solo "commit non verificato".
- **Impronta del working tree rifatta.** Quella vecchia era il diff rispetto a HEAD più
  l'elenco dei nomi non tracciati: cambiare il contenuto di un file già nuovo non la
  toccava, due modifiche binarie potevano coincidere, due alberi puliti su commit diversi
  davano la stessa impronta. La nuova combina indice, diff binario e contenuto dei file non
  tracciati (percorsi NUL-delimited, lettura a blocchi entro la deadline dell'hook).
  Un run armato con la vecchia impronta chiede un nuovo test verde al primo `claim-done`.
- **Impronta non ricalcolabile ≠ codice cambiato.** Se l'hook non riesce a ricalcolare
  l'impronta entro la deadline (tipicamente directory grandi non ignorate da git), il claim
  è rifiutato con l'esito `claim-unverifiable` e la chiave `claim-unverifiable-tree`, che
  dice a Claude che NON è una modifica del codice e lo manda a sistemare `.gitignore`.
  Prima passava per `claim-stale` e Claude rilanciava la suite a vuoto fino a esaurire il
  budget.
- **Verdetti malformati non promuovono più.** Un `review.json`/`verify.json` illeggibile
  lasciava valido un `report pass` precedente; `Number(blocking)` trasformava `null`,
  `false`, `""` e `[]` in zero. Ora un artefatto malformato annulla il report precedente e
  segue il percorso "missing"; `blocking` deve essere un intero JSON non negativo.
- **Archivio fallito = niente si perde.** I percorsi di chiusura cancellavano `.omc-loop`
  anche se l'archiviazione era fallita. Ora i file restano, `state.json` diventa
  `state.disarmed.json` (hook dormiente), `status` spiega il recupero, `disarm` ritenta
  conservando l'esito originale, `arm` rifiuta di sovrascrivere anche con `--force`.
  Le cartelle di archivio sono univoche (`mkdtemp`); tra volumi la copia deve completarsi
  prima di pubblicare `summary.json` e rimuovere gli originali; le copie parziali non
  compaiono in `runs list`.
- **Rename bloccata su Windows.** La prima versione del punto sopra ricadeva sulla copia
  solo con `EXDEV`. Su Windows `renameSync` di una cartella con un file aperto dentro
  fallisce con `EPERM` (verificato): un antivirus, l'indexer o un client di sync come
  Google Drive facevano fallire l'archivio a fine run e bloccavano `arm` finché non si
  faceva `disarm` a mano. Ora `EPERM`/`EBUSY`/`EACCES` ricevono qualche retry breve e poi
  la stessa copia; se la copia è completa ma gli originali bloccati non si cancellano, il
  run è pubblicato una volta sola, `state.json` viene rimosso e il resto resta come residuo
  innocuo (`leftover` nel risultato) invece di un run "da recuperare" che al retry si
  duplicherebbe.
- **Stato danneggiato non interrompe più l'hook**: contenitori di tipo sbagliato
  (`options: null`, `counters: "x"`) vengono sostituiti dai default invece di far sollevare
  `normalizeState`, che nel catch esterno lasciava fermare Claude col loop armato.
- **`hud off` non cancella più una statusline estranea**: riconosce solo il proprio
  wrapper, preserva byte per byte le configurazioni altrui, ripristina l'intero oggetto
  originale (anche `padding`) ed è idempotente; `settings.json` malformato produce un
  errore senza sovrascrittura.
- **Provider isolati per invocazione**: `grok`, `cursor` e `claude` girano in una directory
  vuota creata con `mkdtempSync` a ogni chiamata e rimossa nel `finally`, invece della
  temp condivisa.

## 2.0.1
- **Reasoning per modello su `ollama-cloud`**: ogni voce di `OLLAMA_MODEL` (o di
  `ollama.model` nel config) può portare lo sforzo di ragionamento dopo un `#` —
  `glm-5.3#low,deepseek-v4-flash:0731#none` — inoltrato all'API come parametro `think`.
  Il separatore è `#` e non `:` perché i due punti separano già il tag ollama
  (`deepseek-v4-flash:0731`). Senza `#` il campo non viene inviato affatto e vale il
  default del modello, quindi le config esistenti non cambiano comportamento. Serviva
  perché il default non è sempre quello giusto: su `glm-5.3` disattivare il reasoning non
  lo spegne, lo riversa nel `content` (259 token contro 4), mentre `deepseek-v4-flash`
  con reasoning spento risponde pulito e nella metà del tempo. Un valore non riconosciuto
  è rifiutato in locale con un messaggio esplicito, senza spendere la chiamata, come già
  accade per un `OLLAMA_HOST` non valido; `providers list` mostra i modelli configurati
  e il loro sforzo. Il nome del file dell'opinione include lo sforzo, così lo stesso
  modello interrogato a due livelli produce due artefatti distinti.
- **Test ermetici rispetto all'ambiente**: `test/helpers/cli.mjs` elenca le variabili che lo
  strumento legge (`OWN_ENV_VARS`) e le cancella dall'ambiente ereditato prima di comporre
  quello del progetto di prova; le rimette solo il test che le vuole. Prima la suite ereditava
  la shell di chi la lanciava, quindi passava in CI (ambiente nudo) e falliva su una macchina
  vera con `OLLAMA_API_KEY` esportata; peggio, un test che avesse dimenticato di impostare
  `CLAUDE_CONFIG_DIR` avrebbe scritto nel vero `~/.claude`.
- **Italiano di default** nelle istruzioni iniettate: `packs/it.json` è il livello attivo
  quando nessuno specifica altro. Precedenza: `--lang` all'arm > `PERSEVERANZA_LANG` >
  `"lang"` in `~/.perseveranza/config.json` > `it`. Nessuna lettura della locale della
  shell (`LANG`/`LC_ALL`): la lingua non cambia a seconda del terminale da cui parte la
  sessione. Per l'inglese: `--lang en` o `"lang": "en"` nel config. I default in
  `src/core/prompts.mjs` restano in inglese (sono la base che i pack sovrascrivono).
- **README come pagina di presentazione** (it e en): avvio in 30 secondi, il perché, come
  funziona, le garanzie, i comandi; i dettagli tecnici restano nei docs.

## 2.0.0
- **Riscrittura da zero** secondo `docs/PIANO-V2.md`, nata dalla rilettura della 1.19.0.
  Stessi principi (hook dormiente, anello chiuso, prove non parole, gate severo, zero
  dipendenze), struttura nuova. Compatibile: stesso `.omc-loop/`, stessi verbi, stato 1.x
  migrato al primo Stop.
- **Core puro + shell** (`src/core/`, `src/shell/`): `step(state, event, ctx)` restituisce
  stato ed **effetti** dichiarativi; l'hook li esegue. Il routing è una **tabella** di dati
  (`explain`, riprodotta nei README con un test). Il core ha unit test senza processi.
- **Stato v2** raggruppato per proprietario (`counters`, `limits`, `signals`, `flags`,
  `owner`, `usage`), `schemaVersion`, migrazione dalla v1.
- **Journal JSONL** al posto di `history.log`; a fine run `.omc-loop/` viene **archiviata**
  in `~/.perseveranza/runs/` con `summary.json` (anche su disarm, kill e budget) invece di
  essere cancellata. Verbi `history`, `runs`.
- **Deadline unica dell'hook**: `hooks.json` a 120 s, git dentro la deadline (push 45 s).
  Nella v1 il timeout di 20 s era più corto del solo push (60 s): l'hook poteva morire a
  metà chiusura lasciando il loop armato.
- **Budget a token reali** (`--budget-tokens`) letti dalla trascrizione, best-effort;
  iterazioni adattive dal piano (`8 + 3 × step`) quando `--max` non è esplicito; margine
  di 3 iterazioni sulla rampa di uscita.
- **Retry onesti**: `maxRetries` = fix concessi davvero (la v1 mostrava "2/3" e poi
  pausava). **Esito mancante = bocciatura** anche in review (la v1 promuoveva).
  **Verdetti con schema**: malformato → mancante; se verdetto e findings non concordano
  vince la lettura più severa.
- **`arm` rifiuta** se già armato (`--force`); il verbo `test` registra un'impronta del
  working tree e un `claim-done` dopo altre modifiche è rifiutato come stantio.
- **Provider**: `providers check` prova la vita e popola la denylist con motivo e data;
  timeout per provider nel config.
- **Lingua**: codice, CLI e prompt in inglese; `packs/it.json` copre tutte le istruzioni
  (`--lang it`, `PERSEVERANZA_LANG`, `lang` nel config, locale); README bilingue.
- **Test** su `node:test` in quattro livelli (unit, verbi, e2e con remoto git locale,
  packaging) e **CI** su Ubuntu/macOS/Windows × Node 20/22. `manifest.mjs` unico elenco
  dei file distribuiti, usato da `install.mjs` e dai test.
- **Rimosso**: le guardie sul limite di contesto basate su campi non documentati del
  payload (ora si loggano le chiavi ricevute), il mini framework di test, la lista file
  triplicata in `install.mjs`, le chiavi `review-advance-no-outcome` e
  `verify-failed-no-outcome`. Nuova chiave: `claim-stale-test`.
- **Bench**: il runner verifica il motore ≥ 2.0.0, supporta N ripetizioni per generazione
  e un `--dry-run` per la CI.

## 1.19.0
- **Prime guide adottate dall'esperimento SIA** — il cerchio si chiude: un loop
  self-improving ([SIA](https://github.com/hexo-ai/sia) sul nostro `bench/`) ha misurato
  i prompt default (baseline 0.7369) e la sua mutazione vincente (gen_2 del run 4, score
  0.9437: test nascosti 3/3, chiusure autonome 3/3, ~6 iterazioni/task) e' stata giudicata
  a mano e adottata. Tre chiavi ritoccate in `prompts.mjs`, tutte AGGIUNTE attorno ai
  verbi operativi (mai rimosso nulla):
  - `plan-write`: non frammentare in micro-step i cambiamenti coesi (ogni step apre un
    giro di review) + valutare la complessita' con onesta' (una modifica piccola e isolata
    e' spesso `low`, non `medium` per default);
  - `implement-first`: coprire TUTTO cio' che lo step promette, inclusi i casi limite
    gia' scritti in specifica/commenti — una review che trova un caso mancante costa un
    giro intero (era esattamente la debolezza misurata nel run 1: spec sotto-implementata
    con verifica passata);
  - `review-advance`: a piano completo, PRIMA il verbo `test` per la prova verde fresca e
    NELLA STESSA RISPOSTA il `claim-done` — elimina l'iterazione sprecata sistematica del
    claim rifiutato per prova non fresca.
  *Perche' fidarsi:* le tre idee reggono anche a prescindere dai numeri (N=1 per
  generazione); il controfattuale esiste — nel run 1 la mutazione libera che riscriveva i
  verbi era PEGGIORATA (0.53 -> 0.41), quella vincolata additiva e' migliorata (+28%).
- ⚠ **CORREZIONE (stesso giorno, prima del run di conferma):** l'esperimento sopra si e'
  rivelato **invalido**. Il plugin installato sulla macchina era la **1.12.0**, che ignora
  `.omc-loop/prompts.json`: il pack non e' mai stato letto dai loop, e il "+28%" veniva da
  un fix — legittimo e ben diagnosticato — del feedback agent al *harness* (`TIMEOUT_S`
  900→1800: i loop di gen_1 venivano uccisi a meta' dal timeout, non dai prompt). Le tre
  guide **restano** nei default come migliorie adottate per giudizio di merito, NON come
  provate dal bench. Lezione codificata: il runner ora **verifica la versione del motore**
  (>= 1.18.0 da `installed_plugins.json`, abort altrimenti) e la registra nella
  submission; adottato anche il timeout 1800 del feedback agent. Il run di conferma con la
  1.19.0 installata e' la prima misura valida.
- **Suite di regressione 64 → 65**: test che ancora le tre guide nelle istruzioni iniettate
  e verifica che i verbi operativi restino al loro posto.
- Cronaca completa dell'esperimento (4 run, 4 cause di guasto diverse, tutte codificate):
  `bench/README.md` e i commit `bench:`.

## 1.18.0
- **Prompt pack esternalizzato** — Fase 1 del progetto "SIA × perseveranza" (usare un loop
  self-improving per far evolvere i prompt del nostro, misurandoli su un benchmark con test
  nascosti). Utile anche da sola: A/B testing manuale delle istruzioni senza fork.
- **Nuovo `scripts/prompts.mjs`**: tutte le istruzioni di fase e gli hint vivono come template
  (`DEFAULT_PROMPTS`, placeholder `{{...}}`), estratti **fedelmente** dalle stringhe storiche;
  `loop-drive.mjs` li renderizza con `renderPrompt` e decide solo routing e variabili.
  Override: env `OMC_PROMPT_PACK` > `.omc-loop/prompts.json` > default. *Guardrail:* l'header
  HUD e' sempre anteposto dall'hook (un pack non spegne l'osservabilita'); chiavi ignote
  ignorate, placeholder ignoti restano letterali (typo visibile), JSON malformato → default con
  riga in `history.log`: l'hook non si rompe mai per un pack sbagliato. Il pack cambia *cosa si
  dice*, mai il routing.
- **Spike headless riuscito** (prerequisito del benchmark): `claude -p` in una directory armata
  percorre l'intero ciclo da solo — plan → implement → review → claim-done → verifica finale
  avversariale (verdetto in `verify.json`) → chiusura e disarm — con i plugin caricati e lo
  Stop hook a guidare le fasi in print mode. Misurare i loop e' quindi possibile.
- **Suite di regressione 61 → 64**: rendering puro (interpolazione, placeholder ignoto
  letterale, chiave ignota vuota), precedenza env>file e fallback su JSON rotto, e2e con
  override che cambia l'istruzione iniettata mantenendo header e routing.
- `install.mjs` copia/rimuove anche `prompts.mjs` (packaging manuale allineato al plugin).

## 1.17.0
- **Tre idee dal workflow di Kun Chen** (ex-L8 Meta/Microsoft/Atlassian, via David Ondrej +
  recap ByteByteGo) — notevole per quanto quel setup converge in modo indipendente col design
  del loop (step in contesto fresco, checker prima della PR, escalation solo su decisioni
  ambigue). Una feature e due integrazioni ai docs:
- **`--approve-plan`: gate umano sul piano.** Dopo la fase plan il loop si BLOCCA una volta
  sola con l'istruzione di presentare il piano all'utente in chat, poi va in pausa
  (`paused=true`); `resume` approva e avvia l'implementazione (prima si può editare
  `plan.md` a mano). Riusa pausa/resume esistenti: nessun verbo nuovo, nessuna fase nuova;
  campo `planPresented` per non ripetere il gate (i fix post-verifica che riaprono step non
  ripassano da qui). *Perché il blocco e non la sola pausa:* una pausa muta fermerebbe Claude
  senza spiegare nulla in chat; il blocco unico produce la sintesi del piano e la richiesta
  di approvazione, poi il loop tace. Default off, retro-compatibile.
- **Docs: più task in parallelo con git worktree.** Nuova sezione README: N worktree = N
  `.omc-loop/` indipendenti = N loop paralleli, gratis per costruzione (stato per-directory +
  claim-on-first-fire). Con le avvertenze oneste: upstream per branch (o `--no-push`), STOP
  selettivo vs `OMC_LOOP_KILL` globale, `.gitignore` committato, nomi di directory parlanti,
  task su aree diverse (i conflitti si spostano al merge, non spariscono).
- **Docs: la statistica del 68%.** Nel principio 2 ("gate di uscita severo") la misura di Kun
  Chen: il 68% delle modifiche passate dal suo `no-mistakes` conteneva bug da correggere
  prima della PR — conferma empirica, da un principal L8, del perché maker/checker e gate
  avversariale esistono.
- **Suite di regressione 59 → 61**: il gate `--approve-plan` end-to-end (blocco unico,
  pausa, silenzio in pausa, ripartenza post-resume senza ripetere il gate) e il default off.

## 1.16.0
- **Tre nuovi provider per il secondo parere: `grok`, `cursor`, `claude`** — il registro copre
  ora tutti i provider CLI dell'`ask` di OMC, più `ollama-cloud` che OMC non ha. Tre stili di
  invocazione, perché il vincolo di ogni CLI è diverso ma l'invariante è unico (il prompt non
  passa MAI da una shell):
  - `claude -p` — prompt su **stdin**, verificato empiricamente (2.1.212: risposta su stdout,
    exit 0). **cwd isolata obbligatoria** in tmpdir: nella dir del progetto un `claude -p`
    caricherebbe anche gli hook di perseveranza, e il suo Stop potrebbe rivendicare un loop non
    ancora rivendicato. ⚠ Stesso vendor della sessione principale: il parere vale come
    controprova a contesto pulito, non come diversità di modello (documentato ovunque;
    escludibile con la denylist `providers.disabled` della 1.15.0 — sinergia voluta).
  - `grok` / `cursor` (binario `cursor-agent`) — le loro CLI riservano stdin e vogliono il
    prompt come argomento: nuovo stile `argv()` **senza shell** (argv puri: nessun quoting
    possibile) con cwd isolata, così i flag di auto-approvazione headless
    (`--always-approve`, `--force --trust`) valgono per una directory temporanea vuota, mai
    per il repo. Invocazioni modellate su quelle testate da OMC; non verificate su questa
    macchina (CLI assenti): un errore resta un ERRORE onesto in artefatto, fail-soft come da
    design 1.15.0. Su Windows `argv()` richiede binari nativi: gli shim `.cmd` senza shell
    sono rifiutati da Node (EINVAL, CVE-2024-27980) → errore esplicito con hint, mai
    fallback via shell.
- **Suite di regressione 58 → 59**: registro dei tre provider (rilevamento, prompt ostile
  intatto come singolo elemento argv, cwd isolata fuori dal progetto).

## 1.15.0
- **Lezioni da un run reale** (gate finale di un task di hardening security): tutti e tre gli
  esterni fallirono per motivi non sostanziali — codex bloccato dal filtro di policy sul prompt
  "falsifica" a tema security; gemini morto a monte (`IneligibleTierError`, free tier dismesso);
  ollama-cloud in timeout a 180s su entrambi i modelli. Il loop chiuse correttamente sulla sola
  verifica interna (legittimo: il verdetto vincolante è `verify.json`) ma senza lasciarne traccia
  durevole. Da qui cinque interventi:
- **`agy` al posto di `gemini`** nel registro provider. `gemini` era rilevabile ma sempre morto a
  runtime (client free-tier dismesso). `agy` viene ora invocato **headless via stdin, senza flag**:
  dalla 1.1.x `-p ""` è rifiutato ("Error: empty prompt") e l'invariante resta che il prompt non
  tocca mai la command line. Verificato su Windows con la 1.1.3 (risposta su stdout, exit 0):
  il vecchio bug della print mode (gemini-cli#27466) non riguarda questa invocazione, quindi
  cade anche l'esclusione `win32`.
- **Denylist provider da config**: `{ "providers": { "disabled": ["..."] } }` in
  `~/.perseveranza/config.json` spegne un provider rilevabile ma inutilizzabile a runtime (tier
  dismesso, filtri aziendali) senza disinstallare nulla; mostrata da `config` e all'`arm`.
  *Perché:* `detect` prova solo che la CLI/chiave esista; un provider morto sprecherebbe un
  tentativo a ogni gate, per sempre.
- **Timeout dei pareri esterni configurabile**: `OMC_ASK_TIMEOUT_MS` (default 180 s, floor 1 s,
  validato — `askTimeoutMs`, stesso pattern di `parseTimeoutMs`). *Perché:* i prompt di
  falsificazione al gate (piano + diff) su modelli grossi superano legittimamente i 3 minuti;
  prima il tetto era cablato nel codice.
- **Nota durevole nel commit quando il gate resta "interno"**: se all'arm erano stati rilevati
  provider ma nessun artefatto `external-verify-*.md` risulta riuscito (o nessuno è stato
  registrato), il corpo del commit di chiusura dichiara «falsificazione esterna
  indisponibile/non registrata … il pass poggia sulla sola verifica interna», più marker in
  notifica e `history.log`. *Perché:* artefatti e log muoiono col disarm; come per
  baseline-dirty, la trasparenza deve sopravvivere in `git log`. Parser dei verdetti
  (`summarizeExternalOpinions`) in `util.mjs`: puro, testato in isolamento.
- **Framing anti-falso-rifiuto negli hint di fix e verifica**: il prompt agli esterni deve
  dichiarare il contesto legittimo (review difensiva del PROPRIO codice, progetto autorizzato) e
  un rifiuto di policy / errore / timeout del provider **non è un finding**: se nessun esterno
  risponde si prosegue col solo verdetto del subagent.
- **Suite di regressione 52 → 58**: denylist (`disabledProviders` + `detectAvailable`),
  `askTimeoutMs`, parser dei pareri, e tre e2e sulla nota nel commit (tutti falliti / uno ok /
  nessuno registrato).

## 1.14.0
- **Release di consolidamento da code review** — undici punti di una revisione, raccolti per
  tema. Nessun cambio al routing delle fasi: l'anello di stato resta identico, migliorano
  robustezza, chiusura git e copertura dei test.
- **Conteggio dei checkbox robusto e DRY** (`hud.mjs`: `countOpenSteps`/`countDoneSteps` ora
  esportati e usati anche da `loop-drive.mjs`). Il conteggio dei box di `plan.md` — che governa
  sia il gate del `claim-done` sia l'escalation — viveva come regex inline **duplicate**
  nell'hook. Ora è **un'unica fonte** in `hud.mjs`, robusta ai marker `-`/`*`/`+`, agli spazi
  dentro la casella (`- [x ]`) e che **ignora i checkbox nei fenced code block** (` ``` ` e
  `~~~`, anche non chiusi). *Perché:* un esempio markdown nel piano non deve poter falsare
  "quanti step restano", e la stessa logica non deve esistere in due copie che possono divergere.
- **Chiusura git più solida** — tre interventi su `gitFinish`/`arm`:
  - *Filtro `.omc-loop` rename-safe*: l'esclusione dello stato del loop dal commit fa match per
    **prefisso di path** (non più `includes` substring), con gestione dei rename `R old -> new`.
    *Perché:* un file come `src/omc-loop-helper.js` veniva scambiato per stato del loop e poteva
    far credere il working tree "pulito" quando non lo era.
  - *Flag `--no-push`* (stato `gitPush`, default `true`, retro-compatibile): a fine progetto
    committa in locale ma **non** pusha; la chiusura è confermata dal solo commit, senza pausa
    per upstream mancante. Con un upstream presente HEAD resta volutamente avanti — comunicato in
    notifica/log, non un errore. *Perché:* dove il push è manuale o protetto, il vecchio
    comportamento mandava sempre in pausa la chiusura.
  - *Avviso baseline-dirty durevole*: all'`arm` si registrano i file già modificati **prima** del
    task; poiché la chiusura fa `git add -A` e li include, un avviso onesto ("il commit può
    includere…") finisce nel **corpo del commit** (visibile per sempre in `git log`), oltre che in
    notifica/log. *Perché:* trasparenza, non prevenzione — niente stash o stage-selettivo (troppo
    rischio per un loop autonomo che non sa quali file il task ha davvero toccato), ma l'utente
    deve poterlo ricostruire a posteriori.
- **Robustezza dei sottosistemi di contorno:**
  - *Notifica con `pwsh`*: su Windows la notifica preferisce PowerShell 7+ (`pwsh`) se presente,
    altrimenti `powershell` (helper `resolvePowerShell()`).
  - *Timeout statusline configurabile e validato*: il timeout della statusline **base** è ora
    regolabile via `OMC_STATUSLINE_BASE_TIMEOUT_MS` (default 5s, ridotto da 8s, floor 1s) e
    **validato** — un valore non valido ricade sul default invece di far crashare il render;
    aggiunto `killSignal: 'SIGKILL'` per non lasciare appeso il processo base.
  - *Lock anti-race sul refresh aggiornamenti*: hook e statusline possono chiamare
    `maybeSpawnRefresh` quasi insieme; un **lock atomico** (`update-check.lock`, flag `wx`, stale
    60s) evita due refresh in parallelo e il figlio lo rilascia a fine fetch. Il refresh parte
    **solo** se `update.mjs` è l'entrypoint (guard `isMain`), non quando è importato. *Perché:* un
    `--refresh` di passaggio nell'argv di un altro script non deve innescare una fetch al load.
- **Suite di regressione 26 → 52** (`scripts/test.mjs`, sempre zero dipendenze): nuovi casi per il
  conteggio dei checkbox (marker, spazi, fence aperti/inline), per le funzioni pure di
  `providers.mjs`/`update.mjs` (`cmpSemver` ora esportata e testata sul confronto **numerico**, non
  lessicale) e una batteria **end-to-end della chiusura git** in repo temporaneo (commit+push,
  no-upstream→pausa, `--no-push`, filtro `.omc-loop` rename-safe, avviso baseline nel commit).
  *Perché:* le aree toccate da questa release erano esattamente quelle prima scoperte dai test.
- **Fix doc**: il commento d'intestazione di `install.mjs` cita ora l'**URL HTTPS completo**,
  coerente col README (la forma breve clona via SSH e fallisce dove non ci sono chiavi).

## 1.13.0
- **Budget, kill switch ed escalation espliciti** — tre idee importate dalla
  [loop-engineering](https://cobusgreyling.github.io/loop-engineering/), mappate sui meccanismi
  già presenti senza duplicarli.
- **Kill switch d'emergenza**: il file sentinella `.omc-loop/STOP` o l'env `OMC_LOOP_KILL=1`
  disarmano il loop al primo Stop. *Perché:* `disarm` richiede un comando node; serviva uno stop
  immediato, attivabile da editor e da **qualunque** sessione. Il check sta **prima** dello
  scoping per-sessione e dello sblocco stato-corrotto, così non esiste stato in cui il kill venga
  ignorato.
- **Handoff di escalation**: quando il loop esaurisce i retry (3 review fallite sullo stesso step
  o 3 verifiche finali bocciate) oltre alla pausa+notifica scrive `.omc-loop/ESCALATION.md` (fase,
  tentativi, ultimo test, cosa guardare, come ripartire). *Perché:* la pausa c'era già ma era
  muta; l'umano aveva poco con cui ripartire. `resume` rimuove l'handoff stantio.
- **Documentazione del budget**: nuovo [`docs/loop-budget.md`](docs/loop-budget.md) che raccoglie
  i tetti (proxy di budget = iterazioni `--max` + retry `--max-retries`, timeout, takeover) e gli
  interruttori in un punto solo. README: nuove sezioni "Budget e kill switch" e "Maturità del loop
  (L0→L3) e failure mode" (verifier theater / infinite loop / token burn e come sono mitigati).
- Nessuna modifica al routing delle fasi: l'anello di stato resta identico, si aggiungono solo una
  guardia di kill in testa all'hook e un artefatto alla pausa.
- **Suite di regressione** `scripts/test.mjs` (zero dipendenze, 26 casi): pilota l'hook con eventi
  finti e verifica le transizioni della macchina a stati + le novità. *Perché:* il repo non aveva
  test; ora ogni modifica al loop è verificabile con `node scripts/test.mjs`. Aggiunto l'interruttore
  `OMC_LOOP_NO_NOTIFY` per silenziare le notifiche desktop (test/headless/CI).

## 1.12.0
- **Scoping del loop per sessione** (claim-on-first-fire). `.omc-loop/state.json` è globale al
  progetto: senza scoping, **due sessioni** Claude aperte sullo stesso repo armato venivano
  pilotate **entrambe** dallo stesso loop. Ora il loop appartiene a **una** sessione: la prima
  che fa fire lo rivendica (`s.sessionId`, letto da `evt.session_id` del payload Stop); le altre
  **lasciano fermare Claude** senza toccare lo stato.
- **Takeover su inattività** del proprietario (`OMC_SESSION_TAKEOVER_MS`, default 6h): se la
  sessione che possiede il loop sparisce (chiusa/crashata), una nuova sessione subentra dalla
  **fase corrente** — niente loop congelato per sempre, niente lavoro perso, niente reset dei
  contatori. *Perché 6h:* finestra abbastanza lunga da non innescarsi mai tra sessioni davvero
  concorrenti (che fanno fire molto più spesso), abbastanza corta da non lasciare il loop morto.
- **Retro-compatibile**: se Claude Code non fornisce `session_id` (versioni vecchie o payload
  anomalo), niente scoping → comportamento identico a prima. Il blocco sta **prima** dei check
  di pausa/limite, così una sessione non-proprietaria non fa mai scattare disarm. Vedi
  `docs/REVIEW-NOTES.md` (nuova sezione "Scoping per-sessione").

## 1.11.3
- **Revert** della guardia `stop_hook_active` introdotta in 1.11.2: **congelava il loop**.
  Le continuazioni autonome del ciclo arrivano con `stop_hook_active=true`; fare *allow-stop*
  su `true` blocca l'avanzamento dopo il primo blocco (visto in un run reale: `iterations=1`,
  `claim-done` non consumato). Tornati al blocco incondizionato, con *allow-stop* solo nei
  casi davvero sicuri (limite di contesto, abort utente).
- **Diagnostica**: ogni invocazione dell'hook scrive in `history.log` una riga
  `FIRE sha=<stop_hook_active> reason=…`, per capire dai dati reali cosa invia Claude Code.
- ⚠️ **Lezione per i review**: in uno Stop hook che deve guidare un loop autonomo NON si fa
  allow-stop su `stop_hook_active`. Vedi `docs/REVIEW-NOTES.md`.

## 1.11.2 — revocata in 1.11.3
- Tentativo (errato) di sopravvivere alle interjezioni aggiungendo allow-stop su
  `stop_hook_active`. Regressione: vedi 1.11.3.

## 1.11.1
- Versione di perseveranza mostrata nella HUD (`⟳ PRS vX.Y.Z`) e nell'header iniettato,
  letta dal `plugin.json` installato.

## 1.11.0
- HUD agganciata a un **wrapper stabile** (`~/.perseveranza/statusline-hud.mjs`) che risolve
  la versione più recente del plugin: il path in `settings.json` non si rompe agli update
  (la cache del plugin è versionata, es. `.../1.10.0/...`).
- **Notifica nuova versione** (`update.mjs`), stile OMC: confronto con GitHub, cache
  giornaliera, refresh in processo distaccato (non rallenta hook/statusline); marker
  all'arm, nell'header e nella statusline.

## 1.10.0
- **HUD del progresso**: header compatto nell'istruzione iniettata + statusline live che si
  **compone** con la statusline esistente (es. OMC HUD) senza sostituirla. Nuovi
  `hud.mjs` (rendering condiviso) e `statusline.mjs`; verbo `hud on|off|status`.

## 1.9.1
- Fix da code review: `OLLAMA_MODEL` con sole virgole non produce lista vuota (fallback);
  host ollama **validato** prima di inviare la chiave; stdin letto solo se non TTY; helper
  condivisi (`argsAfterDoubleDash`, `fileSafe`).

## 1.9.0
- Chiave e modelli ollama da **file di config** `~/.perseveranza/config.json` (niente `setx`,
  nessun riavvio). Precedenza **env > file > default**. Verbo `config`. Aggiunto `.gitignore`.

## 1.8.0
- **ollama-cloud multi-modello**: `OLLAMA_MODEL` come lista separata da virgole → una sola
  `ask ollama-cloud` interroga tutti i modelli, un artefatto per modello. Default a `glm-5.2`
  (`qwen3-coder:480b` era di ~1 anno prima).

## 1.7.0
- **Registro provider centralizzato** (`providers.mjs`): unica fonte per rilevamento e
  invocazione dei modelli esterni. Verbo `ask` che **persiste** il parere in
  `.omc-loop/external-<slot>-*.md`. Provider `ollama-cloud` via API HTTP (chiave solo in
  env/file, mai su git). Invocazione CLI robusta su Windows: prompt via **stdin**, flag fissi.

## 1.6.0
- Chiusura più severa prima di commit+push: `claim-done` rifiutato se restano box `- [ ]`
  in `plan.md`; `gitFinish` **verifica davvero** commit e push (working tree pulito + HEAD
  non avanti all'upstream); se non confermato → fase `git-finish` in pausa, retry dopo
  `resume`.
