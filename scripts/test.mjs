#!/usr/bin/env node
// Suite di regressione di perseveranza (zero dipendenze). Pilota lo Stop hook
// (loop-drive.mjs) con eventi FINTI e verifica le transizioni della macchina a stati,
// piu' i verbi di omc-loop.mjs. Niente mock fragili: ogni test arma un loop vero in una
// cartella temporanea, manda all'hook un evento Stop su stdin e controlla lo stato risultante.
//
//   Uso:  node scripts/test.mjs            (esce 0 se tutto verde, 1 se un test fallisce)
//
// Le notifiche desktop sono silenziate (OMC_LOOP_NO_NOTIFY) e i modelli esterni disattivati
// (--external off): il test e' deterministico e non tocca rete/desktop.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { countOpenSteps, countDoneSteps } from './hud.mjs';
import { effectiveEnv, providerModels, detectAvailable, disabledProviders, askTimeoutMs, PROVIDERS } from './providers.mjs';
import { cmpSemver } from './update.mjs';
import { underLoop, dirtyBeyondLoop, parseTimeoutMs, summarizeExternalOpinions } from './util.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const HOOK = join(SCRIPT_DIR, 'loop-drive.mjs');
const LOOP = join(SCRIPT_DIR, 'omc-loop.mjs');
const NODE = process.execPath;
const ENV = { ...process.env, OMC_LOOP_NO_NOTIFY: '1' };

// --- helper d'ambiente ----------------------------------------------------
const tmps = [];
function freshDir() {
  const d = mkdtempSync(join(tmpdir(), 'prs-test-'));
  tmps.push(d);
  return d;
}
function gatePath(dir, name) { return join(dir, '.omc-loop', name); }
function statePath(dir) { return gatePath(dir, 'state.json'); }
function readState(dir) {
  const p = statePath(dir);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return 'CORRUPT'; }
}
function patchState(dir, patch) {
  const s = readState(dir);
  writeFileSync(statePath(dir), JSON.stringify({ ...s, ...patch }, null, 2));
}
function writePlan(dir, text) { writeFileSync(gatePath(dir, 'plan.md'), text); }
function writeArtifact(dir, name, obj) { writeFileSync(gatePath(dir, name), JSON.stringify(obj)); }

// arma un loop nella cartella (modelli esterni off, niente chiusura git automatica)
function arm(dir, task = 'task di test', extra = []) {
  const r = spawnSync(NODE, [LOOP, 'arm', task, '--external', 'off', '--no-git-finish', ...extra],
    { cwd: dir, encoding: 'utf8', env: ENV });
  if (r.status !== 0) throw new Error(`arm fallito: ${r.stdout}${r.stderr}`);
}
// esegue un verbo di omc-loop (report/complexity/claim-done/pause/resume/test/...)
function loop(dir, ...args) {
  return spawnSync(NODE, [LOOP, ...args], { cwd: dir, encoding: 'utf8', env: ENV });
}
// manda un evento Stop all'hook; restituisce { blocked, reason, state, raw }
function fire(dir, evt = {}) {
  const payload = JSON.stringify({ cwd: dir, session_id: 't-sess', ...evt });
  const r = spawnSync(NODE, [HOOK], { input: payload, encoding: 'utf8', env: ENV });
  let out = null;
  const trimmed = (r.stdout || '').trim();
  if (trimmed) { try { out = JSON.parse(trimmed); } catch { /* non-JSON */ } }
  return {
    blocked: !!(out && out.decision === 'block'),
    reason: (out && out.reason) || '',
    state: readState(dir),
    raw: r.stdout || '',
  };
}

// --- mini framework di asserzioni ----------------------------------------
let passed = 0, failed = 0;
const fails = [];
function check(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: atteso ${JSON.stringify(b)}, ottenuto ${JSON.stringify(a)}`); }
function has(haystack, needle, msg) { if (!String(haystack).includes(needle)) throw new Error(`${msg}: manca "${needle}"`); }
function test(name, fn) {
  const dir = freshDir();
  try { fn(dir); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; fails.push(name); console.log(`  ✗ ${name}\n      ${e.message}`); }
}

console.log('perseveranza — suite di regressione\n');

// === conteggio checkbox (hud.mjs) ========================================
// Coprono gli helper esportati che, in uno step successivo, sostituiranno la
// regex del gate claim-done: marker/indentazione, spazi interni, fence, input
// robusto. Sono pure: la `dir` temporanea di test() qui non serve.
test('hud: marker -, *, + e indentazione (spazi/tab) sono contati', () => {
  const txt = '- [ ] a\n* [ ] b\n+ [ ] c\n  - [ ] indentato\n\t* [ ] tab\n';
  eq(countOpenSteps(txt), 5, 'cinque aperti con marker e indentazioni diverse');
  eq(countDoneSteps(txt), 0, 'nessuno spuntato');
});

test('hud: spazi interni nella casella ("- [x ]", "- [ x ]", "- [  ]")', () => {
  eq(countDoneSteps('- [x ]\n- [ x ]\n'), 2, 'spazi attorno alla x: spuntati');
  eq(countOpenSteps('- [  ]\n'), 1, 'soli spazi dentro: aperto');
  eq(countDoneSteps('- [  ]\n'), 0, 'soli spazi: non spuntato');
});

test('hud: checkbox dentro fence ``` chiuso non sono contati', () => {
  const txt = '- [ ] vero\n```\n- [ ] finto\n- [x] finto2\n```\n';
  eq(countOpenSteps(txt), 1, 'solo il checkbox fuori dal fence');
  eq(countDoneSteps(txt), 0, 'lo spuntato e\' dentro il fence');
});

