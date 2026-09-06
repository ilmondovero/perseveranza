# Code review — 5 settembre 2026

Base esaminata: `88302ae` (2.0.1). Review locale di core, hook, chiusura Git,
CLI, archiviazione, provider, HUD e test. Le correzioni si concentrano sulle
garanzie di completamento; nessuna chiamata a provider esterni o pubblicazione.

## Problemi corretti

### P1 — Chiusura Git confermata senza prove leggibili

In `src/shell/git.mjs`, una deadline esaurita durante `rev-parse` restituiva
`ran: false`: il core interpretava il progetto come esterno a Git e completava
il run. Inoltre, `git status` fallito produceva una stringa vuota interpretata
come working tree pulito, mentre un `rev-list` fallito diventava zero commit
da pubblicare. Anche gli errori di staging e di esclusione del gate erano ignorati.

Ora gli errori mantengono la chiusura non confermata, con una motivazione.
Si controllano stato Git, esistenza di HEAD e conteggio valido dei commit;
anche il push deve riuscire. Lo staging esclude il gate e un errore nel rimuoverlo
dall'indice impedisce il commit. Test con errori simulati e hook reale con deadline
esaurita verificano che il run resti in pausa in `git-finish`.

### P1 — Modifiche successive ai test non rilevate

L'impronta precedente conteneva il diff rispetto a HEAD e una lista di nomi:
cambiare il contenuto di un file già untracked non la modificava. Anche due
modifiche binarie potevano avere lo stesso diff testuale; due working tree puliti
su commit diversi producevano la stessa impronta. Prima del primo commit il diff
poteva fallire e lasciare una prova incompleta.

La nuova impronta combina indice Git, diff binario e contenuti dei file untracked.
I percorsi sono delimitati da NUL; i file nuovi vengono letti a blocchi, con un
limite temporale condiviso con l'hook. `.omc-loop/` resta esclusa. Se una prova
esistente non può essere ricalcolata, `claim-done` la rifiuta.
Test reali coprono file nuovi, nomi Unicode, binari, commit e repository appena
inizializzati; un test attraversa anche `test` → `claim-done` → Stop hook.

### P1 — Verdetti malformati accettati come promozione

In `src/core/machine.mjs`, il parser segnalava l'errore ma lasciava invariato un
precedente `report pass`, consentendo l'avanzamento e, nella verifica finale,
la chiusura. In `src/core/verdicts.mjs`, `Number(blocking)` trasformava anche
`null`, `false`, stringhe vuote e array vuoti in zero.

Ora un artefatto malformato invalida il precedente report e segue il percorso
"missing", con promemoria e successiva bocciatura. `blocking` deve essere un
numero intero JSON non negativo. Le regressioni coprono entrambe le fasi.

### P2 — Stato danneggiato interrompeva l'hook

Un JSON valido con `options: null`, `counters: "broken"` o altri contenitori
di tipo errato faceva sollevare un'eccezione a `normalizeState`. Il catch esterno
dell'hook consentiva lo stop lasciando il run armato. Ora i contenitori malformati
vengono sostituiti con i default; i test coprono tutti e sette i gruppi di stato.

## Rilievi aggiuntivi risolti — 6 settembre 2026

- **P1 — Perdita degli artefatti se l'archivio fallisce.** I percorsi di chiusura
  in `src/shell/effects.mjs`, `src/shell/stop.mjs` e `src/cli/verbs/disarm.mjs`
  cancellavano il gate anche dopo un errore di archiviazione. Ora il fallimento
  conserva i file in `.omc-loop` e rinomina lo stato in `state.disarmed.json`,
  disattivando l'hook. `status` spiega il recupero, `disarm` ritenta mantenendo
  l'esito originale del run e `arm` impedisce sovrascritture anche con `--force`.
  Le cartelle di archivio sono univoche; tra volumi diversi, la copia deve essere
  completa prima di rimuovere gli originali. Le copie incomplete non compaiono
  come run archiviati. Test reali coprono cinque percorsi di chiusura; test con
  errori filesystem simulati verificano anche una copia parziale interrotta
  da disco pieno. Se il filesystem impedisce anche la rinomina dello stato,
  l'errore segnala che il loop non è stato disattivato; i file non vengono cancellati.
