#!/usr/bin/env node
// Arma / disarma / pilota il ciclo "OMC-loop" nel progetto corrente.
// Uso (dal prompt di Claude Code con il prefisso !, o da Claude stesso):
//   node "$HOME/.claude/hooks/omc-loop.mjs" arm "implementa la feature X" [--max 25] [--max-retries 3] [--complexity low|medium|high]
//   node ... report pass|fail              esito della fase corrente (review / verifica finale)
//   node ... complexity low|medium|high    registra la complessita' del task (instrada i modelli)
//   node ... claim-done                    dichiara il progetto completo -> innesca la verifica finale
//   node ... pause | resume                sospende / riprende il loop (es. serve input dell'utente)
//   node ... status | disarm

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const gateDir = join(process.cwd(), '.omc-loop');
const statePath = join(gateDir, 'state.json');

// --- parsing argomenti ---
const argv = process.argv.slice(2);
const action = argv[0] ?? 'status';
let value = '';
let max = 25;
let maxRetries = 3;
let complexity = '';
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--max') max = parseInt(argv[++i], 10);
  else if (a === '--max-retries') maxRetries = parseInt(argv[++i], 10);
  else if (a === '--complexity') complexity = String(argv[++i] ?? '');
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

switch (action) {
  case 'arm': {
    if (!value) { console.log('Manca la descrizione del task: arm "<task>"'); process.exit(1); }
    if (complexity && !['low', 'medium', 'high'].includes(complexity)) {
      console.log('Valore non valido per --complexity: usare low|medium|high'); process.exit(1);
    }
    if (!existsSync(gateDir)) mkdirSync(gateDir, { recursive: true });
    saveState({
      task: value,
      phase: 'plan',                       // plan -> implement -> review -> ... -> final-verify
      complexity: complexity || 'medium',  // low|medium|high - instrada i modelli delle fasi
      iterations: 0,
      max,
      retries: 0,                          // review fallite consecutive sullo stesso step
      maxRetries,
      finalFails: 0,                       // verifiche finali fallite
      lastReport: 'none',                  // pass|fail|none - scritto da `report`, consumato dall'hook
      claimedDone: false,                  // scritto da `claim-done`, consumato dall'hook
      paused: false,                       // scritto da `pause`/`resume` (o dall'hook al limite retry)
      repeated: false,                     // la fase corrente e' gia' stata ripetuta una volta
    });
    console.log(`OMC-loop ARMATO (max ${max} iterazioni, ${maxRetries} retry per step). Task: ${value}`);
    console.log("Fase iniziale: plan. Scrivi il piano in .omc-loop/plan.md come checklist '- [ ] step', poi fermati: da li' guida lo Stop hook.");
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
  default: {
    console.log(`Verbo sconosciuto: ${action}. Verbi: arm, report, complexity, claim-done, pause, resume, status, disarm.`);
    process.exit(1);
  }
}