test('hud: checkbox dentro fence ``` APERTO (fino a EOF) non sono contati', () => {
  eq(countOpenSteps('```\n- [ ] leaked'), 0, 'fence non chiuso: tutto rimosso');
  eq(countOpenSteps('- [ ] vero\n```\n- [ ] leaked'), 1, 'solo quello prima del fence aperto');
});

test('hud: checkbox dentro fence ~~~ non sono contati', () => {
  eq(countOpenSteps('~~~\n- [ ] x\n~~~'), 0, 'fence tilde chiuso (open)');
  eq(countDoneSteps('~~~\n- [x] x\n~~~'), 0, 'fence tilde chiuso (done)');
});

test('hud: backtick singolo (codice inline) non e\' un fence', () => {
  const txt = '- [ ] usa `[ ]` qui\n- [x] fatto\n';
  eq(countOpenSteps(txt), 1, 'la riga con inline resta un open');
  eq(countDoneSteps(txt), 1, 'la riga dopo resta done (niente viene divorato)');
});

test('hud: triple-backtick/~~~ INLINE non divora i checkbox successivi', () => {
  eq(countOpenSteps('- [ ] usa ``` nel parser\n- [x] done\n'), 1, 'la riga inline resta open');
  eq(countDoneSteps('- [ ] usa ``` nel parser\n- [x] done\n'), 1, 'il done dopo non sparisce');
  eq(countOpenSteps('- [ ] tilde ~~~ inline\n- [ ] altro\n'), 2, 'tilde inline non e\' un fence');
});

test('hud: riga link "* [a](b)" non e\' un checkbox', () => {
  eq(countOpenSteps('* [a](b)\n'), 0, 'non e\' una casella vuota');
  eq(countDoneSteps('* [a](b)\n'), 0, 'non e\' una casella spuntata');
});

test('hud: open/done si escludono sulla stessa riga', () => {
  eq(countDoneSteps('- [x]\n'), 1, '"- [x]" conta 1 done');
  eq(countOpenSteps('- [x]\n'), 0, '"- [x]" conta 0 open');
  eq(countOpenSteps('- [ ]\n'), 1, '"- [ ]" conta 1 open');
  eq(countDoneSteps('- [ ]\n'), 0, '"- [ ]" conta 0 done');
});

test('hud: input non-stringa (null/undefined/numero) -> 0 senza eccezioni', () => {
  eq(countOpenSteps(null), 0, 'null (open)');
  eq(countOpenSteps(undefined), 0, 'undefined (open)');
  eq(countOpenSteps(42), 0, 'numero (open)');
  eq(countDoneSteps(null), 0, 'null (done)');
  eq(countDoneSteps(undefined), 0, 'undefined (done)');
  eq(countDoneSteps(42), 0, 'numero (done)');
});

test('hud: retrocompatibilita\' "- [x]" done=1, "- [ ]" open=1', () => {
  eq(countDoneSteps('- [x]'), 1, 'classico done (senza newline finale)');
  eq(countOpenSteps('- [ ]'), 1, 'classico open (senza newline finale)');
  eq(countDoneSteps('- [X]'), 1, 'X maiuscola: done');
});

test('hud: BOM (U+FEFF) iniziale non nasconde il primo checkbox', () => {
  const BOM = String.fromCharCode(0xFEFF);
  eq(countOpenSteps(BOM + '- [ ] a\n- [ ] b\n'), 2, 'BOM + checkbox sulla 1a riga: entrambi contati');
  eq(countDoneSteps(BOM + '- [x] fatto\n'), 1, 'BOM + done sulla 1a riga');
});

// === dormienza e guardie =================================================
test('dormiente senza state.json: non blocca e non crea nulla', (dir) => {
  const r = fire(dir);
  check(!r.blocked, 'non deve bloccare');
  eq(r.state, null, 'non deve creare .omc-loop');
  eq(r.raw.trim(), '', 'nessun output');
});

test('arm crea lo stato in fase plan', (dir) => {
  arm(dir);
  const s = readState(dir);
  eq(s.phase, 'plan', 'fase iniziale');
  eq(s.iterations, 0, 'iterazioni a zero');
  eq(s.complexity, 'medium', 'complessita\' default');
});

test('allowStop (limite di contesto): non blocca, stato intatto', (dir) => {
  arm(dir);
  const before = readState(dir).iterations;
  const r = fire(dir, { stop_reason: 'context_limit' });
  check(!r.blocked, 'deve lasciar fermare Claude');
  eq(r.state.iterations, before, 'non deve avanzare');
});

test('pausa: non blocca e resta in pausa', (dir) => {
  arm(dir);
  loop(dir, 'pause');
  const r = fire(dir);
  check(!r.blocked, 'in pausa non deve bloccare');
  eq(r.state.paused, true, 'resta in pausa');
});

