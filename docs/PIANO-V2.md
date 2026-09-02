# Perseveranza v2 — piano per rifarlo da zero

Piano di riscrittura come lo imposterei io, partendo da un repo vuoto ma con l'esperienza
della v1 (1.19.0) alle spalle. Non è una lista di patch alla v1: è un disegno nuovo che
conserva le idee che hanno funzionato e cambia la struttura dove la v1 ha mostrato i limiti
(vedi la rilettura che precede questo documento).

## 1. Cosa tengo, cosa cambio

**Invarianti che restano** (sono il valore del progetto, non si toccano):

- Stop hook **dormiente**: non esiste finché non c'è `.omc-loop/state.json` nella cwd.
- **Anello chiuso**: il routing dipende dagli esiti, mai da una rotazione cieca delle fasi.
- **Prove, non parole**: i test li esegue lo script, i verdetti sono artefatti JSON scritti
  dai revisori e consumati alla lettura, la chiusura git è verificata sui fatti.
- **Gate di uscita severo** e ciclo interno economico.
- Zero dipendenze, solo Node (lo stesso runtime di Claude Code).
- Kill switch prima di qualsiasi altro controllo; scoping per sessione; budget di iterazioni.
- Prompt pack sovrascrivibile con l'header HUD fuori dai template.

**Cosa cambia strutturalmente**:

| v1 | v2 | perché |
|---|---|---|
| `loop-drive.mjs` esegue side effect mentre decide | **core puro** che restituisce `{state, effects}` + **shell** che li esegue | testabile senza processi, transizioni leggibili in un solo posto |
| `history.log` testuale, cancellato al disarm | **journal JSONL** append-only + **archivio del run** a fine progetto | l'audit trail è il prodotto di un run, non un residuo |
| budget = iterazioni | iterazioni **+ token reali** letti dalla trascrizione | il tetto di spesa smette di essere un proxy |
| timeout hook 20 s, push 60 s | **deadline unica** dell'hook, git dentro la deadline | l'hook non può più morire a metà chiusura |
| review senza esito → promossa | review senza esito → **bocciata** (come il gate finale) | coerenza col principio "prove, non parole" |
| `arm` sovrascrive sempre | `arm` **rifiuta** se armato, salvo `--force` | niente perdita silenziosa di un loop in corso |
| suite monolitica con mini framework | `node --test`, tre livelli (unit / verbi / e2e), **CI su 3 OS** | la promessa Windows/macOS/Linux diventa verificata |
| lista file duplicata in `install.mjs` | **manifest** unico usato da install, uninstall e test di packaging | un file nuovo non può più sfuggire al packaging |
| guardie sul payload dello Stop basate su campi ipotetici | solo campi **documentati** + log delle chiavi ricevute | niente codice morto, diagnosi empirica |
| tutto in italiano | codice, CLI e prompt in **inglese**, pack `it` incluso, README bilingue | un plugin pubblico si adotta se si legge; l'italiano resta di prima classe |

L'ultima riga è una scelta mia per un plugin pubblico: se il progetto resta personale,
si può ignorare senza toccare il resto del piano.

## 2. Decisioni di fondo

1. **Core puro, shell sottile.** `core/machine.mjs` espone `step(state, event, ctx)`.
   `ctx` porta solo dati già letti (testo del piano, verdetto, pack, ora corrente). Ritorna
   il nuovo stato e una lista di **effetti** dichiarativi: `block(reason)`, `allowStop`,
   `notify(title, msg)`, `dropArtifact(name)`, `gitFinish(opts)`, `archiveRun`, `disarm`,
   `writeEscalation`. La shell (`hook/stop.mjs`) legge stdin, carica il contesto, chiama
   `step`, esegue gli effetti in ordine e scrive l'output. Il core non importa `node:fs`.
