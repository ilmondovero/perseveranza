# Perseveranza

Ciclo autonomo a feedback per Claude Code (Windows, macOS, Linux): dato un task, Claude
pianifica, implementa step per step, fa revisionare ogni step da un subagent e chiude solo
dopo una verifica finale avversariale indipendente. Una notifica desktop avvisa quando il
progetto e' finito o quando serve intervento umano.

```
plan -> implement -> review --fail--> fix (stesso step, max 3 tentativi)
                         \---pass--> step successivo
claim-done -> verifica finale avversariale --pass--> fine (notifica)
                                           \--fail--> fix
```

Il motore e' uno Stop hook **dormiente**: non fa nulla finche' non lo si arma con il
comando `/perseveranza`, quindi non interferisce con le chat normali. Tutta la logica
gira su Node.js — lo stesso runtime di Claude Code — quindi non servono bash, PowerShell
o altre dipendenze.

## Requisiti

- [Claude Code](https://claude.com/claude-code) (Node.js arriva con lui)
- Consigliato: plugin **oh-my-claudecode** (fornisce i subagent `code-reviewer` ed
  `executor` citati nelle fasi; senza, Claude usa subagent generici)
- Notifiche desktop (opzionali, fallback silenzioso):
  - Windows: modulo PowerShell **BurntToast** (`Install-Module BurntToast`); senza, beep
  - macOS: `osascript` (gia' presente)
  - Linux: `notify-send` (pacchetto `libnotify`)

## Installazione (plugin, consigliata)

Dentro Claude Code, due comandi:

```
/plugin marketplace add ilmondovero/perseveranza
/plugin install perseveranza@perseveranza
```

Fatto: hook e comando sono registrati dal plugin system su qualunque OS, senza toccare
`settings.json`. Il comando si invoca come `/perseveranza` (forma completa:
`/perseveranza:perseveranza`). Gli **aggiornamenti** si prendono dal pannello `/plugin`
quando esce una nuova versione.

## Installazione manuale (alternativa)

```bash
git clone https://github.com/ilmondovero/perseveranza.git
cd perseveranza
node install.mjs
```

Copia gli script in `~/.claude/` e registra lo Stop hook in `~/.claude/settings.json`
(idempotente, con backup; sostituisce automaticamente installazioni precedenti, comprese
le vecchie versioni PowerShell). Aggiornamento: `git pull` + di nuovo `node install.mjs`.
Disinstallazione: `node install.mjs --uninstall`.

**Non usare le due modalita' insieme**: due Stop hook guiderebbero lo stesso loop facendo
avanzare le fasi due volte per risposta. Prima di passare al plugin, eseguire
`node install.mjs --uninstall`.

Lo script copia i file in `~/.claude/` e registra lo Stop hook in `~/.claude/settings.json`
(idempotente: rilanciarlo non duplica nulla; prima di modificare `settings.json` ne crea un
backup; sostituisce automaticamente eventuali installazioni precedenti, comprese le vecchie
versioni PowerShell). Riavviare Claude Code dopo l'installazione.

## Uso

```
/perseveranza implementa la feature X     # default: max 25 iterazioni
/perseveranza rifai il modulo Y --max 40
```

Claude scrive il piano in `.omc-loop/plan.md` (checklist), valuta la complessita' del
task e poi il ciclo procede da solo. Per interromperlo in qualsiasi momento basta
eliminare la cartella `.omc-loop/` del progetto (equivale al verbo `disarm`), o chiedere
a Claude di eseguire il disarm.

Tutti i verbi (`status`, `report`, `claim-done`, `pause`, `resume`, `disarm`) sono
documentati in testa a `scripts/omc-loop.mjs`. Lo storico delle transizioni e' in
`.omc-loop/history.log`.

## Routing dei modelli per complessita'

In fase di piano Claude registra la complessita' (`low|medium|high`), che instrada i
modelli usati dalle fasi (hint per i subagent):

| fase                       | low    | medium | high |
|----------------------------|--------|--------|------|
| code-review (subagent)     | haiku  | sonnet | opus |
| verifica finale (subagent) | sonnet | opus   | opus |
| implement                  | in sessione | in sessione | delega a executor `model=opus` |

## Reti di sicurezza

- limite globale di iterazioni (default 25, `--max N` per cambiarlo)
- 3 review fallite sullo stesso step -> pausa + notifica "serve intervento umano"
- la chiusura richiede il pass della verifica finale avversariale (niente auto-certificazione)
- stato corrotto -> disarmo pulito con notifica
- a fine progetto la cartella `.omc-loop/` viene rimossa (aggiungerla comunque al
  `.gitignore` dei progetti su cui la si usa)

## Disinstallazione

- Plugin: disinstallare dal pannello `/plugin` (o disattivarlo con il toggle).
- Manuale: `node install.mjs --uninstall` dalla cartella del repo (rimuove file e voce
  hook da `settings.json`).
