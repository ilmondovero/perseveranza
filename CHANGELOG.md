# Changelog

Modifiche degne di nota, con il **perché** (non solo il cosa). La versione vive in
`.claude-plugin/plugin.json` e nel badge del README; non si usano tag git.

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