test('stato corrotto: disarma', (dir) => {
  arm(dir);
  writeFileSync(statePath(dir), '{ questo non e\' json valido ');
  const r = fire(dir);
  check(!r.blocked, 'non blocca');
  eq(readState(dir), null, 'deve disarmare');
});

test('limite di iterazioni raggiunto: disarma', (dir) => {
  arm(dir, 'task', ['--max', '5']);
  patchState(dir, { iterations: 5 });
  const r = fire(dir);
  eq(readState(dir), null, 'al limite deve disarmare');
});

// === percorso felice plan -> implement -> review -> avanzamento ==========
test('plan con plan.md presente -> implement', (dir) => {
  arm(dir);
  writePlan(dir, '- [ ] step uno\n');
  const r = fire(dir);
  check(r.blocked, 'deve bloccare e iniettare');
  eq(r.state.phase, 'implement', 'passa a implement');
  has(r.reason, 'FASE: implement', 'istruzione di implement');
});

test('implement -> review (delega al revisore)', (dir) => {
  arm(dir);
  writePlan(dir, '- [ ] step uno\n');
  fire(dir);                       // plan -> implement
  const r = fire(dir);             // implement -> review
  eq(r.state.phase, 'review', 'passa a review');
  has(r.reason, 'code-review', 'istruzione di review');
});

test('review.json blocking=0 -> avanza, retries azzerati', (dir) => {
  arm(dir);
  writePlan(dir, '- [ ] step uno\n');
  patchState(dir, { phase: 'review', retries: 1 });
  writeArtifact(dir, 'review.json', { blocking: 0, findings: [] });
  const r = fire(dir);
  eq(r.state.phase, 'implement', 'review passata: torna a implement (prossimo step)');
  eq(r.state.retries, 0, 'azzera i retry');
  has(r.reason, 'Review superata', 'istruzione di avanzamento');
  check(!existsSync(gatePath(dir, 'review.json')), 'il verdetto va consumato');
});

test('review.json blocking>0 -> fix stesso step, retry++', (dir) => {
  arm(dir);
  writePlan(dir, '- [ ] step uno\n');
  patchState(dir, { phase: 'review', retries: 0 });
  writeArtifact(dir, 'review.json', { blocking: 2, findings: [] });
  const r = fire(dir);
  eq(r.state.phase, 'implement', 'torna a implement (fix)');
  eq(r.state.retries, 1, 'incrementa i retry');
  has(r.reason, 'FASE: fix', 'istruzione di fix');
});

// === escalation ===========================================================
test('3a review fallita: pausa + handoff ESCALATION.md', (dir) => {
  arm(dir);
  writePlan(dir, '- [ ] step uno\n');
  patchState(dir, { phase: 'review', retries: 2, maxRetries: 3, lastReport: 'fail' });
  const r = fire(dir);
  eq(r.state.paused, true, 'deve mettersi in pausa');
  check(existsSync(gatePath(dir, 'ESCALATION.md')), 'deve scrivere l\'handoff');
  const doc = readFileSync(gatePath(dir, 'ESCALATION.md'), 'utf8');
  has(doc, '3 review fallite', 'motivo nel documento');
  has(doc, 'Come ripartire', 'sezione come ripartire');
});

test('resume rimuove ESCALATION.md e azzera i contatori', (dir) => {
  arm(dir);
  writePlan(dir, '- [ ] step uno\n');
  patchState(dir, { phase: 'review', retries: 2, maxRetries: 3, lastReport: 'fail' });
  fire(dir);                       // -> pausa + handoff
  loop(dir, 'resume');
  check(!existsSync(gatePath(dir, 'ESCALATION.md')), 'resume deve rimuovere l\'handoff');
  const s = readState(dir);
  eq(s.paused, false, 'non piu\' in pausa');
  eq(s.retries, 0, 'retry azzerati');
});

// === kill switch ==========================================================
test('kill switch via file STOP: disarma', (dir) => {
  arm(dir);
  writeFileSync(gatePath(dir, 'STOP'), '');
  fire(dir);
  eq(readState(dir), null, 'il file STOP deve disarmare');
});

test('kill switch via OMC_LOOP_KILL: disarma', (dir) => {
  arm(dir);
  const r = spawnSync(NODE, [HOOK], {
    input: JSON.stringify({ cwd: dir, session_id: 't-sess' }),
    encoding: 'utf8', env: { ...ENV, OMC_LOOP_KILL: '1' },
  });
  eq(readState(dir), null, 'OMC_LOOP_KILL deve disarmare');
  check(r.status === 0, 'esce pulito');
});

test('kill switch precede lo stato corrotto', (dir) => {
  arm(dir);
  writeFileSync(statePath(dir), 'spazzatura');
  writeFileSync(gatePath(dir, 'STOP'), '');
  fire(dir);
  eq(readState(dir), null, 'disarma comunque (kill in testa)');
});

