# Note per la code review

Invarianti e trappole del progetto. **Leggere prima di rivedere modifiche agli script.**
Lo storico delle decisioni è in `../CHANGELOG.md`.

## Contratto dello Stop hook (`scripts/loop-drive.mjs`)
- Deve restare **sincrono** e **non lanciare mai** eccezioni non gestite: un hook che
  crasha o pende blocca la fine-risposta di Claude.
- L'hook **possiede** `phase`, `iterations`, `retries`, `finalFails`. Claude comunica solo
  tramite i **verbi** (`omc-loop.mjs`) e gli **artefatti** (`review.json`/`verify.json`).
  Non editare `state.json` a mano dal lato Claude.
- Parsing di stato **tollerante**: default per ogni campo mancante, niente crash su stato
  corrotto (→ disarmo pulito + notifica).

## ⚠️ `stop_hook_active` — la trappola che ha causato una regressione
- Le **continuazioni autonome** del loop arrivano con `stop_hook_active=true`.
- **NON** fare allow-stop (`process.exit(0)` / `continue:true`) quando
  `stop_hook_active === true`: congela il loop dopo il primo blocco (regressione 1.11.2,
  revocata in 1.11.3). L'hook **blocca sempre**, tranne i casi sicuri sotto.
- Allow-stop SOLO per: **stop da limite di contesto** (altrimenti deadlock: non può
  compattare) e **abort utente**.
- I test di OMC che asseriscono "allow-stop su `true`" descrivono *output dato input*, non
  provano cosa Claude Code invii nelle continuazioni reali: non vanno presi come prova.
- Per diagnosticare: le righe `FIRE sha=…` in `history.log`.

## Scoping per-sessione (claim-on-first-fire)
- `.omc-loop/state.json` è **globale al progetto**: senza scoping, due sessioni Claude aperte
  sullo stesso repo armato verrebbero pilotate **entrambe** dallo stesso loop.
- Il loop appartiene a **una** sessione: la **prima** che fa fire lo rivendica (`s.sessionId`);
  le altre **lasciano fermare Claude** (`process.exit(0)`) senza toccare lo stato.
- `arm` **non** conosce il `session_id` (gira come processo a sé): la proprietà si stabilisce al
  primo fire dell'hook, che legge `evt.session_id` dal payload Stop. Se manca (versioni vecchie)
  → niente scoping, comportamento identico a prima.
- **Takeover** dopo lunga inattività del proprietario (`OMC_SESSION_TAKEOVER_MS`, default 6h):
  evita che una sessione chiusa congeli il loop per sempre. Il nuovo proprietario riparte dalla
  fase corrente — niente lavoro perso, niente reset dei contatori.
- Il blocco di scoping sta **prima** dei check di pausa/limite: una sessione non-proprietaria non
  deve mai far scattare disarm/pausa.

## "Prove, non parole"
- `claim-done` accettato solo con piano **interamente spuntato** (l'hook conta i box
  `- [ ]`) **e** un **test verde fresco** misurato dal verbo `test` (exit code reale,
  `iteration` corrente). Mai fidarsi di una dichiarazione.
