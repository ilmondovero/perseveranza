#!/usr/bin/env node
// Arma / disarma / pilota il ciclo "OMC-loop" nel progetto corrente.
// Uso (dal prompt di Claude Code con il prefisso !, o da Claude stesso):
//   node ... arm "implementa la feature X" [--max 25] [--max-retries 3] [--complexity low|medium|high] [--commit] [--external off] [--test "npm test"]
//     --commit        dopo ogni review passata, commit atomico dello step
//     --external off  disattiva il confronto con modelli esterni (default: auto-rilevati codex/gemini)
//     --test "<cmd>"  comando della suite: il claim-done richiedera' un test verde fresco
//     --no-git-finish a fine progetto NON fare commit+push automatico (default: si', se in un repo git)
//   node ... test -- <comando>             esegue il comando LUI STESSO e registra l'exit code reale
//                                          (prova non falsificabile: e' lo script a misurare)
//   node ... report pass|fail              esito della fase corrente (review / verifica finale)
//   node ... complexity low|medium|high    registra la complessita' del task (instrada i modelli)
//   node ... claim-done                    dichiara il progetto completo -> innesca la verifica finale
//   node ... ask <provider> <slot> -- <prompt>   interroga un modello esterno e SALVA il parere
//                                          in .omc-loop/external-<slot>.md (prompt anche via stdin)
//   node ... pause | resume                sospende / riprende il loop (es. serve input dell'utente)
//   node ... config                        mostra la config dei modelli esterni (chiave/modelli da file o env)
//   node ... hud on|off|status             statusline live del progresso (si compone con quella esistente)
//   node ... status | disarm

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { detectAvailable, askProvider, providerModels, effectiveEnv, loadConfig, CONFIG_PATH, PROVIDERS } from './providers.mjs';
import { maybeSpawnRefresh, updateAvailable } from './update.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const gateDir = join(process.cwd(), '.omc-loop');
const statePath = join(gateDir, 'state.json');

// --- parsing argomenti ---
const argv = process.argv.slice(2);
const action = argv[0] ?? 'status';
let value = '';
let max = 25;
let maxRetries = 3;
let complexity = '';
let commitSteps = false;
let external = 'auto';
let testCmd = '';
let gitFinish = true;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') break; // tutto cio' che segue appartiene al verbo `test`
  if (a === '--max') max = parseInt(argv[++i], 10);
  else if (a === '--max-retries') maxRetries = parseInt(argv[++i], 10);
  else if (a === '--complexity') complexity = String(argv[++i] ?? '');
  else if (a === '--commit') commitSteps = true;
  else if (a === '--external') external = String(argv[++i] ?? 'auto');
  else if (a === '--test') testCmd = String(argv[++i] ?? '');
  else if (a === '--no-git-finish') gitFinish = false;
  else if (!value) value = a;
}
if (!Number.isFinite(max) || max < 1) max = 25;
if (!Number.isFinite(maxRetries) || maxRetries < 1) maxRetries = 3;

function loadState() {
  if (!existsSync(statePath)) {
    console.log('OMC-loop NON armato in questo progetto.');
    process.exit(1);
  }
  return JSON.parse(readFileSync(statePath, 'utf8'));
}
function saveState(s) {
  writeFileSync(statePath, JSON.stringify(s, null, 2));
}

// prompt/comando dopo `--` sulla command line (condiviso da `ask` e `test`)
function argsAfterDoubleDash() {
  const sep = process.argv.indexOf('--');
  return sep !== -1 && process.argv.length > sep + 1 ? process.argv.slice(sep + 1).join(' ') : '';
}
// rende una stringa sicura come componente di nome file (no path traversal, no separatori)
const fileSafe = (x) => String(x).replace(/[^a-z0-9._-]/gi, '-');

