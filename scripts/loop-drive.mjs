#!/usr/bin/env node
// Stop hook: macchina a stati "OMC-loop" a ciclo CHIUSO (instrada in base agli esiti).
//
//   plan (con esplorazione) -> implement -> review --fail--> implement (fix, stesso step, max retry)
//                                               \---pass--> implement (step successivo, opz. commit)
//   claim-done -> cleanup (solo la prima volta) -> final-verify --pass--> disarm + notifica
//                                                              \--fail--> implement (fix, poi nuovo claim-done)
//   Se all'arm sono state rilevate CLI esterne (codex/gemini/agy), il piano, i fix
//   ripetuti e il gate finale includono un confronto con un modello esterno.
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
import { renderProgress } from './hud.mjs';

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

// commit+push automatico a fine progetto, SOLO se si e' dentro un repo git; altrimenti salta.
// Best-effort e mai bloccante: un push fallito (nessun upstream/remote/auth) non annulla la chiusura.
// .omc-loop/ viene escluso dallo stage (lo stato non finisce nel commit).
function gitFinish(cwd, task) {
  const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000 });
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || String(inside.stdout).trim() !== 'true') return { ran: false };
  git(['add', '-A']);
  git(['reset', '-q', '--', '.omc-loop']); // non committare mai lo stato del loop
  // (ridondante con .gitignore, ma resta come rete di sicurezza se .omc-loop fosse gia' tracciato)
  const msg = `perseveranza: ${task || 'progetto completato'}`;
  const commit = git(['commit', '-m', msg]); // su un retry puo' dire "nothing to commit": va bene
  const push = git(['push']);
  const pushErr = push.status === 0 ? '' : (String(push.stderr).trim().split('\n').pop() || 'push fallito').slice(0, 100);
  // VERIFICA REALE che commit e push siano avvenuti (non ci si fida degli exit code):
  //  - commit eseguito = nessuna modifica tracciata resta fuori (working tree pulito, escluso .omc-loop)
  //  - push eseguito    = esiste un upstream e HEAD non e' avanti ad esso (tutto e' finito sul remoto)
  const dirty = String(git(['status', '--porcelain']).stdout)
    .split('\n').some((l) => l.trim() && !l.includes('.omc-loop'));
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const hasUpstream = upstream.status === 0;
  const ahead = hasUpstream ? Number(String(git(['rev-list', '--count', '@{u}..HEAD']).stdout).trim()) : null;
  const committed = !dirty;
  const pushed = hasUpstream && ahead === 0;
  return { ran: true, confirmed: committed && pushed, committed, pushed, hasUpstream, pushErr };
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
  commitSteps: false, externals: [], cleanedOnce: false,
  testCmd: null, lastTest: null, gitFinish: true,
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
let report = s.lastReport;
const claimed = s.claimedDone === true;
s.lastReport = 'none';
s.claimedDone = false;

const phase = s.phase;

// verdetto scritto dal subagent come artefatto: ha priorita' sul verbo `report`
// e viene consumato alla lettura (un verdetto non si riusa mai)
function readVerdictArtifact(name) {
  const p = join(gateDir, name);
  if (!existsSync(p)) return null;
  let v = null;
  try { v = JSON.parse(readFileSync(p, 'utf8')); } catch { /* malformato: si ricade sul verbo */ }
  try { rmSync(p); } catch { /* gia' rimosso */ }
  return v;
}
const dropStaleArtifact = (name) => { try { rmSync(join(gateDir, name)); } catch { /* assente */ } };