2. **Tabella di transizione esplicita.** Una mappa `fase × esito → (fase, azione)` in
   `core/transitions.mjs`, letta dal core e stampata dal verbo `explain`. Le eccezioni
   (claim-done, approvazione del piano, git-finish) restano codice, ma la parte regolare è
   una tabella che il README può riprodurre alla lettera con un test che li tiene allineati.
3. **Stato versionato.** `schemaVersion: 2`, con `migrate(v1State)` per chi aggiorna a loop
   armato (stesso path `.omc-loop/`, stessi nomi dei verbi: il comando `/perseveranza`
   della v1 continua a funzionare).
4. **Journal invece di log.** `.omc-loop/journal.jsonl`: una riga per evento (fire,
   transizione, verdetto letto, test registrato, parere esterno, usage token). `history.log`
   diventa una vista renderizzata dal verbo `history`.
5. **Archivio del run.** A fine progetto, prima del disarm, `.omc-loop/` viene spostata in
   `~/.perseveranza/runs/<progetto>/<timestamp>/` con un `summary.json` (esito, iterazioni,
   token, verdetti, note). Le note nel corpo del commit restano, ma non sono più l'unica
   memoria.
6. **Deadline dell'hook.** `hooks.json` dichiara 120 s; la shell riceve la deadline e ogni
   spawn (git, notifica, controllo aggiornamenti) prende il tempo residuo, mai un timeout
   proprio più lungo. Il push ha un tetto di 45 s; se non basta, la chiusura va in
   `git-finish` in pausa con il motivo, come oggi, ma per decisione e non per kill.
7. **Retry onesti.** `maxRetries` = numero di **fix concessi**: con 3 si vedono "tentativo
   1/3, 2/3, 3/3" e la pausa arriva al quarto fallimento. Stessa regola per il gate finale.
8. **Verdetti con schema.** `review.json` e `verify.json` sono validati (campi, tipi,
   severità ammesse). Un file malformato viene loggato nel journal con l'errore e trattato
   come esito mancante; l'esito mancante è sempre bocciatura, in review come al gate.
9. **Budget reale.** Il payload dello Stop porta `transcript_path`; la shell somma
   `input_tokens`/`output_tokens` dei messaggi dell'assistente dall'ultimo fire e li scrive
   nel journal. `--budget-tokens N` ferma il loop come `--max`. Da verificare il formato
   della trascrizione al primo giorno: se non è stabile, il campo resta opzionale e il
   budget torna a iterazioni senza rompere nulla.
10. **Provider esterni con prova di vita.** Registro come in v1, più il verbo
    `providers check` che manda un prompt banale a ogni provider rilevato e segna nel
    config quelli morti (la denylist si popola da sola, con data e motivo).

## 3. Layout del repository

```
perseveranza/
  .claude-plugin/plugin.json, marketplace.json
  hooks/hooks.json                       Stop -> node hook/stop.mjs  (timeout 120)
  commands/perseveranza.md               invariato nei verbi, generato in parte dalla tabella
  agents/pf-reviewer.md, pf-verifier.md, pf-executor.md
  src/
    core/
      machine.mjs        step(state, event, ctx) -> { state, effects }
      transitions.mjs    tabella fase x esito
      state.mjs          default, validazione, migrate v1 -> v2
      verdicts.mjs       parse + schema di review.json / verify.json
      plan.mjs           conteggio checkbox (ex hud.mjs), robusto ai fence
      prompts.mjs        DEFAULT_PROMPTS (en) + render + override
      budget.mjs         iterazioni, token, retry: una sola funzione "canContinue"
    shell/
      stop.mjs           adapter dell'hook: stdin -> ctx -> step -> effetti -> stdout
      effects.mjs        esecutori degli effetti (fs, git, notify, archive)
      git.mjs            add/commit/push con deadline e verifica sui fatti
      journal.mjs        append JSONL + lettura
      transcript.mjs     usage token dalla trascrizione (best-effort)
      notify.mjs         desktop cross-platform, silenziabile
    cli/
      omc-loop.mjs       i verbi (arm, report, test, claim-done, ...), parsing argv
      verbs/*.mjs        un file per verbo
    providers/
      registry.mjs       PROVIDERS (cli/http), detect, ask, check
      config.mjs         ~/.perseveranza/config.json, effectiveEnv
    hud/
      render.mjs, statusline.mjs, resolver.mjs
    update.mjs
  packs/it.json          prompt pack italiano (override completo dei default)
  manifest.mjs           elenco dei file distribuiti: usato da install.mjs e dai test
  install.mjs            installazione manuale, guidata dal manifest
  test/
    unit/                core puro: node --test, nessun processo
    verbs/               CLI in cartelle temporanee
    e2e/                 hook pilotato con eventi finti via stdin, git finish su remoto locale
    packaging/           manifest vs filesystem, hooks.json vs file reali
  bench/                 come oggi, con guard di versione e ripetizioni per generazione
  docs/                  README.md (it), README.en.md, REVIEW-NOTES.md, loop-budget.md, CHANGELOG.md
  package.json           "test": "node --test test/", engines node >= 20
  .github/workflows/ci.yml   ubuntu + macos + windows, node 20 e 22
```

