#!/usr/bin/env node
// Stop hook: macchina a stati "OMC-loop" a ciclo CHIUSO (instrada in base agli esiti).
//
//   plan -> implement -> review --fail--> implement (fix, stesso step, max retry)
//                            \---pass--> implement (step successivo)
//   claim-done -> final-verify --pass--> disarm + notifica "Progetto finito"
//                             \--fail--> implement (fix, poi nuovo claim-done)
//
// DORMIENTE di default: non fa nulla finche' nel progetto non esiste .omc-loop/state.json
// (lo armi con omc-loop.mjs arm "<task>"). Globale ma non invade le chat normali.
//
// Contratto:
//   - L'hook possiede : phase, iterations, retries, finalFails, repeated.
//   - Claude possiede : lastReport (via `omc-loop.mjs report pass|fail`),
//                       claimedDone (via `claim-done`), paused (via `pause`/`resume`).
// Reti di sicurezza: limite iterazioni globale, limite retry per step (-> pausa + notifica),
// stato corrotto -> disarm + notifica. Ogni transizione e' loggata in .omc-loop/history.log.

import { readFileSync, writeFileSync, existsSync, appendFileSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const LOOP = `node "${join(dirname(fileURLToPath(import.meta.url)), 'omc-loop.mjs')}"`;

// notifica desktop cross-platform; in ultima istanza silenziosa (e' solo comodita')
function notify(title, msg) {
  try {
    if (process.platform === 'win32') {
      const q = (t) => t.replace(/'/g, "''");
      const ps = `try { Import-Module BurntToast -ErrorAction Stop; New-BurntToastNotification -Text '${q(title)}','${q(msg)}' | Out-Null } catch { [console]::beep(880,200) }`;
      spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000, stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      const q = (t) => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      spawnSync('osascript', ['-e', `display notification "${q(msg)}" with title "${q(title)}"`], { timeout: 5000, stdio: 'ignore' });
    } else {
      spawnSync('notify-send', [title, msg], { timeout: 5000, stdio: 'ignore' });
    }
  } catch { /* mai bloccare l'hook per una notifica */ }
}

// --- input evento ---
let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { /* stdin assente */ }
let evt = null;
try { evt = raw ? JSON.parse(raw) : null; } catch { /* evento malformato */ }

const cwd = (evt && evt.cwd) ? evt.cwd : process.cwd();
const gateDir = join(cwd, '.omc-loop');
const statePath = join(gateDir, 'state.json');
const planPath = join(gateDir, 'plan.md');
const histPath = join(gateDir, 'history.log');

// DORMIENTE: nessun gate -> non bloccare, lascia fermare Claude
if (!existsSync(statePath)) process.exit(0);

const proj = basename(cwd);
const disarm = () => rmSync(gateDir, { recursive: true, force: true });

// --- stato: parse robusto, default per i campi mancanti ---
let rawState = null;
try { rawState = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* corrotto */ }
if (!rawState || !rawState.phase) {
  disarm();
  notify('Claude Code - OMC-loop', `state.json corrotto: loop disarmato - ${proj}`);
  process.exit(0);
}
const s = {
  task: '', phase: 'plan', complexity: 'medium', iterations: 0, max: 25,
  retries: 0, maxRetries: 3, finalFails: 0, lastReport: 'none',
  claimedDone: false, paused: false, repeated: false,
  ...rawState,
};
for (const k of ['iterations', 'max', 'retries', 'maxRetries', 'finalFails']) {
  s[k] = Number.isFinite(Number(s[k])) ? Number(s[k]) : 0;
}
if (s.max < 1) s.max = 25;
if (s.maxRetries < 1) s.maxRetries = 3;

const saveState = () => writeFileSync(statePath, JSON.stringify(s, null, 2));
const logStep = (msg) => {
  try {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    appendFileSync(histPath, `${ts} | iter ${String(s.iterations).padStart(2)} | ${msg}\n`);
  } catch { /* il log non deve mai bloccare */ }
};

// PAUSA: serve input dell'utente (o limite retry raggiunto) -> non bloccare
if (s.paused) process.exit(0);

// limite globale di iterazioni
if (s.iterations >= s.max) {
  disarm();
  notify('Claude Code - OMC-loop', `Loop fermato: limite ${s.max} iterazioni - ${proj}`);
  process.exit(0);
}

// --- consuma i segnali scritti da Claude ---
const report = s.lastReport;
const claimed = s.claimedDone === true;
s.lastReport = 'none';
s.claimedDone = false;

const phase = s.phase;
const header = `[OMC-loop | iter ${s.iterations + 1}/${s.max}] Task: ${s.task}.`;
let reason = null;

// routing dei modelli per fase in base alla complessita' registrata da Claude
// (hint per i subagent: il modello della sessione principale non e' modificabile da un hook)
if (!['low', 'medium', 'high'].includes(s.complexity)) s.complexity = 'medium';
const reviewModel = { low: 'haiku', medium: 'sonnet', high: 'opus' }[s.complexity];
const verifyModel = { low: 'sonnet', medium: 'opus', high: 'opus' }[s.complexity];
const implHint = s.complexity === 'high'
  ? " Il task e' ad alta complessita': delega l'implementazione a un subagent executor con model=opus, tu coordina e controlla il risultato."
  : '';

// sospende il loop quando i fallimenti consecutivi superano il limite: serve un umano
function pauseForHuman(why) {
  s.paused = true;
  saveState();
  logStep(`${phase} -> PAUSA (${why})`);
  notify('Claude Code - OMC-loop', `Loop in pausa, serve intervento umano: ${why} - ${proj}`);
  process.exit(0);
}

if (claimed) {
  // da qualunque fase: la dichiarazione di completamento innesca il gate di uscita
  s.phase = 'final-verify'; s.repeated = false; s.retries = 0;
  reason = `${header} FASE: verifica finale avversariale. Hai dichiarato il progetto completo: ora va falsificato. Delega a un subagent INDIPENDENTE con model=${verifyModel} (contesto pulito) la verifica: parta da .omc-loop/plan.md e dalle modifiche reali, assuma che il lavoro sia SBAGLIATO, costruisca casi limite e input ostili, esegua DAVVERO test e build, verifichi ogni claim contro l'esecuzione reale. NON correggere nulla in questa fase. Alla fine esegui OBBLIGATORIAMENTE: ${LOOP} report pass (nessun difetto) oppure: ${LOOP} report fail`;
} else {
  switch (phase) {
    case 'plan': {
      if (existsSync(planPath) || s.repeated) {
        s.phase = 'implement'; s.repeated = false;
        reason = `${header} FASE: implement. Apri .omc-loop/plan.md e implementa il PRIMO step non spuntato.${implHint} NON spuntare la casella ora: si spunta solo dopo che la review e' passata. Se per procedere serve input dell'utente: esegui ${LOOP} pause e poi fai la domanda.`;
      } else {
        s.repeated = true;
        reason = `${header} FASE: plan. Manca .omc-loop/plan.md: scrivilo ORA come checklist markdown ('- [ ] step'), step piccoli e verificabili. Poi valuta la complessita' del task e registrala con: ${LOOP} complexity low|medium|high (instrada i modelli delle fasi successive). Infine fermati.`;
      }
      break;
    }
    case 'implement': {
      s.phase = 'review'; s.repeated = false;
      reason = `${header} FASE: code-review. Delega a un subagent code-reviewer con model=${reviewModel} (contesto pulito) la review delle modifiche appena fatte: correttezza, edge case, regressioni, sicurezza, adeguatezza dei test. Correggi subito i problemi bloccanti emersi. Alla fine esegui OBBLIGATORIAMENTE: ${LOOP} report pass (nessun bloccante residuo) oppure: ${LOOP} report fail (restano problemi). NON modificare .omc-loop/state.json a mano.`;
      break;
    }
    case 'review': {
      if (report === 'fail') {
        s.retries += 1;
        if (s.retries >= s.maxRetries) pauseForHuman(`${s.retries} review fallite sullo stesso step`);
        s.phase = 'implement'; s.repeated = false;
        reason = `${header} FASE: fix (tentativo ${s.retries}/${s.maxRetries}). La review ha lasciato problemi aperti: correggili TUTTI restando sullo stesso step del piano ed esegui i test pertinenti.${implHint} NON spuntare lo step.`;
      } else if (report === 'pass') {
        s.retries = 0; s.phase = 'implement'; s.repeated = false;
        reason = `${header} FASE: implement. Review superata: spunta lo step completato in .omc-loop/plan.md ('- [x]'). Se restano step non spuntati, implementa il PROSSIMO.${implHint} Se invece TUTTI gli step sono spuntati e il progetto e' completo, esegui: ${LOOP} claim-done (innesca la verifica finale). Se serve input dell'utente: ${LOOP} pause e poi fai la domanda.`;
      } else if (!s.repeated) {
        s.repeated = true; // resta in review, chiedi l'esito una volta sola
        reason = `${header} FASE: code-review (esito mancante). Non hai registrato l'esito della review. Completala se serve, poi esegui ORA: ${LOOP} report pass oppure: ${LOOP} report fail`;
      } else {
        // esito mancante due volte: avanza comunque (ciclo interno tollerante)
        s.retries = 0; s.phase = 'implement'; s.repeated = false;
        reason = `${header} FASE: implement (review senza esito registrato, considerata superata). Spunta lo step completato in .omc-loop/plan.md e implementa il PROSSIMO step non spuntato.${implHint} Se tutti gli step sono spuntati: ${LOOP} claim-done. D'ora in poi registra SEMPRE l'esito con report pass|fail.`;
      }
      break;
    }
    case 'final-verify': {
      if (report === 'pass') {
        logStep('final-verify -> DONE');
        disarm();
        notify('Claude Code - OMC-loop', `Progetto finito e verificato - ${proj}`);
        process.exit(0);
      } else if (report === 'fail') {
        s.finalFails += 1;
        if (s.finalFails >= s.maxRetries) pauseForHuman(`${s.finalFails} verifiche finali fallite`);
        s.phase = 'implement'; s.repeated = false;
        reason = `${header} FASE: fix post-verifica (bocciatura ${s.finalFails}/${s.maxRetries}). La verifica finale ha trovato difetti: correggili tutti e riapri in .omc-loop/plan.md gli step interessati ('- [ ]').${implHint} Quando tutto e' di nuovo completo e testato, riesegui: ${LOOP} claim-done`;
      } else if (!s.repeated) {
        s.repeated = true; // resta in final-verify, chiedi l'esito una volta sola
        reason = `${header} FASE: verifica finale (esito mancante). Non hai registrato l'esito della verifica. Completala se serve, poi esegui ORA: ${LOOP} report pass oppure: ${LOOP} report fail`;
      } else {
        // gate di uscita severo: esito mancante due volte = bocciatura
        s.finalFails += 1;
        if (s.finalFails >= s.maxRetries) pauseForHuman('verifica finale senza esito per 2 volte');
        s.phase = 'implement'; s.repeated = false;
        reason = `${header} FASE: implement (verifica finale senza esito registrato: considerata FALLITA). Rivedi il lavoro, poi riesegui: ${LOOP} claim-done e stavolta registra l'esito con report pass|fail.`;
      }
      break;
    }
    default: {
      // fase sconosciuta (stato manomesso): riparti dal piano
      s.phase = 'plan'; s.repeated = false;
      reason = `${header} FASE: plan (stato incoerente, ripristinato). Verifica .omc-loop/plan.md: se manca scrivilo come checklist '- [ ] step', poi fermati.`;
    }
  }
}

// persisti fase + contatore PRIMA di bloccare, poi logga la transizione
s.iterations += 1;
saveState();
logStep(`${phase} -> ${s.phase} | report=${report}${claimed ? ' | claim-done' : ''}`);

// blocca lo stop e inietta l'istruzione della fase
process.stdout.write(JSON.stringify({ decision: 'block', reason }));
process.exit(0);