// === gate di uscita: claim-done ==========================================
test('claim-done rifiutato se restano step aperti', (dir) => {
  arm(dir);
  writePlan(dir, '- [x] fatto\n- [ ] ancora aperto\n');
  patchState(dir, { phase: 'implement', claimedDone: true });
  const r = fire(dir);
  has(r.reason, 'claim-done RIFIUTATO', 'deve rifiutare');
  has(r.reason, 'non spuntati', 'spiega il perche\'');
});

test('claim-done: il gate conta anche i marker non-trattino (* / +)', (dir) => {
  // collega lo step 2 al fix dello step 1: il gate ora usa countOpenSteps, che
  // riconosce i marker [-*+]. Prima vedeva solo "- [ ]", quindi uno step "* [ ]"
  // sarebbe sfuggito e il claim sarebbe stato accettato (cleanup) per errore.
  arm(dir);
  writePlan(dir, '* [ ] aperto con asterisco\n');
  patchState(dir, { phase: 'implement', claimedDone: true });
  const r = fire(dir);
  has(r.reason, 'claim-done RIFIUTATO', 'il marker * deve contare come step aperto');
  has(r.reason, 'non spuntati', 'spiega il perche\'');
});

test('claim-done rifiutato senza test verde fresco', (dir) => {
  arm(dir, 'task', ['--test', 'node --version']);
  writePlan(dir, '- [x] tutto fatto\n');
  patchState(dir, { phase: 'implement', claimedDone: true });
  const r = fire(dir);
  has(r.reason, 'test verde fresco', 'deve pretendere la prova');
});

test('claim-done senza suite -> cleanup', (dir) => {
  arm(dir);                        // nessun --test: testRequired = false
  writePlan(dir, '- [x] tutto fatto\n');
  patchState(dir, { phase: 'implement', claimedDone: true });
  const r = fire(dir);
  eq(r.state.phase, 'cleanup', 'passa al cleanup pre-verifica');
  eq(r.state.cleanedOnce, true, 'segna il cleanup come fatto');
  has(r.reason, 'cleanup', 'istruzione di cleanup');
});

test('cleanup -> final-verify', (dir) => {
  arm(dir);
  writePlan(dir, '- [x] tutto fatto\n');
  patchState(dir, { phase: 'cleanup', cleanedOnce: true });
  const r = fire(dir);
  eq(r.state.phase, 'final-verify', 'passa alla verifica finale');
  has(r.reason, 'verifica finale', 'istruzione di verifica');
});

// === verifica finale ======================================================
test('verify.json pass:true -> chiude e disarma', (dir) => {
  arm(dir);
  writePlan(dir, '- [x] tutto fatto\n');
  patchState(dir, { phase: 'final-verify' });
  writeArtifact(dir, 'verify.json', { pass: true, findings: [] });
  fire(dir);
  eq(readState(dir), null, 'verifica passata: progetto chiuso e disarmato');
});

test('verify.json pass:false -> fix post-verifica, finalFails++', (dir) => {
  arm(dir);
  writePlan(dir, '- [x] tutto fatto\n');
  patchState(dir, { phase: 'final-verify', finalFails: 0 });
  writeArtifact(dir, 'verify.json', { pass: false, findings: [{ severity: 'critical', desc: 'x' }] });
  const r = fire(dir);
  eq(r.state.phase, 'implement', 'torna a implement');
  eq(r.state.finalFails, 1, 'incrementa i fallimenti finali');
  has(r.reason, 'fix post-verifica', 'istruzione di fix post-verifica');
});

test('3a verifica finale fallita: pausa + handoff', (dir) => {
  arm(dir);
  writePlan(dir, '- [x] tutto fatto\n');
  patchState(dir, { phase: 'final-verify', finalFails: 2, maxRetries: 3, lastReport: 'fail' });
  const r = fire(dir);
  eq(r.state.paused, true, 'pausa dopo 3 bocciature');
  check(existsSync(gatePath(dir, 'ESCALATION.md')), 'handoff scritto');
});

// === scoping per-sessione =================================================
test('un\'altra sessione non pilota il loop altrui', (dir) => {
  arm(dir);
  patchState(dir, { sessionId: 'sessione-A', lastFireAt: 0, phase: 'implement' });
  const r = fire(dir, { session_id: 'sessione-B' });
  check(!r.blocked, 'B non deve bloccare');
  eq(r.state.sessionId, 'sessione-A', 'proprieta\' invariata');
  eq(r.state.phase, 'implement', 'fase invariata (B non avanza)');
});

test('takeover dopo lunga inattivita\' del proprietario', (dir) => {
  arm(dir);
  const old = Date.now() - 7 * 60 * 60 * 1000; // 7h fa (> default 6h)
  patchState(dir, { sessionId: 'sessione-A', lastFireAt: old, phase: 'plan' });
  writePlan(dir, '- [ ] step\n');
  const r = fire(dir, { session_id: 'sessione-B' });
  check(r.blocked, 'B subentra e avanza');
  eq(r.state.sessionId, 'sessione-B', 'nuovo proprietario');
});

// === verbo test (prova non falsificabile) ================================
test('verbo test registra l\'exit code reale (verde)', (dir) => {
  arm(dir);
  const r = loop(dir, 'test', '--', 'node', '--version');
  eq(r.status, 0, 'comando verde -> exit 0');
  eq(readState(dir).lastTest.exitCode, 0, 'registra exit 0');
});

