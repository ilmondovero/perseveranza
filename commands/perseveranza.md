---
description: Arma il ciclo OMC-loop a feedback (plan -> implement -> review -> verifica finale avversariale) e inizia il task
argument-hint: <descrizione del task> [--max N]
---

Attiva la modalita' "perseveranza" per il task indicato e comincia a lavorarci.

Task richiesto dall'utente:

$ARGUMENTS

Passi da eseguire ORA, in ordine:

1. Se il testo sopra contiene `--max N`, RIMUOVILO dalla descrizione del task e passa `-Max N`
   al comando; altrimenti lascia il default. Se il task contiene virgolette doppie, escapale.
   Arma il ciclo (tool PowerShell):

   pwsh -File $env:USERPROFILE\.claude\hooks\omc-loop.ps1 arm "<task senza --max>" [-Max N]

2. Verifica che sia armato:

   pwsh -File $env:USERPROFILE\.claude\hooks\omc-loop.ps1 status

3. FASE PLAN: scrivi il piano in `.omc-loop\plan.md` come checklist markdown (`- [ ] step`),
   con step piccoli e verificabili. Poi valuta la complessita' del task e registrala:

   pwsh -File $env:USERPROFILE\.claude\hooks\omc-loop.ps1 complexity low|medium|high

   (criterio: low = modifica piccola e localizzata; medium = feature multi-file standard;
   high = architettura, refactor esteso, dominio delicato. Default se non registri: medium.)
   Infine FERMATI (termina la risposta senza implementare). Da qui in poi lo Stop hook
   `loop-drive.ps1` guida le fasi iniettando a ogni fine risposta l'istruzione successiva,
   instradando in base agli esiti che registri.

La complessita' instrada i modelli delle fasi (hint per i subagent):

   | fase                       | low    | medium | high |
   |----------------------------|--------|--------|------|
   | code-review (subagent)     | haiku  | sonnet | opus |
   | verifica finale (subagent) | sonnet | opus   | opus |
   | implement                  | in sessione | in sessione | delega a executor model=opus |

Come funziona il ciclo (a feedback):

- implement -> code-review (delegata a un subagent con contesto pulito) -> registri l'esito:
  `pwsh -File $env:USERPROFILE\.claude\hooks\omc-loop.ps1 report pass|fail`
  - `fail` -> torni a correggere lo STESSO step (al 3o fallimento il loop si mette in pausa
    e notifica l'utente);
  - `pass` -> spunti lo step in `plan.md` (`- [x]`) e passi al successivo.
- Quando TUTTI gli step sono spuntati e il progetto e' completo:
  `pwsh -File $env:USERPROFILE\.claude\hooks\omc-loop.ps1 claim-done`
  -> parte la verifica finale avversariale (subagent indipendente). `report pass` chiude il
  ciclo (disarma + notifica "Progetto finito"); `report fail` ti rimanda a correggere.
- Se ti serve input dell'utente: esegui `pause`, poi fai la domanda; quando l'utente risponde,
  esegui `resume` e prosegui.
- Limite globale di iterazioni (default 25): raggiunto quello, il loop si ferma da solo.
- Interruzione manuale in qualsiasi momento:
  `pwsh -File $env:USERPROFILE\.claude\hooks\omc-loop.ps1 disarm`

Regole:
- NON modificare mai a mano `.omc-loop\state.json`: usa solo i verbi `report`, `claim-done`,
  `pause`, `resume`.
- L'unico file del ciclo che gestisci tu e' `.omc-loop\plan.md` (checklist degli step).
- Lo storico delle transizioni e' in `.omc-loop\history.log` (utile per diagnosi).