let verdictSrc = 'verbo';
if (phase === 'review') {
  const art = readVerdictArtifact('review.json');
  if (art && Number.isFinite(Number(art.blocking))) {
    report = Number(art.blocking) === 0 ? 'pass' : 'fail';
    verdictSrc = 'review.json';
  }
} else if (phase === 'final-verify') {
  const art = readVerdictArtifact('verify.json');
  if (art && typeof art.pass === 'boolean') {
    report = art.pass ? 'pass' : 'fail';
    verdictSrc = 'verify.json';
  }
}
// progresso compatto come header dell'istruzione iniettata (mini-HUD, testo semplice).
// iterations+1 = l'iterazione che sta per partire (il contatore si incrementa a fine hook).
const planText = existsSync(planPath) ? readFileSync(planPath, 'utf8') : '';
// funzione (non costante): valutata al momento di ogni istruzione, cosi' riflette la fase
// che il routing ha appena impostato (evita l'off-by-one della fase "da cui si esce").
const header = () => `[perseveranza · ${renderProgress({ ...s, iterations: s.iterations + 1 }, planText)}] Task: ${s.task}.`;
let reason = null;

// routing dei modelli per fase in base alla complessita' registrata da Claude
// (hint per i subagent: il modello della sessione principale non e' modificabile da un hook)
if (!['low', 'medium', 'high'].includes(s.complexity)) s.complexity = 'medium';
const reviewModel = { low: 'haiku', medium: 'sonnet', high: 'opus' }[s.complexity];
const verifyModel = { low: 'sonnet', medium: 'opus', high: 'opus' }[s.complexity];
// riferimento a un agente del plugin con fallback: funziona sia da plugin (namespaced)
// sia da installazione manuale (agente utente), sia senza (subagent generico)
const agentRef = (name, fallback) =>
  `l'agente ${name} (subagent_type "${name}"; se l'hai installato come plugin diventa "perseveranza:${name}"; se nessuno dei due esiste, ${fallback})`;
const implHint = s.complexity === 'high'
  ? ` Il task e' ad alta complessita': delega l'implementazione a ${agentRef('pf-executor', 'un subagent executor generico')} con model=opus, tu coordina e controlla il risultato.`
  : '';

// confronto con modelli esterni (solo se rilevati all'arm) + lente security + commit per step
const externals = Array.isArray(s.externals) ? s.externals : [];
const extList = externals.join(', ');
// il verbo `ask` centralizza i flag per-CLI (e l'HTTP di ollama-cloud), esegue il modello e
// SALVA il parere in .omc-loop/external-<slot>.md: artefatto persistente e auditabile.
const askHint = (slot) => `${LOOP} ask <provider> ${slot} -- "<prompt>" (provider tra: ${extList}; per prompt lunghi passa via stdin: ... | ${LOOP} ask <provider> ${slot}; ollama-cloud interroga tutti i modelli in OLLAMA_MODEL)`;
const extPlanHint = externals.length
  ? ` Poi chiedi a un modello esterno una critica indipendente del piano con ${askHint('plan')}, passandogli task e piano; integra le osservazioni fondate (pareri salvati in .omc-loop/external-plan-*.md).`
  : '';
const extFixHint = externals.length
  ? ` Prima di riprovare, chiedi una diagnosi indipendente a un modello esterno con ${askHint('fix')}, descrivendo il problema che continua a fallire (salvata in .omc-loop/external-fix-*.md).`
  : '';
const extVerifyHint = externals.length
  ? ` In aggiunta al subagent, chiedi a uno o piu' modelli esterni di falsificare il lavoro con ${askHint('verify')}, passandogli piano e diff; pesa i loro findings (salvati in .omc-loop/external-verify-*.md).`
  : '';
const secHint = s.complexity === 'high'
  ? ' Includi una lente security: secrets nel codice, input non fidati, injection, path traversal.'
  : '';
const commitHint = s.commitSteps
  ? ' Poi committa lo step appena validato con un commit atomico, seguendo le convenzioni del repo.'
  : '';

const finalVerifyReason = () =>
  `${header()} FASE: verifica finale avversariale. Hai dichiarato il progetto completo: ora va falsificato. Delega a ${agentRef('pf-verifier', 'un subagent indipendente avversariale')} con model=${verifyModel} (contesto pulito) la verifica, passandogli nel prompt il piano completo e il diff totale (se enorme: elenco dei file + estratti rilevanti): assuma che il lavoro sia SBAGLIATO, costruisca casi limite e input ostili, esegua DAVVERO test e build, verifichi ogni claim contro l'esecuzione reale.${secHint}${extVerifyHint} NON correggere nulla in questa fase. L'agente DEVE scrivere il verdetto in .omc-loop/verify.json nel formato {"pass": true|false, "findings": [{"severity": "...", "desc": "..."}]}: e' quel file a instradare il loop. Solo se non ha potuto scriverlo, registra tu l'esito con: ${LOOP} report pass oppure: ${LOOP} report fail`;