test('verbo test registra l\'exit code reale (rosso)', (dir) => {
  arm(dir);
  const r = loop(dir, 'test', '--', 'node', 'file-inesistente-xyz.js');
  check(r.status !== 0, 'comando rosso -> exit != 0');
  check(readState(dir).lastTest.exitCode !== 0, 'registra il rosso');
});

// === funzioni pure: providers.mjs e update.mjs ============================
// Importate direttamente (zero side-effect al load): coprono il parsing dei modelli
// esterni e il confronto di versione, prima privi di test diretti.
test('providers: providerModels splitta la lista CSV di ollama-cloud', () => {
  eq(JSON.stringify(providerModels('ollama-cloud', { OLLAMA_MODEL: 'a, b ,c' })), JSON.stringify(['a', 'b', 'c']), 'CSV con spazi -> trim');
  eq(JSON.stringify(providerModels('ollama-cloud', { OLLAMA_MODEL: ',, ' })), JSON.stringify(['glm-5.2']), 'solo virgole -> default (non lista vuota)');
  eq(JSON.stringify(providerModels('ollama-cloud', {})), JSON.stringify(['glm-5.2']), 'assente -> default');
  eq(JSON.stringify(providerModels('codex', {})), JSON.stringify([null]), 'CLI -> [null]');
});

test('providers: PROVIDERS ollama-cloud models/host', () => {
  eq(JSON.stringify(PROVIDERS['ollama-cloud'].models({ OLLAMA_MODEL: 'x,y' })), JSON.stringify(['x', 'y']), 'models da env');
  eq(PROVIDERS['ollama-cloud'].host({ OLLAMA_HOST: 'https://h.example/' }), 'https://h.example', 'host senza slash finale');
  eq(PROVIDERS['ollama-cloud'].host({}), 'https://ollama.com', 'host default');
});

test('providers: detectAvailable rispetta has/env/platform e la denylist', () => {
  eq(JSON.stringify(detectAvailable({ has: () => false, env: {}, platform: 'win32' })), JSON.stringify([]), 'niente CLI/chiave -> []');
  check(detectAvailable({ has: (n) => n === 'codex', env: {}, platform: 'win32' }).includes('codex'), 'codex rilevato');
  check(detectAvailable({ has: (n) => n === 'agy', env: {}, platform: 'win32' }).includes('agy'), 'agy rilevato ANCHE su win32 (stdin headless verificato con la 1.1.3)');
  check(detectAvailable({ has: (n) => n === 'agy', env: {}, platform: 'linux' }).includes('agy'), 'agy su linux');
  check(!('gemini' in PROVIDERS), 'gemini non e\' piu\' nel registro (free tier dismesso: al suo posto agy)');
  check(detectAvailable({ has: () => false, env: { OLLAMA_API_KEY: 'k' }, platform: 'linux' }).includes('ollama-cloud'), 'ollama-cloud se c\'e\' la chiave');
  eq(JSON.stringify(detectAvailable({ has: (n) => n === 'codex', env: {}, platform: 'win32', disabled: ['codex'] })), JSON.stringify([]), 'denylist: escluso anche se presente');
});

test('providers: registro claude/grok/cursor (argv puri, cwd isolata)', () => {
  check(detectAvailable({ has: (n) => n === 'claude', env: {}, platform: 'win32' }).includes('claude'), 'claude rilevato');
  check(detectAvailable({ has: (n) => n === 'grok', env: {}, platform: 'linux' }).includes('grok'), 'grok rilevato');
  check(detectAvailable({ has: (n) => n === 'cursor-agent', env: {}, platform: 'win32' }).includes('cursor'), 'cursor rilevato via binario cursor-agent');
  const hostile = 'prompt con "doppi apici", %PATH%, $HOME e ^caret';
  const g = PROVIDERS.grok.argv(hostile);
  eq(g[0], 'grok', 'grok: argv[0] e\' il binario');
  check(g.includes(hostile), 'grok: il prompt e\' UN SOLO elemento argv, intatto');
  const c = PROVIDERS.cursor.argv(hostile);
  eq(c[0], 'cursor-agent', 'cursor: argv[0] e\' cursor-agent');
  eq(c[c.length - 1], hostile, 'cursor: prompt come ultimo argomento posizionale, intatto');
  eq(PROVIDERS.claude.cmdline(), 'claude -p', 'claude: print mode, prompt su stdin');
  for (const id of ['claude', 'grok', 'cursor']) {
    const d = PROVIDERS[id].cwd();
    check(typeof d === 'string' && d.length > 0 && !d.includes('.omc-loop'), `${id}: cwd isolata fuori dal progetto`);
  }
});

test('providers: disabledProviders legge la denylist dal file di config', (dir) => {
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({ providers: { disabled: ['codex', 'agy'] } }));
  eq(JSON.stringify(disabledProviders(cfg)), JSON.stringify(['codex', 'agy']), 'lista letta dal file');
  eq(JSON.stringify(disabledProviders(join(dir, 'niente.json'))), JSON.stringify([]), 'file assente -> nessun disabilitato');
  writeFileSync(cfg, JSON.stringify({ providers: { disabled: 'codex' } }));
  eq(JSON.stringify(disabledProviders(cfg)), JSON.stringify([]), 'formato non-array -> ignorato senza crash');
});