// verbo `ask`: interroga un modello esterno (via providers.mjs) e PERSISTE il parere come
// artefatto in .omc-loop/external-<slot>.md (prompt + risposta), echeggiandolo anche a schermo.
// E' async (ollama-cloud usa fetch): gestito fuori dallo switch sincrono.
if (action === 'ask') {
  if (!existsSync(statePath)) { console.log('OMC-loop NON armato in questo progetto.'); process.exit(1); }
  const provider = argv[1];
  const slotRaw = argv[2];
  if (!provider || !slotRaw) {
    console.log('Uso: ask <provider> <slot> -- <prompt>   (oppure: <prompt> | ask <provider> <slot>)');
    process.exit(1);
  }
  const slot = fileSafe(slotRaw).toLowerCase() || 'misc';
  let prompt = argsAfterDoubleDash();
  // stdin solo se NON e' un TTY interattivo: altrimenti readFileSync(0) bloccherebbe in attesa di EOF
  if (!prompt && !process.stdin.isTTY) { try { prompt = readFileSync(0, 'utf8'); } catch { /* niente stdin */ } }
  prompt = (prompt || '').trim();
  if (!prompt) { console.log('Prompt vuoto: passalo dopo -- oppure via stdin.'); process.exit(1); }
  const s = loadState();
  const externals = Array.isArray(s.externals) ? s.externals : [];
  if (externals.length && !externals.includes(provider)) {
    console.log(`Nota: '${provider}' non e' tra i provider rilevati all'arm (${externals.join(', ') || 'nessuno'}). Provo comunque.`);
  }
  // un provider puo' espandere in piu' modelli (ollama-cloud con OLLAMA_MODEL = lista):
  // ogni modello produce un artefatto separato, cosi' i pareri non si sovrascrivono
  const provEnv = effectiveEnv(process.env); // env reale + file di config
  const models = providerModels(provider, provEnv);
  const ts = new Date().toISOString();
  let anyOk = false;
  for (const m of models) {
    console.log(`Interrogo ${provider}${m ? ` / ${m}` : ''} (slot: ${slot})...`);
    const r = await askProvider(provider, prompt, { env: provEnv, model: m });
    anyOk = anyOk || r.ok;
    const label = r.model && r.model !== provider ? `${provider} (${r.model})` : provider;
    const file = join(gateDir, `external-${slot}-${fileSafe(provider)}${m ? `-${fileSafe(m)}` : ''}.md`);
    const doc = `# Parere esterno - ${label}\n\n`
      + `- slot: ${slot}\n- quando: ${ts}\n- esito: ${r.ok ? 'ok' : 'ERRORE'}\n\n`
      + `## Prompt\n\n${prompt}\n\n## Risposta\n\n${r.output}\n`;
    try { writeFileSync(file, doc); console.log(`[salvato in .omc-loop/${file.split(/[\\/]/).pop()}]`); }
    catch (e) { console.log(`[impossibile salvare l'artefatto: ${e.message}]`); }
    console.log(`\n----- ${label} -----\n${r.output}\n`);
  }
  process.exit(anyOk ? 0 : 1);
}

