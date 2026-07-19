# Changelog

Modifiche degne di nota, con il **perché** (non solo il cosa). La versione vive in
`.claude-plugin/plugin.json` e nel badge del README; non si usano tag git.

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