// sospende il loop quando i fallimenti consecutivi superano il limite: serve un umano
function pauseForHuman(why) {
  s.paused = true;
  saveState();
  logStep(`${phase} -> PAUSA (${why})`);
  notify('Claude Code - OMC-loop', `Loop in pausa, serve intervento umano: ${why} - ${proj}`);
  process.exit(0);
}

// chiusura del progetto: commit+push e VERIFICA che siano avvenuti davvero.
// se la chiusura git non e' confermata (push fallito, nessun upstream, modifiche residue)
// NON dichiara finito: passa alla fase git-finish in pausa e avvisa, cosi' il lavoro non
// risulta "fatto" mentre e' ancora non pushato; dopo `resume` la chiusura viene ritentata.
function closeWithGit(isRetry) {
  let gitNote = '';
  if (s.gitFinish !== false) {
    const g = gitFinish(cwd, s.task);
    if (g.ran && !g.confirmed) {
      const why = !g.committed ? 'commit non riuscito (restano modifiche non committate)'
        : !g.hasUpstream ? 'push impossibile: nessun upstream configurato per il branch'
        : `push non confermato${g.pushErr ? ` (${g.pushErr})` : ''}`;
      s.phase = 'git-finish';
      s.paused = true;
      saveState();
      logStep(`git-finish${isRetry ? ' (retry)' : ''} NON confermato: committed=${g.committed} pushed=${g.pushed} | ${why}`);
      notify('Claude Code - OMC-loop', `Verifica OK ma chiusura git NON confermata: ${why}. Risolvi e poi esegui: resume - ${proj}`);
      process.exit(0);
    }
    if (g.ran) { gitNote = ' · commit+push confermati'; logStep(`git-finish${isRetry ? ' (retry)' : ''}: commit+push confermati`); }
    else logStep('git-finish: fuori da un repo git, salto');
  }
  disarm();
  notify('Claude Code - OMC-loop', `Progetto finito e verificato - ${proj}${gitNote}`);
  process.exit(0);
}