## 4. Stato v2

```json
{
  "schemaVersion": 2,
  "task": "…",
  "phase": "plan | implement | review | cleanup | final-verify | git-finish",
  "complexity": "low | medium | high",
  "options": { "commitSteps": false, "gitFinish": true, "gitPush": true,
               "approvePlan": false, "testCmd": null, "externals": [] },
  "counters": { "iterations": 0, "retries": 0, "finalFails": 0 },
  "limits":   { "maxIterations": 25, "maxRetries": 3, "maxTokens": null },
  "usage":    { "inputTokens": 0, "outputTokens": 0 },
  "signals":  { "lastReport": "none", "claimedDone": false, "paused": false },
  "flags":    { "repeated": false, "cleanedOnce": false, "planPresented": false },
  "lastTest": null,
  "baselineDirty": [],
  "owner": { "sessionId": null, "lastFireAt": 0 },
  "armedAt": "ISO", "engineVersion": "2.0.0"
}
```

Raggruppare i campi per proprietario rende esplicito il contratto della v1: `counters`,
`flags`, `phase` e `owner` li scrive solo l'hook; `signals` e `lastTest` solo i verbi;
`options` e `limits` solo `arm`. Il verbo `status` mostra una sintesi leggibile, non il JSON.

## 5. Tabella di transizione

| fase | esito letto | nuova fase | azione |
|---|---|---|---|
| plan | nessun piano | plan | `plan-write` (una sola ripetizione, poi implement) |
| plan | piano presente, `approvePlan` non ancora presentato | plan (pausa) | `plan-approval`, notifica |
| plan | piano presente | implement | `implement-first` |
| implement | — | review | drop `review.json`, `review-delegate` |
| review | blocking = 0 | implement | retries = 0, `review-advance` |
| review | blocking > 0, retries < max | implement | retries++, `review-fix` (diagnosi esterna dal 2°) |
| review | blocking > 0, retries = max | pausa | escalation |
| review | esito mancante | review | `review-missing-outcome` una volta, poi **bocciatura** |
| any + claim-done | step aperti | invariata | `claim-open-steps` |
| any + claim-done | nessun test verde fresco | invariata | `claim-no-fresh-test` |
| any + claim-done | prima volta | cleanup | `cleanup` |
| any + claim-done | già ripulito | final-verify | drop `verify.json`, `final-verify` |
| cleanup | — | final-verify | `final-verify` |
| final-verify | pass | git-finish → done | commit+push con deadline, archivio, disarm, notifica |
| final-verify | fail, finalFails < max | implement | finalFails++, `verify-postfix` |
| final-verify | fail, finalFails = max | pausa | escalation |
| final-verify | esito mancante | final-verify | una richiesta, poi bocciatura |
| git-finish | resume | git-finish → done | ritenta la chiusura |
| qualsiasi | budget esaurito (iterazioni o token) | disarm | notifica, archivio |
| qualsiasi | STOP file / `OMC_LOOP_KILL` | disarm | prima di ogni altro controllo |