switch (action) {
  case 'arm': {
    if (!value) { console.log('Manca la descrizione del task: arm "<task>"'); process.exit(1); }
    if (complexity && !['low', 'medium', 'high'].includes(complexity)) {
      console.log('Valore non valido per --complexity: usare low|medium|high'); process.exit(1);
    }
    if (!existsSync(gateDir)) mkdirSync(gateDir, { recursive: true });
    // modelli esterni disponibili su questa macchina (per il confronto indipendente):
    // CLI presenti (codex/gemini/agy) o API con chiave locale (ollama-cloud). La logica di
    // rilevamento e i flag stanno tutti in providers.mjs (unica fonte di verita').
    const has = (name) =>
      spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore', timeout: 4000 }).status === 0;
    const provEnv = effectiveEnv(process.env); // env reale + file di config (~/.perseveranza/config.json)
    const externals = external === 'off'
      ? []
      : detectAvailable({ has, env: provEnv, platform: process.platform });
    saveState({
      task: value,
      phase: 'plan',                       // plan -> implement -> review -> ... -> cleanup -> final-verify
      complexity: complexity || 'medium',  // low|medium|high - instrada i modelli delle fasi
      commitSteps,                         // commit atomico dopo ogni review passata
      externals,                           // CLI esterne rilevate: confronto nel plan, nei fix ripetuti e al gate
      cleanedOnce: false,                  // la fase cleanup gira solo al primo claim-done
      testCmd: testCmd || null,            // comando della suite (se noto): il claim richiede un test verde fresco
      lastTest: null,                      // ultimo run registrato dal verbo `test`: {cmd, exitCode, iteration, at}
      gitFinish,                           // a fine progetto: commit+push automatico se si e' dentro un repo git
      iterations: 0,
      max,
      retries: 0,                          // review fallite consecutive sullo stesso step
      maxRetries,
      finalFails: 0,                       // verifiche finali fallite
      lastReport: 'none',                  // pass|fail|none - scritto da `report`, consumato dall'hook
      claimedDone: false,                  // scritto da `claim-done`, consumato dall'hook
      paused: false,                       // scritto da `pause`/`resume` (o dall'hook al limite retry)
      repeated: false,                     // la fase corrente e' gia' stata ripetuta una volta
      sessionId: null,                     // proprieta' del loop: rivendicata al primo fire dell'hook
      lastFireAt: 0,                        // ultimo fire del proprietario (per il takeover su inattivita')
    });
    console.log(`OMC-loop ARMATO (max ${max} iterazioni, ${maxRetries} retry per step${commitSteps ? ', commit per step' : ''}). Task: ${value}`);
    console.log(`Modelli esterni per il confronto: ${externals.length ? externals.join(', ') : 'nessuno'}`);
    if (externals.includes('ollama-cloud')) {
      const ms = PROVIDERS['ollama-cloud'].models(provEnv);
      console.log(`  ollama-cloud: modell${ms.length > 1 ? 'i' : 'o'} ${ms.join(', ')} (lista in OLLAMA_MODEL/config separata da virgole; host ${PROVIDERS['ollama-cloud'].host(provEnv)})`);
    }
    if (testCmd) console.log(`Suite di test configurata: ${testCmd} (il claim-done richiedera' un run verde fresco via verbo test)`);
    console.log("Fase iniziale: plan. Scrivi il piano in .omc-loop/plan.md come checklist '- [ ] step', poi fermati: da li' guida lo Stop hook.");
    maybeSpawnRefresh(SCRIPT_DIR);
    const upd = updateAvailable(join(SCRIPT_DIR, '..'));
    if (upd) console.log(`⬆ Nuova versione v${upd} di perseveranza disponibile — aggiorna da /plugin`);
    break;
  }
  case 'report': {
    if (!['pass', 'fail'].includes(value)) { console.log('Uso: report pass|fail'); process.exit(1); }
    const s = loadState();
    s.lastReport = value;
    saveState(s);
    console.log(`Esito registrato: ${value} (fase corrente: ${s.phase}).`);
    break;
  }
  case 'complexity': {
    if (!['low', 'medium', 'high'].includes(value)) { console.log('Uso: complexity low|medium|high'); process.exit(1); }
    const s = loadState();
    s.complexity = value;
    saveState(s);
    console.log(`Complessita' registrata: ${value} (instrada i modelli di review, verifica finale e implement).`);
    break;
  }
  case 'test': {
    const s = loadState();
    const cmd = argsAfterDoubleDash() || (s.testCmd || '');
    if (!cmd) { console.log("Uso: test -- <comando> (oppure configura --test all'arm)"); process.exit(1); }
    console.log(`Eseguo: ${cmd}`);
    // esegue il comando in prima persona e registra l'exit code REALE: la prova non e' autodichiarata
    // timeout configurabile (default 30 min): le suite pesanti (es. backtest su molte strategie con
    // dati di rete) superano facilmente i 10 min e verrebbero registrate ROSSE per timeout (exit 124).
    const testTimeoutMs = Number(process.env.OMC_TEST_TIMEOUT_MS) || 1800000;
    const r = spawnSync(cmd, { shell: true, stdio: 'inherit', timeout: testTimeoutMs });
    const exitCode = r.status === null ? 124 : r.status; // null = timeout o kill
    s.lastTest = { cmd, exitCode, iteration: Number(s.iterations) || 0, at: new Date().toISOString() };
    if (!s.testCmd) s.testCmd = cmd;
    saveState(s);
    console.log(exitCode === 0 ? 'TEST VERDE (exit 0): registrato.' : `TEST ROSSO (exit ${exitCode}): registrato.`);
    process.exit(exitCode === 0 ? 0 : 1);
  }
  case 'claim-done': {
    const s = loadState();
    s.claimedDone = true;
    saveState(s);
    console.log('Completamento dichiarato: al prossimo Stop parte la VERIFICA FINALE avversariale.');
    break;
  }
  case 'pause': {
    const s = loadState();
    s.paused = true;
    saveState(s);
    console.log("OMC-loop in PAUSA: l'hook non interverra' finche' non esegui resume.");
    break;
  }
  case 'resume': {
    const s = loadState();
    s.paused = false;
    s.repeated = false;
    s.retries = 0;
    s.finalFails = 0;
    saveState(s);
    console.log('OMC-loop RIPRESO (contatori retry azzerati).');
    break;
  }
  case 'disarm': {
    if (existsSync(gateDir)) { rmSync(gateDir, { recursive: true, force: true }); console.log('OMC-loop DISARMATO.'); }
    else console.log('OMC-loop non era armato.');
    break;
  }
  case 'status': {
    if (existsSync(statePath)) {
      console.log('OMC-loop ARMATO:');
      console.log(readFileSync(statePath, 'utf8'));
    } else console.log('OMC-loop NON armato in questo progetto.');
    break;
  }
  case 'config': {
    // mostra la config effettiva dei modelli esterni SENZA mai stampare la chiave
    const cfg = loadConfig();
    const env = effectiveEnv(process.env);
    const keySrc = process.env.OLLAMA_API_KEY ? "variabile d'ambiente"
      : (cfg.ollama && cfg.ollama.apiKey) ? 'file di config' : null;
    console.log(`File di config: ${CONFIG_PATH} ${existsSync(CONFIG_PATH) ? '(presente)' : '(assente)'}`);
    console.log(`OLLAMA_API_KEY: ${env.OLLAMA_API_KEY ? `impostata (da ${keySrc})` : 'NON impostata'}`);
    console.log(`Modelli ollama-cloud: ${PROVIDERS['ollama-cloud'].models(env).join(', ')}`);
    console.log(`Host ollama-cloud:    ${PROVIDERS['ollama-cloud'].host(env)}`);
    console.log('');
    console.log('Per impostare chiave e modelli senza variabili d\'ambiente, crea il file sopra con:');
    console.log('  { "ollama": { "apiKey": "<la-tua-chiave>", "model": "glm-5.2,kimi-k2.7-code" } }');
    break;
  }
  case 'hud': {
    // attiva/disattiva la statusline di perseveranza COMPONENDOLA con quella esistente
    // (es. OMC HUD): la base viene salvata e ripristinata, niente sostituzione distruttiva.
    const sub = (value || 'status').toLowerCase();
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const settingsPath = join(claudeDir, 'settings.json');
    // wrapper STABILE in ~/.perseveranza/: il path in settings.json non cambia agli update
    // del plugin (la cache e' versionata). Il resolver trova la statusline.mjs piu' recente.
    const wrapper = join(homedir(), '.perseveranza', 'statusline-hud.mjs');
    const resolverSrc = join(SCRIPT_DIR, 'statusline-resolver.mjs');
    const ourCmd = `node "${wrapper.replace(/\\/g, '/')}"`;
    const isOurs = (cmd) => typeof cmd === 'string' && /statusline(-hud|-resolver)?\.mjs/.test(cmd);
    const readSettings = () => { try { return JSON.parse(readFileSync(settingsPath, 'utf8')) || {}; } catch { return {}; } };
    const readCfg = () => { try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch { return {}; } };
    const writeCfg = (c) => { mkdirSync(dirname(CONFIG_PATH), { recursive: true }); writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); };

    if (sub === 'on') {
      const st = readSettings();
      const cur = st.statusLine && st.statusLine.command;
      if (!isOurs(cur)) { // non sovrascrivere la base con noi stessi (evita ricorsione)
        const cfg = readCfg(); cfg.statusline = { ...(cfg.statusline || {}), base: cur || '' }; writeCfg(cfg);
      }
      mkdirSync(dirname(wrapper), { recursive: true });
      copyFileSync(resolverSrc, wrapper); // resolver stabile, indipendente dalla versione
      st.statusLine = { type: 'command', command: ourCmd };
      mkdirSync(claudeDir, { recursive: true });
      if (existsSync(settingsPath)) writeFileSync(`${settingsPath}.bak-perseveranza-hud`, readFileSync(settingsPath));
      writeFileSync(settingsPath, JSON.stringify(st, null, 2));
      console.log(`HUD perseveranza ATTIVO. Statusline base preservata: ${readCfg().statusline?.base || '(nessuna)'}`);
      console.log('Ricarica/riavvia Claude Code per vederlo. Disattiva con: hud off');
    } else if (sub === 'off') {
      const st = readSettings();
      const base = readCfg().statusline?.base || '';
      if (base) st.statusLine = { type: 'command', command: base }; else delete st.statusLine;
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(st, null, 2));
      try { rmSync(wrapper); } catch { /* gia' assente */ }
      const cfg = readCfg();
      if (cfg.statusline) { delete cfg.statusline.base; if (!Object.keys(cfg.statusline).length) delete cfg.statusline; writeCfg(cfg); }
      console.log(`HUD perseveranza DISATTIVATO. Statusline ripristinata: ${base || '(nessuna)'}`);
    } else {
      const cur = readSettings().statusLine?.command || '(nessuna)';
      console.log(`Statusline attuale: ${cur}`);
      console.log(`HUD perseveranza:   ${isOurs(cur) ? 'ATTIVO' : 'non attivo'}`);
      console.log(`Base salvata:       ${readCfg().statusline?.base || '(nessuna)'}`);
      console.log(`Wrapper:            ${wrapper}`);
      console.log('Uso: hud on | off | status');
    }
    break;
  }
  default: {
    console.log(`Verbo sconosciuto: ${action}. Verbi: arm, report, complexity, test, ask, claim-done, pause, resume, status, config, hud, disarm.`);
    process.exit(1);
  }
}