if (claimed) {
  // gate d'ingresso alla rampa di uscita: niente parole, solo prove.
  // (1) il piano dev'essere interamente spuntato; (2) serve un test verde fresco.
  const openSteps = (planText.match(/^[ \t]*-[ \t]*\[[ \t]*\]/gm) || []).length;
  const testRequired = !!(s.testCmd || s.lastTest);
  const freshGreen = s.lastTest
    && Number(s.lastTest.exitCode) === 0
    && Number(s.lastTest.iteration) === s.iterations;
  const testRun = s.testCmd ? `${LOOP} test -- ${s.testCmd}` : `${LOOP} test -- <comando dei test>`;
  if (openSteps > 0) {
    // non tutti i fix sono chiusi: niente rampa d'uscita finche' il piano non e' completo
    reason = `${header()} claim-done RIFIUTATO: in .omc-loop/plan.md restano ${openSteps} step non spuntati. Completali (ognuno passa per la sua review come gli altri) e, solo quando il piano e' interamente '- [x]', ridichiara: ${LOOP} claim-done.`;
  } else if (testRequired && !freshGreen) {
    // niente transizione: il claim va ripetuto con la prova
    reason = `${header()} claim-done RIFIUTATO: manca la prova di un test verde fresco. Esegui ORA: ${testRun} e, se l'esito e' verde, rilancia ${LOOP} claim-done NELLA STESSA RISPOSTA. Se e' rosso, correggi prima i fallimenti.`;
  } else if (!s.cleanedOnce) {
    // pulizia una tantum PRIMA del gate, cosi' la verifica valida il codice gia' ripulito
    s.repeated = false; s.retries = 0;
    s.cleanedOnce = true; s.phase = 'cleanup';
    reason = `${header()} FASE: cleanup pre-verifica. Hai dichiarato il progetto completo: prima del gate finale fai una passata di pulizia SENZA aggiungere funzionalita': rimuovi codice morto e duplicazioni, semplifica dove possibile senza cambiare comportamento, allinea lo stile al resto del repo, aggiorna README/docstring se il comportamento e' cambiato. Dopo la pulizia dimostra che i test restano verdi con: ${testRun}. Al prossimo stop parte la verifica finale.`;
  } else {
    s.repeated = false; s.retries = 0;
    s.phase = 'final-verify';
    dropStaleArtifact('verify.json');
    reason = finalVerifyReason();
  }
} else {
  switch (phase) {
    case 'plan': {
      if (existsSync(planPath) || s.repeated) {
        s.phase = 'implement'; s.repeated = false;
        reason = `${header()} FASE: implement. Apri .omc-loop/plan.md e implementa il PRIMO step non spuntato.${implHint} NON spuntare la casella ora: si spunta solo dopo che la review e' passata. Se per procedere serve input dell'utente: esegui ${LOOP} pause e poi fai la domanda.`;
      } else {
        s.repeated = true;
        reason = `${header()} FASE: plan. Manca .omc-loop/plan.md. PRIMA esplora il codice rilevante (moduli coinvolti, pattern esistenti, test attuali), POI scrivi il piano come checklist markdown ('- [ ] step'), step piccoli e verificabili.${extPlanHint} Poi valuta la complessita' del task e registrala con: ${LOOP} complexity low|medium|high (instrada i modelli delle fasi successive). Infine fermati.`;
      }
      break;
    }
    case 'cleanup': {
      // pulizia fatta: si passa sempre al gate finale
      s.phase = 'final-verify'; s.repeated = false;
      dropStaleArtifact('verify.json');
      reason = finalVerifyReason();
      break;
    }
    case 'implement': {
      s.phase = 'review'; s.repeated = false;
      dropStaleArtifact('review.json');
      reason = `${header()} FASE: code-review. Delega a ${agentRef('pf-reviewer', 'un subagent code-reviewer generico')} con model=${reviewModel} (contesto pulito) la review dello step appena implementato, passandogli nel prompt: lo step del piano, l'elenco dei file toccati e il diff (se enorme: elenco dei file + estratti rilevanti). Verifichi: correttezza, edge case, regressioni, sicurezza, adeguatezza dei test. L'agente DEVE scrivere il verdetto in .omc-loop/review.json nel formato {"blocking": <numero di problemi bloccanti>, "findings": [{"severity": "...", "desc": "..."}]}: e' quel file a instradare il loop. NON correggere nulla in questa fase: le correzioni appartengono alla fase di fix, dove verranno ri-revisionate. Solo se l'agente non ha potuto scrivere il file, registra tu l'esito con: ${LOOP} report pass oppure: ${LOOP} report fail. NON modificare .omc-loop/state.json a mano.`;
      break;
    }
    case 'review': {
      if (report === 'fail') {
        s.retries += 1;
        if (s.retries >= s.maxRetries) pauseForHuman(`${s.retries} review fallite sullo stesso step`);
        s.phase = 'implement'; s.repeated = false;
        reason = `${header()} FASE: fix (tentativo ${s.retries}/${s.maxRetries}). La review ha lasciato problemi aperti: correggili TUTTI restando sullo stesso step del piano ed esegui i test pertinenti.${implHint}${s.retries >= 2 ? extFixHint : ''} NON spuntare lo step.`;
      } else if (report === 'pass') {
        s.retries = 0; s.phase = 'implement'; s.repeated = false;
        reason = `${header()} FASE: implement. Review superata: spunta lo step completato in .omc-loop/plan.md ('- [x]') e appendi 2-3 righe a .omc-loop/notes.md (decisioni prese, trappole incontrate).${commitHint} Se restano step non spuntati, implementa il PROSSIMO; se la sua complessita' e' chiaramente diversa da quella registrata, prima aggiornala con: ${LOOP} complexity low|medium|high.${implHint} Se hai perso il filo, rileggi .omc-loop/plan.md e .omc-loop/notes.md. Se invece TUTTI gli step sono spuntati e il progetto e' completo, esegui: ${LOOP} claim-done (innesca la verifica finale). Se serve input dell'utente: ${LOOP} pause e poi fai la domanda.`;
      } else if (!s.repeated) {
        s.repeated = true; // resta in review, chiedi l'esito una volta sola
        reason = `${header()} FASE: code-review (esito mancante). Non hai registrato l'esito della review. Completala se serve, poi esegui ORA: ${LOOP} report pass oppure: ${LOOP} report fail`;
      } else {
        // esito mancante due volte: avanza comunque (ciclo interno tollerante)
        s.retries = 0; s.phase = 'implement'; s.repeated = false;
        reason = `${header()} FASE: implement (review senza esito registrato, considerata superata). Spunta lo step completato in .omc-loop/plan.md e appendi 2-3 righe a .omc-loop/notes.md.${commitHint} Implementa il PROSSIMO step non spuntato.${implHint} Se tutti gli step sono spuntati: ${LOOP} claim-done. D'ora in poi registra SEMPRE l'esito con report pass|fail.`;
      }
      break;
    }
    case 'final-verify': {
      if (report === 'pass') {
        logStep('final-verify -> DONE');
        closeWithGit(false); // commit+push verificati; se non confermati -> pausa, non "finito"
      } else if (report === 'fail') {
        s.finalFails += 1;
        if (s.finalFails >= s.maxRetries) pauseForHuman(`${s.finalFails} verifiche finali fallite`);
        s.phase = 'implement'; s.repeated = false;
        reason = `${header()} FASE: fix post-verifica (bocciatura ${s.finalFails}/${s.maxRetries}). La verifica finale ha trovato difetti: correggili tutti e riapri in .omc-loop/plan.md gli step interessati ('- [ ]').${implHint} Quando tutto e' di nuovo completo e testato, riesegui: ${LOOP} claim-done`;
      } else if (!s.repeated) {
        s.repeated = true; // resta in final-verify, chiedi l'esito una volta sola
        reason = `${header()} FASE: verifica finale (esito mancante). Non hai registrato l'esito della verifica. Completala se serve, poi esegui ORA: ${LOOP} report pass oppure: ${LOOP} report fail`;
      } else {
        // gate di uscita severo: esito mancante due volte = bocciatura
        s.finalFails += 1;
        if (s.finalFails >= s.maxRetries) pauseForHuman('verifica finale senza esito per 2 volte');
        s.phase = 'implement'; s.repeated = false;
        reason = `${header()} FASE: implement (verifica finale senza esito registrato: considerata FALLITA). Rivedi il lavoro, poi riesegui: ${LOOP} claim-done e stavolta registra l'esito con report pass|fail.`;
      }
      break;
    }
    case 'git-finish': {
      // ritentativo della chiusura git dopo un resume (commit/push non confermati al primo giro)
      closeWithGit(true);
      break; // closeWithGit termina il processo: irraggiungibile
    }
    default: {
      // fase sconosciuta (stato manomesso): riparti dal piano
      s.phase = 'plan'; s.repeated = false;
      reason = `${header()} FASE: plan (stato incoerente, ripristinato). Verifica .omc-loop/plan.md: se manca scrivilo come checklist '- [ ] step', poi fermati.`;
    }
  }
}

// persisti fase + contatore PRIMA di bloccare, poi logga la transizione
s.iterations += 1;
saveState();
logStep(`${phase} -> ${s.phase} | report=${report}${verdictSrc !== 'verbo' ? ` (${verdictSrc})` : ''}${claimed ? ' | claim-done' : ''}`);

// blocca lo stop e inietta l'istruzione della fase
process.stdout.write(JSON.stringify({ decision: 'block', reason }));
process.exit(0);