- Il **conteggio dei box** è centralizzato in `hud.mjs` (`countOpenSteps`/`countDoneSteps`,
  esportati): **unica fonte**, usata sia dal gate del `claim-done` sia dall'escalation in
  `loop-drive.mjs` (niente più regex inline duplicate che possono divergere). Robusto ai marker
  `-`/`*`/`+`, agli spazi dentro la casella (`- [x ]`) e **ignora i checkbox nei fenced code
  block** (` ``` `/`~~~`, anche non chiusi fino a EOF): un esempio markdown nel piano non falsa
  "quanti step restano".
- I verdetti sono **artefatti** (`review.json`/`verify.json`) consumati **alla lettura**
  (un verdetto vecchio non si riusa mai).
- La chiusura git è verificata sui **fatti** (working tree pulito + HEAD non avanti
  all'upstream), non sugli exit code di commit/push.

## Chiusura git (`gitFinish` in `loop-drive.mjs`)
- Il filtro che esclude `.omc-loop/` dal commit fa match per **prefisso di path**, non
  `includes` substring: `src/omc-loop-helper.js` **non** è stato del loop (era un bug di
  `l.includes('.omc-loop')`). Gestisce anche i rename `R old -> new`, controllando entrambi i
  path della riga `--porcelain`.
- `--no-push` (`gitPush:false`): la chiusura è confermata dal **solo commit locale**; con un
  upstream presente **HEAD resta avanti di proposito** (`pushSkipped`/`ahead`) — è una scelta
  dell'utente, **non** un errore, e **non** manda in pausa la chiusura. Default `gitPush:true`
  (retro-compatibile: stato vecchio senza il campo → push).
- L'avviso **baseline-dirty** (file già sporchi all'`arm`, che il `git add -A` di chiusura
  include) va nel **corpo del commit** — durevole in `git log` — oltre che in notifica/log
  (effimeri e silenziabili in headless). Trasparenza, non prevenzione: niente stash o
  stage-selettivo (un loop autonomo non sa quali file il task ha davvero toccato).

## Sicurezza della chiave (ollama-cloud)
- `OLLAMA_API_KEY` solo in env o `~/.perseveranza/config.json`, **MAI** nel repo, negli
  artefatti `external-*.md` o nei log. Precedenza **env > file > default**.
- L'host viene **validato** (`http`/`https`) prima di inviare la chiave.

## Provider esterni (`scripts/providers.mjs`)
- Unica fonte di verità per rilevamento/invocazione/flag. Aggiungere un provider = una voce.
- Le CLI si invocano con il **prompt su stdin** + flag fissi (`shell:true` per i `.cmd` di
  npm su Windows): nessun input utente sulla command line → niente problemi di quoting o di
  `%` di cmd.exe.

## HUD / statusline (`scripts/statusline*.mjs`, `scripts/hud.mjs`)
- **Comporre, non sostituire**: `hud on` salva la statusline esistente come *base* e la
  richiama con lo stesso stdin.
- `settings.json` deve puntare al **wrapper stabile** (`~/.perseveranza/statusline-hud.mjs`),
  non alla cache versionata del plugin (si romperebbe a ogni update).
- La statusline deve restare **veloce**: niente lavoro pesante sincrono; il controllo
  aggiornamenti è in un processo distaccato.
- Il timeout della statusline **base** è configurabile (`OMC_STATUSLINE_BASE_TIMEOUT_MS`,
  default 5s, floor 1s) e **validato**: un valore non-intero/negativo passato a
  `spawnSync({timeout})` lancerebbe `ERR_OUT_OF_RANGE` → si ricade sul default invece di
  azzerare l'intera statusline. `killSignal:'SIGKILL'` per non lasciare appeso il processo base;
  il `try/catch` garantisce che una base che esplode non rompa mai il render.
- Il refresh aggiornamenti (`update.mjs`) parte **solo come modulo principale** (guard `isMain`):
  importato da hook/statusline/test **non** fa fetch al load, anche se `--refresh` capita
  nell'argv di un altro entrypoint. `maybeSpawnRefresh` usa un **lock atomico**
  (`update-check.lock`, flag `wx`, stale 60s) così hook e statusline non lanciano due refresh
  insieme; il figlio rilascia il lock a fine fetch.
- **Dormiente** fuori da un progetto armato (nessun segmento perseveranza).

## Packaging
- Ogni nuovo script in `scripts/` va aggiunto a `install.mjs` (copia **e** rimozione in
  `--uninstall`) e deve funzionare sia da plugin (`${CLAUDE_PLUGIN_ROOT}`) sia da install
  manuale (`~/.claude/hooks/`, dove `omc-loop.mjs` trova i sibling).
- Plugin e install manuale **non insieme**: due Stop hook avanzerebbero il loop due volte.

## Versionamento
- A ogni release: allineare `version` in `.claude-plugin/plugin.json` **e** il badge nel
  README. Le versioni vivono lì (niente tag git).
