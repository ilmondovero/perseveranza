# Segnalazione — loop orfano: la sessione muore, il loop resta armato e nessuno lo riprende

Data: 2026-09-07. Progetto: `C:\2026\splitwise`. Engine: 2.0.2 (2.1.0 non cambia il comportamento).
Archivio del run: `~/.perseveranza/runs/splitwise/2026-09-07T07-53-15-513Z-vTZecW`.

## Cosa è successo

Run armato il 06/09 alle 09:58 UTC, complessità high, 16 passi di piano, `--commit`.
Ha lavorato bene per 17 iterazioni (13 passi su 16 completati e committati, un falso
positivo della code review smentito sui dati reali). Poi:

```
11:10:25  transition implement -> review  (review-delegate, iterazione 17)
          ... 20 ore e 43 minuti di silenzio ...
07:53:15  signal disarm   (a mano, dal giorno dopo, da un'ALTRA sessione)
```

Nessun errore, nessun fire, nessun verdetto. Il loop è rimasto in `phase: review` con
`paused: false`, `claimedDone: false`, nessun retry, budget abbondante (17/56). Dal suo
punto di vista era tutto in ordine: stava "aspettando" una revisione che nessuno stava
facendo.

La sessione proprietaria (`8dd6a127`) non ha più prodotto uno Stop. Le cause possibili
sono tutte ordinarie e nessuna lascia traccia nel journal: chiusura del terminale,
interruzione con Esc durante il turno (lo Stop hook non scatta), crash del client,
compattazione del contesto che ha perso l'istruzione di fase, o semplicemente l'utente che
non ha più mandato un prompt. Il journal non distingue "sta lavorando" da "è morto".

## Perché il plugin non se n'è accorto

Il loop vive **solo** nello Stop hook (`hooks/hooks.json`). Se la sessione non chiude più
un turno, non c'è nessun altro punto in cui il plugin esegua codice. In particolare:

1. **Nessun hook di ripartenza.** Non c'è `SessionStart` né `UserPromptSubmit`: una nuova
   sessione aperta nella stessa cartella non viene informata che esiste un loop armato,
   di chi è, da quanto tempo tace e in che fase era. L'ho scoperto solo perché c'era una
   cartella `.omc-loop/` non tracciata nel `git status`.
2. **Il takeover è passivo.** `machine.mjs:125` consente a un'altra sessione di prendere il
   loop dopo `DEFAULT_TAKEOVER_MS` (6 ore), ma solo se quella sessione arriva a uno Stop
   mentre il loop è armato. Chi apre una sessione per fare tutt'altro non lo sa e, se
   avesse risposto a qualsiasi cosa, si sarebbe ritrovato a guidare la review del passo
   12 senza averlo chiesto. È esattamente quello che sarebbe successo oggi se l'utente
   avesse chiesto qualcos'altro invece di "disattiva il ciclo".
3. **`status` non dice "da quanto".** Stampa `session: 8dd6a127` e la fase, ma non
   `lastFireAt` né l'età dell'ultimo fire. Un loop morto da 20 ore e uno che ha appena
   delegato la review sono indistinguibili a colpo d'occhio.
4. **Nessuna notifica di silenzio.** `notify.mjs` avvisa a fine run e a budget esaurito,
   mai per "il loop non fa un fire da N ore".

## Danno

In questo caso limitato: i passi 12-13 erano già committati, tre passi restano da fare a
mano. Il costo vero è stato la non-informazione: il run è sembrato "in corso" per una
notte intera e la risposta a "ha finito?" ha richiesto di leggere journal, piano e note.
Nello scenario peggiore (loop in `implement` con albero sporco e `--commit`) un takeover
passivo da una sessione ignara avrebbe committato o riscritto lavoro a metà.

## Proposte, in ordine di rapporto costo/beneficio

1. **Hook `SessionStart` (e `UserPromptSubmit` se serve la versione "ad ogni prompt").**
   Se `.omc-loop/state.json` esiste: se l'owner è questa sessione, non fare nulla; se è
   un'altra sessione e `now - lastFireAt` supera una soglia (proporrei 30-60 minuti, molto
   meno dei 6 h del takeover), iniettare un contesto del tipo:
   > perseveranza: loop armato da `8dd6a127` in fase `review`, ultimo fire 20 h fa,
   > 13/16 passi fatti, ultima istruzione `review-delegate` (passi 12-13). Chiedi all'utente
   > se riprendere qui (`omc-loop resume --takeover`) o fermarlo (`disarm`). Non fare
   > altro su questo repo finché non decide.
   Senza risposta esplicita, il takeover **non** deve avvenire. Questo trasforma il caso
   silenzioso in una domanda.
2. **`status` mostra l'età.** `last fire: 20h43m ago (2026-09-06 11:10 UTC)` e un marcatore
   `STALE` oltre la soglia. Stessa riga nella HUD, con colore diverso quando è stale.
3. **Takeover esplicito, non implicito.** Il ramo `stale` di `machine.mjs:125-132` dovrebbe
   richiedere un consenso (`resume --takeover` che scrive `owner.sessionId = null`, o un
   flag in `signals`) invece di scattare al primo Stop di chiunque. Il caso "ho riaperto
   il terminale e voglio continuare" è coperto dal punto 1 che lo propone.
4. **Journal: registrare il vuoto.** Al primo fire dopo un silenzio > soglia, scrivere un
   evento `{type:'gap', since, ms}` così il `summary.json` e `runs show` mostrano che il run
   ha avuto un buco, invece di 17 transizioni pulite seguite da un disarm senza motivo.
5. **Notifica di silenzio (opzionale).** Un `SessionStart` da qualunque progetto potrebbe
   controllare `~/.perseveranza/` per loop armati altrove e stale; oppure un cron di
   Claude Code che ogni ora esegue `status --all` e notifica. Meno prioritario: il punto 1
   copre il caso in cui l'utente torna.

## Nota su come è stato disarmato

`disarm` da una sessione diversa dall'owner ha funzionato senza avvisi e ha archiviato
correttamente. Bene. Ma sarebbe utile che `disarm` stampasse un riepilogo minimo
(fase, passi `[x]`/`[ ]` dal piano, età dell'ultimo fire): la domanda successiva
dell'utente è stata proprio "aveva finito?", e la risposta era nel piano archiviato.