test('providers: askTimeoutMs (override > OMC_ASK_TIMEOUT_MS validata > default 180s)', () => {
  eq(askTimeoutMs({}, null), 180000, 'default 180s');
  eq(askTimeoutMs({ OMC_ASK_TIMEOUT_MS: '600000' }), 600000, 'env valida');
  eq(askTimeoutMs({ OMC_ASK_TIMEOUT_MS: 'abc' }), 180000, 'env non valida -> default');
  eq(askTimeoutMs({ OMC_ASK_TIMEOUT_MS: '-5' }), 180000, 'negativa -> default');
  eq(askTimeoutMs({ OMC_ASK_TIMEOUT_MS: '600000' }, 60000), 60000, 'override esplicito batte la env');
});

test('providers: effectiveEnv precedenza env > file > default', (dir) => {
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({ ollama: { apiKey: 'FILEKEY', model: 'filemodel', host: 'https://file.host' } }));
  const e1 = effectiveEnv({ OLLAMA_MODEL: 'envmodel' }, cfg);
  eq(e1.OLLAMA_MODEL, 'envmodel', 'env batte file');
  eq(e1.OLLAMA_API_KEY, 'FILEKEY', 'la chiave assente in env arriva dal file');
  const e2 = effectiveEnv({}, cfg);
  eq(e2.OLLAMA_MODEL, 'filemodel', 'file riempie OLLAMA_MODEL');
  eq(e2.OLLAMA_HOST, 'https://file.host', 'file riempie OLLAMA_HOST');
  const e3 = effectiveEnv({}, join(dir, 'nonexistent.json'));
  eq(e3.OLLAMA_MODEL, undefined, 'nessun file -> nessun model (default a valle)');
});

test('update: cmpSemver confronta numericamente (non lessicalmente)', () => {
  check(cmpSemver('1.2.0', '1.1.0') > 0, '1.2.0 > 1.1.0');
  check(cmpSemver('1.1.0', '1.2.0') < 0, '1.1.0 < 1.2.0');
  eq(cmpSemver('1.0.0', '1.0.0'), 0, 'uguali -> 0');
  check(cmpSemver('1.10.0', '1.9.0') > 0, '1.10.0 > 1.9.0 (numerico)');
  check(cmpSemver('2.0.0', '1.9.9') > 0, 'major piu\' alto vince');
  eq(cmpSemver('1.2', '1.2.0'), 0, 'lunghezze diverse -> componenti mancanti = 0');
});

// === util.mjs (predicati git + timeout) ==================================
// Unit test DISCRIMINANTI sui predicati estratti da loop-drive/statusline: pure,
// importate direttamente. Coprono casi che il test e2e su gitFinish non distingue
// (il bug del substring, i rename a due lati), senza dover armare un repo git.
test('util: underLoop match per PREFISSO, non substring', () => {
  eq(underLoop('.omc-loop'), true, 'la cartella stessa');
  eq(underLoop('.omc-loop/state.json'), true, 'un file sotto .omc-loop/');
  eq(underLoop('src/omc-loop-helper.js'), false, 'substring "omc-loop" nel nome NON e\' stato del loop (il bug)');
  eq(underLoop('.omc-loopx/foo'), false, 'prefisso simile ma cartella diversa');
  eq(underLoop('".omc-loop/x"'), true, 'path quotato da git: de-quotato e riconosciuto');
});

test('util: dirtyBeyondLoop distingue lavoro vero da stato del loop', () => {
  eq(dirtyBeyondLoop(' M src/omc-loop-helper.js'), true, 'file di lavoro modificato -> sporco');
  eq(dirtyBeyondLoop(' M .omc-loop/state.json'), false, 'solo stato del loop -> pulito');
  eq(dirtyBeyondLoop('R  .omc-loop/a -> .omc-loop/b'), false, 'rename interamente dentro .omc-loop/ -> pulito');
  eq(dirtyBeyondLoop('R  src/old.js -> src/new.js'), true, 'rename di file di lavoro (un lato fuori) -> sporco');
  eq(dirtyBeyondLoop(' M .omc-loop/x\n M src/foo.js'), true, 'almeno una riga fuori da .omc-loop/ -> sporco');
  eq(dirtyBeyondLoop(''), false, 'output vuoto -> pulito');
});

test('util: summarizeExternalOpinions distingue pareri ok da falliti', () => {
  const okArt = { label: 'codex', text: '# Parere esterno - codex\n\n- slot: verify\n- esito: ok\n\n## Risposta\n\n...' };
  const koArt = { label: 'ollama-cloud-glm-5.2', text: '- slot: verify\n- esito: ERRORE\n' };
  eq(JSON.stringify(summarizeExternalOpinions([okArt, koArt])),
    JSON.stringify({ attempted: 2, ok: 1, failed: ['ollama-cloud-glm-5.2'] }), 'un ok e un fallito');
  eq(JSON.stringify(summarizeExternalOpinions([])), JSON.stringify({ attempted: 0, ok: 0, failed: [] }), 'nessun artefatto');
  eq(JSON.stringify(summarizeExternalOpinions(null)), JSON.stringify({ attempted: 0, ok: 0, failed: [] }), 'input non-array -> zero senza crash');
  eq(summarizeExternalOpinions([{ label: 'x', text: 'senza riga esito' }]).ok, 0, 'testo senza riga esito -> non ok');
});