La tabella è un dato: `explain` la stampa, un test la confronta col README.

## 6. Verbi

Gli stessi della v1 (`arm`, `report`, `complexity`, `test`, `ask`, `claim-done`, `pause`,
`resume`, `status`, `config`, `hud`, `disarm`) più:

- `arm --force`: l'unico modo di sovrascrivere un loop armato.
- `arm --budget-tokens N`: tetto di token oltre alle iterazioni.
- `history [--tail N]`: journal in forma leggibile (sostituisce la lettura di history.log).
- `explain`: tabella di transizione e fase corrente con i prossimi esiti possibili.
- `providers check`: prova di vita dei provider, aggiorna la denylist con motivo e data.
- `runs [list | show <id>]`: archivio dei run passati.
- `prompts validate [file]`: verifica un pack (chiavi note, placeholder esistenti).

Il parsing degli argomenti usa `util.parseArgs` di Node, non un ciclo a mano.

## 7. Gate e prove

- **Claim-done**: piano interamente spuntato + test verde con `iteration` corrente. Aggiunta:
  il verbo `test` registra anche l'hash del `git diff` al momento del run; se al claim il diff
  è diverso, il test è "verde ma stantio" e viene rifiutato con un messaggio che lo dice.
- **Verdetti**: schema in `core/verdicts.mjs`; severità ammesse `critical | warning |
  suggestion`; `blocking` deve essere coerente col numero di `critical` (se non lo è, vince il
  conteggio dei critical e il journal registra la discrepanza).
- **Esito mancante**: sempre bocciatura dopo una richiesta, in ogni fase.
- **Retry**: `maxRetries` fix concessi davvero (vedi decisione 7).

## 8. Chiusura e archivio

1. `git add -A`, `git reset -- .omc-loop`, commit con corpo che include baseline-dirty e nota
   sul gate esterno, come oggi.