- **P2 — `hud off` poteva cancellare una statusline estranea.** Ora il comando
  in `src/cli/verbs/hud.mjs` verifica il percorso del proprio wrapper, preserva
  configurazioni estranee senza riscriverle e ripristina l'intero oggetto originale,
  incluse opzioni come `padding`. `off` ripetuto è innocuo; impostazioni JSON
  malformate producono un errore senza sovrascrittura. I test coprono anche una
  statusline sostituita dall'utente dopo `hud on`.
- **P2 — Directory temporanea condivisa per i provider.** In
  `src/providers/registry.mjs`, `grok`, `cursor` e `claude` ricevono ora una
  directory vuota creata con `mkdtempSync` a ogni invocazione. Il blocco `finally`
  ne tenta la rimozione anche in caso di errore, timeout o eccezione di avvio.
  I test simulano le CLI e verificano unicità, contenuto iniziale e pulizia;
  nessuna CLI esterna avviata. La directory dedicata non costituisce una sandbox
  e un processo che mantiene file aperti può impedirne la rimozione immediata.

## Seconda lettura — 6 settembre 2026

Rilettura del diff delle correzioni sopra, con verifiche empiriche su Windows.

- **P1 — Rename bloccata su Windows faceva fallire l'archivio.** Il fallback a copia
  scattava solo con `EXDEV`. Verificato: `renameSync` di una cartella con un file aperto
  dentro fallisce con `EPERM`, quindi un handle tenuto da antivirus, indexer o client di
  sync trasformava ogni fine run in un archivio fallito, con `arm` bloccato fino a un
  `disarm` manuale. Ora `EPERM`/`EBUSY`/`EACCES` ricevono retry brevi e poi la copia;
  una copia parziale viene rimossa; se gli originali bloccati non si cancellano dopo una
  copia completa, il run è pubblicato una volta sola e il residuo resta dormiente.
  Test con `EXDEV`, `EPERM`, `EBUSY`, `EROFS` e originali bloccati.
- **P2 — Impronta non ricalcolabile confusa con codice cambiato.** `ctx.fingerprint`
  nullo produceva `claim-stale`, e l'istruzione mandava Claude a rilanciare la suite in
  loop fino al budget. Nuovo esito `claim-unverifiable` con chiave
  `claim-unverifiable-tree` (inglese e italiano) che spiega la causa reale e indirizza a
  `.gitignore`. Riga in tabella, README rigenerati, test di macchina e di copertura.
- **P3 — Motivo del commit fallito perso.** `gitFinish` scartava lo stderr di
  `git commit`: l'umano leggeva "local commit not verified" senza sapere che mancava
  l'identità git. L'ultima riga dello stderr entra in `error`, anche con `--no-push`.
- **Processo.** Le correzioni non avevano voce nel CHANGELOG né versione: aggiunta la
  2.0.2, che le riassume tutte col perché.

Non toccato: `hud off` riconosce il wrapper solo per uguaglianza esatta del comando, quindi
se `PERSEVERANZA_HOME` cambia tra `on` e `off` risponde "già spento". È la scelta che
protegge le statusline altrui (un test la impone); il caso è raro e si sistema a mano.

## Validazione e limiti

La suite iniziale passava 129 test. Prima delle correzioni, i nuovi casi e
l'asserzione rafforzata sull'impronta illeggibile hanno riprodotto otto fallimenti.
La prima serie di correzioni ha superato 140 test della suite completa e un test
aggiuntivo sul primo commit. Le tre correzioni successive aggiungono copertura
su archiviazione, HUD e provider: **153/153 test della suite completa superati**.
`git diff --check` non segnala errori.

Esecuzione locale su Windows con Node.js 22.22.0; macOS e Linux non eseguiti in questa review.
I test Git usano repository e remote bare temporanei. L'impronta segue il perimetro
dei file Git non ignorati e non è uno snapshot atomico contro scritture concorrenti.
I run già dotati della vecchia impronta richiederanno un nuovo test verde.