test('util: parseTimeoutMs robusto (intero positivo, floor, default)', () => {
  eq(parseTimeoutMs('1500.5', 5000), 1500, 'tronca a intero');
  eq(parseTimeoutMs('-1000', 5000), 5000, 'negativo -> default');
  eq(parseTimeoutMs('abc', 5000), 5000, 'NaN -> default');
  eq(parseTimeoutMs('0', 5000), 5000, 'zero -> default');
  eq(parseTimeoutMs('9000', 5000), 9000, 'intero valido sopra il floor');
  eq(parseTimeoutMs('500', 5000), 1000, 'sotto il floor 1000 -> floor');
  eq(parseTimeoutMs(undefined, 5000), 5000, 'assente -> default');
});

// === chiusura git (repo temporaneo) ======================================
// Esercitano gitFinish/closeWithGit PER DAVVERO: un repo git vero in tmp, con un
// bare remote LOCALE come origin/main (push offline e deterministico, niente rete,
// nessun repo reale toccato). Se git non c'e', ogni test si auto-salta con una nota.
// NB: questi arm NON passano --no-git-finish (serve la chiusura git reale), a
// differenza dell'helper arm() generico che la disattiva.

// arma un loop CON chiusura git attiva (l'helper arm() forza --no-git-finish)
function armGitFinish(dir, task = 'lavoro completato', extra = []) {
  const r = spawnSync(NODE, [LOOP, 'arm', task, '--external', 'off', ...extra],
    { cwd: dir, encoding: 'utf8', env: ENV });
  if (r.status !== 0) throw new Error(`arm (git) fallito: ${r.stdout}${r.stderr}`);
}
// crea un repo git vero in tmp; con withRemote anche un bare remote locale come origin/main.
// Ritorna { dir, g, remote } oppure null se git e' assente (-> il chiamante salta il test).
function gitRepo({ withRemote } = {}) {
  const dir = freshDir();
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  if (g('init', '-q').status !== 0) return null; // git assente -> il chiamante salta il test
  g('config', 'user.email', 't@t'); g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false'); // niente firma: deterministico anche con gpg locale attivo
  writeFileSync(join(dir, 'README.md'), 'init\n'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  g('branch', '-M', 'main');
  let remote = null;
  if (withRemote) {
    remote = freshDir();
    spawnSync('git', ['init', '--bare', '-q', remote], { encoding: 'utf8' });
    g('remote', 'add', 'origin', remote);
    g('push', '-q', '-u', 'origin', 'main'); // imposta l'upstream main
  }
  return { dir, g, remote };
}
// log compatto di un branch del bare remote (ref esplicito: evita ambiguita' sull'HEAD del bare)
function remoteLog(remote, ref = 'main') {
  return spawnSync('git', ['-C', remote, 'log', '--oneline', ref], { encoding: 'utf8' }).stdout || '';
}
// porta un loop armato fino allo Stop che innesca la chiusura git (final-verify -> pass)
function driveToClose(repo) {
  writePlan(repo.dir, '- [x] tutto fatto\n');
  patchState(repo.dir, { phase: 'final-verify' });
  writeArtifact(repo.dir, 'verify.json', { pass: true, findings: [] });
  return fire(repo.dir);
}

test('git: commit+push confermati -> disarma e il commit arriva sul remoto', () => {
  const repo = gitRepo({ withRemote: true });
  if (!repo) { console.log('    (git assente: test chiusura git saltato)'); return; }
  writeFileSync(join(repo.dir, 'work.txt'), 'lavoro del task\n'); // file di lavoro non committato
  armGitFinish(repo.dir);
  driveToClose(repo);
  eq(readState(repo.dir), null, 'chiusura confermata: loop disarmato');
  has(remoteLog(repo.remote), 'perseveranza', 'il commit perseveranza e\' arrivato sul bare remote');
});

test('git: nessun upstream -> pausa in fase git-finish (non disarma)', () => {
  const repo = gitRepo(); // niente remote -> niente upstream
  if (!repo) { console.log('    (git assente: test chiusura git saltato)'); return; }
  armGitFinish(repo.dir);
  driveToClose(repo);
  const s = readState(repo.dir);
  check(s !== null && s !== 'CORRUPT', 'senza upstream NON deve disarmare');
  eq(s.phase, 'git-finish', 'resta in git-finish per il retry dopo resume');
  eq(s.paused, true, 'in pausa: serve l\'umano (configurare l\'upstream)');
});

test('git: --no-push con upstream -> commit locale, disarma, niente push sul remoto', () => {
  const repo = gitRepo({ withRemote: true });
  if (!repo) { console.log('    (git assente: test chiusura git saltato)'); return; }
  writeFileSync(join(repo.dir, 'work.txt'), 'lavoro del task\n');
  armGitFinish(repo.dir, 'lavoro completato', ['--no-push']);
  driveToClose(repo);
  eq(readState(repo.dir), null, '--no-push: il solo commit locale conferma -> disarma');
  has(repo.g('log', '--format=%s').stdout, 'perseveranza', 'il commit perseveranza e\' nel repo LOCALE');
  check(!remoteLog(repo.remote).includes('perseveranza'), 'NON pushato: il bare remote non ha il commit');
});

test('git: filtro .omc-loop rename-safe (src/omc-loop-helper.js e\' lavoro vero)', () => {
  const repo = gitRepo({ withRemote: true });
  if (!repo) { console.log('    (git assente: test chiusura git saltato)'); return; }
  mkdirSync(join(repo.dir, 'src'), { recursive: true });
  writeFileSync(join(repo.dir, 'src', 'omc-loop-helper.js'), '// lavoro vero, non stato del loop\n');
  armGitFinish(repo.dir);
  driveToClose(repo);
  eq(readState(repo.dir), null, 'chiusura confermata: disarmato');
  const files = repo.g('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').stdout;
  has(files, 'omc-loop-helper.js', 'il file con "omc-loop" nel nome e\' committato (non scambiato per stato)');
});

test('git: gate senza parere esterno riuscito -> nota durevole nel commit', () => {
  const repo = gitRepo({ withRemote: true });
  if (!repo) { console.log('    (git assente: test chiusura git saltato)'); return; }
  writeFileSync(join(repo.dir, 'work.txt'), 'lavoro del task\n');
  armGitFinish(repo.dir);
  // simula il run reale: provider rilevati all'arm, ma al gate tutti i pareri falliti
  patchState(repo.dir, { externals: ['codex', 'ollama-cloud'] });
  writeFileSync(gatePath(repo.dir, 'external-verify-codex.md'),
    '# Parere esterno - codex\n\n- slot: verify\n- esito: ERRORE\n\n## Risposta\n\nrifiuto policy\n');
  driveToClose(repo);
  eq(readState(repo.dir), null, 'chiusura confermata: disarmato');
  const body = repo.g('log', '-1', '--format=%B').stdout;
  has(body, 'falsificazione esterna indisponibile', 'nota nel corpo del commit');
  has(body, '0/1 pareri riusciti', 'conteggio dei pareri');
  has(body, 'codex', 'etichetta del provider fallito');
});

test('git: parere esterno riuscito al gate -> NESSUNA nota nel commit', () => {
  const repo = gitRepo({ withRemote: true });
  if (!repo) { console.log('    (git assente: test chiusura git saltato)'); return; }
  writeFileSync(join(repo.dir, 'work.txt'), 'lavoro del task\n');
  armGitFinish(repo.dir);
  patchState(repo.dir, { externals: ['codex'] });
  writeFileSync(gatePath(repo.dir, 'external-verify-codex.md'),
    '# Parere esterno - codex\n\n- slot: verify\n- esito: ok\n\n## Risposta\n\nnessuna falsificazione trovata\n');
  driveToClose(repo);
  eq(readState(repo.dir), null, 'chiusura confermata: disarmato');
  const body = repo.g('log', '-1', '--format=%B').stdout;
  check(!body.includes('falsificazione esterna'), 'niente nota quando almeno un parere e\' riuscito');
});

test('git: provider rilevati ma nessun parere registrato -> nota "non registrata"', () => {
  const repo = gitRepo({ withRemote: true });
  if (!repo) { console.log('    (git assente: test chiusura git saltato)'); return; }
  writeFileSync(join(repo.dir, 'work.txt'), 'lavoro del task\n');
  armGitFinish(repo.dir);
  patchState(repo.dir, { externals: ['codex'] }); // nessun external-verify-*.md scritto
  driveToClose(repo);
  eq(readState(repo.dir), null, 'chiusura confermata: disarmato');
  const body = repo.g('log', '-1', '--format=%B').stdout;
  has(body, 'falsificazione esterna non registrata', 'nota quando i pareri mancano del tutto');
  has(body, 'sola verifica interna', 'esplicita su cosa poggia il pass');
});

test('git: baselineDirty finisce nel corpo del commit (avviso durevole)', () => {
  const repo = gitRepo({ withRemote: true });
  if (!repo) { console.log('    (git assente: test chiusura git saltato)'); return; }
  writeFileSync(join(repo.dir, 'README.md'), 'init\nmodifica PRIMA dell\'arm\n'); // tracciato, gia' sporco
  armGitFinish(repo.dir); // l'arm cattura README.md in baselineDirty
  eq((readState(repo.dir).baselineDirty || []).join(','), 'README.md', 'arm registra il file pre-sporco');
  driveToClose(repo);
  eq(readState(repo.dir), null, 'chiusura confermata: disarmato');
  const body = repo.g('log', '-1', '--format=%B').stdout;
  has(body, 'Nota perseveranza:', 'il corpo del commit porta la nota durevole');
  has(body, 'README.md', 'la nota cita il file pre-modificato');
});

// --- esito ----------------------------------------------------------------
for (const d of tmps) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passati, ${failed} falliti`);
if (failed) { console.log(`   falliti: ${fails.join(', ')}`); process.exit(1); }
process.exit(0);
