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

// --- esito ----------------------------------------------------------------
for (const d of tmps) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passati, ${failed} falliti`);
if (failed) { console.log(`   falliti: ${fails.join(', ')}`); process.exit(1); }
process.exit(0);