2. Push entro il tempo residuo della deadline; verifica sui fatti (working tree pulito,
   HEAD non avanti all'upstream).
3. `archiveRun`: sposta `.omc-loop/` in `~/.perseveranza/runs/<progetto>/<ts>/`, scrive
   `summary.json`. Se lo spostamento fallisce, si ricade sul disarm della v1 e il journal lo
   dice: l'archivio è un di più, la chiusura no.
4. Notifica.

## 9. Budget e osservabilità

- `core/budget.mjs`: una sola funzione `canContinue(state)` che considera iterazioni, token e
  la fase (la rampa di uscita ha diritto a un margine di 3 iterazioni oltre `--max`, così un
  loop che ha finito il lavoro non muore a un passo dalla verifica).
- Budget adattivo opzionale: se `--max` non è esplicito, dopo la scrittura del piano
  `maxIterations = min(60, 8 + 3 × step)`.
- L'header iniettato mostra iterazioni, token spesi e tetti; la statusline gli stessi dati.
- Il journal registra per ogni fire le chiavi del payload ricevuto (non i valori), così le
  guardie sul payload si scrivono su evidenza.

## 10. Provider esterni

Registro identico nello spirito (cli / http, prompt mai da shell, cwd isolata per le CLI che
auto-approvano), con tre aggiunte: `providers check`, un timeout per provider nel config, e
il salvataggio dei pareri nel journal oltre che nei file `external-*.md` (che così finiscono
nell'archivio del run).

## 11. Test e CI

- **unit** (`test/unit/`): il core con `node --test`, centinaia di casi in meno di un secondo.
  Ogni riga della tabella di transizione ha un test generato dalla tabella stessa.
- **verbs**: ogni verbo in una cartella temporanea, come oggi.
- **e2e**: l'hook pilotato con eventi finti, un remoto git locale per la chiusura, un pack di
  override che cambia l'istruzione. Meno test di oggi, perché il routing è già coperto a
  livello unit.
- **packaging**: il manifest corrisponde al filesystem, `hooks.json` punta a file esistenti,
  `install.mjs` copia e rimuove esattamente il manifest.
- **CI**: matrice ubuntu / macos / windows × Node 20 / 22, più un job che esegue il bench in
  modalità "dry" (senza `claude`) per verificare runner ed evaluator.

## 12. Packaging, compatibilità, migrazione

- Plugin come canale principale; installazione manuale guidata dal manifest.
- `.omc-loop/` e i verbi restano gli stessi: il comando `/perseveranza` v1 funziona sulla v2.
- Uno stato v1 trovato dall'hook viene migrato in memoria e riscritto in v2 al primo fire, con
  una riga nel journal.
- `packs/it.json` ha la stessa copertura dei default inglesi e un test che lo garantisce.

## 13. Milestone

| # | milestone | deliverable | criterio di done | stima |
|---|---|---|---|---|
| M0 | Fondamenta | repo, `package.json`, CI, `node --test`, manifest, layout | CI verde su 3 OS con un test vuoto | 1 g |
| M1 | Core puro | `machine`, `transitions`, `state`, `plan`, `verdicts`, `budget` | tutte le righe della tabella coperte da unit test | 3 g |
| M2 | Shell + hook | `stop.mjs`, `effects`, `journal`, `notify`, `hooks.json` | e2e: plan → implement → review → fix → advance con eventi finti | 2 g |
| M3 | Verbi | `omc-loop.mjs` con `parseArgs`, `arm --force`, `status`, `history`, `explain` | test dei verbi verdi; `/perseveranza` v1 funziona | 2 g |
| M4 | Rampa di uscita | cleanup, final-verify, `git.mjs` con deadline, archivio del run | e2e su remoto locale: push confermato, pausa se manca l'upstream, archivio scritto | 2 g |
| M5 | Budget e HUD | `transcript.mjs`, `--budget-tokens`, header con token, statusline, `runs` | journal con usage per fire; stop per budget testato | 2 g |
| M6 | Provider | registro, `ask`, `providers check`, denylist automatica | test del registro; check simulato con CLI finte | 1 g |
| M7 | Prompt pack e agenti | default en, `packs/it.json`, `prompts validate`, agenti pf-* | test di copertura del pack; e2e con override | 1 g |
| M8 | Docs e release | README it/en generato in parte dalla tabella, REVIEW-NOTES, CHANGELOG, migrazione v1 | un run reale su un repo di prova su ogni OS | 2 g |
| M9 | Bench | port del runner con guard di versione e N ripetizioni per generazione | baseline misurata con N = 3 | 2 g |

Totale indicativo: 18 giorni di lavoro effettivo, sequenziali da M0 a M4 (ogni milestone
usa la precedente), parallelizzabili M5–M7.

## 14. Rischi

- **Formato della trascrizione** non documentato come stabile: mitigato rendendo il budget a
  token opzionale e best-effort (decisione 9).
- **Payload dello Stop** che cambia tra versioni di Claude Code: mitigato dal log delle chiavi
  e dall'uso dei soli campi documentati.
- **Doppia lingua** dei prompt: due pack da mantenere. Mitigato dal test di copertura e dal
  fatto che il pack `it` è un override completo, non una traduzione parziale.
- **Riscrittura vs. utenti della v1**: stessi verbi, stesso path, migrazione dello stato. Il
  rischio residuo è nei prompt, che cambiano lingua: chi vuole l'italiano imposta
  `OMC_PROMPT_PACK` al pack incluso, e il comando `/perseveranza` lo fa da solo se la locale
  è italiana.

## 15. Cosa non porto in v2

- Le guardie sul limite di contesto basate su campi non documentati.
- Il mini framework di test e il file unico da 800 righe.
- La lista di file duplicata tre volte in `install.mjs`.
- La cancellazione dell'audit trail al successo.
- L'`arm` che sovrascrive.
