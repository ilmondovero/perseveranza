# Budget e kill switch del loop

Un loop autonomo deve avere tetti di spesa e un modo rapido per fermarlo. Perseveranza non
misura i token (gira nella sessione principale, fuori dalla portata dell'hook): il suo **proxy
di budget** è il numero di **iterazioni** e di **retry**, più i timeout. Questo documento
raccoglie in un punto solo i tetti e gli interruttori, ispirato al `loop-budget` della
[loop-engineering](https://cobusgreyling.github.io/loop-engineering/).

## Tetti (budget)

| Tetto | Default | Come cambiarlo | Cosa succede al limite |
|-------|---------|----------------|------------------------|
| Iterazioni totali | 25 | `--max N` all'arm | loop disarmato + notifica |
| Review fallite consecutive / step | 3 | `--max-retries N` all'arm | **pausa** + handoff `ESCALATION.md` |
| Verifiche finali fallite | 3 | `--max-retries N` all'arm | **pausa** + handoff `ESCALATION.md` |
| Timeout di un run di test | 30 min | `OMC_TEST_TIMEOUT_MS` (ms) | test registrato rosso (exit 124) |
| Takeover sessione inattiva | 6 h | `OMC_SESSION_TAKEOVER_MS` (ms) | un'altra sessione subentra dalla fase corrente |

L'iterazione è l'unità di spesa: ogni fase iniettata (plan, implement, review, fix, verifica…)
consuma un'iterazione. Tarare `--max` sul task è il modo diretto di mettere un tetto di costo:
task piccolo → `--max 8`; refactor ampio → `--max 40`. Una stima d'ordine di grandezza del costo
per pattern si ottiene con `npx @cobusgreyling/loop-cost`.

## Kill switch

Tre modi per fermare il loop, dal più "morbido" al più immediato:

1. **`pause`** — sospende senza disarmare; riprende con `resume`. Per interruzioni temporanee.
2. **`disarm`** — rimuove `.omc-loop/` e spegne il loop. Chiusura pulita e definitiva.
3. **Kill switch d'emergenza** — il più rapido, non richiede un comando node e funziona da
   **qualunque sessione**, anche con stato corrotto:
   - crea il file sentinella **`.omc-loop/STOP`** (da editor, o `touch .omc-loop/STOP`), **oppure**
   - imposta **`OMC_LOOP_KILL=1`** nell'ambiente.

   Al primo Stop l'hook trova l'interruttore, disarma il loop e manda una notifica. Il controllo
   sta **prima** dello scoping per-sessione e dello sblocco dello stato corrotto, così non c'è
   condizione in cui il loop possa ignorare un kill.

## Escalation (handoff all'umano)

Quando il loop esaurisce i retry (3 review fallite sullo stesso step, o 3 verifiche finali
bocciate) non insiste alla cieca: **si mette in pausa e scrive `.omc-loop/ESCALATION.md`**, un
passaggio di consegne con fase, tentativi, ultimo test, cosa guardare e come ripartire. È la
versione "escalate to humans" della loop-engineering, ma con un artefatto leggibile invece di una
semplice notifica. Dopo aver risolto a mano, `resume` riparte (e rimuove l'handoff stantio);
`disarm` abbandona.

## In breve

- **Costo sotto controllo** → `--max` (proxy di budget) e `--max-retries`.
- **Stop rapido** → file `.omc-loop/STOP` o `OMC_LOOP_KILL=1`.
- **Si è bloccato** → leggi `.omc-loop/ESCALATION.md`, correggi, `resume`.
