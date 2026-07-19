// Il "prompt pack" del loop: i template delle istruzioni che lo Stop hook inietta a ogni
// fase, estratti da loop-drive.mjs per essere SOVRASCRIVIBILI senza toccare il codice.
//
// Personalizzazione (override):
//   - env OMC_PROMPT_PACK=<path a un JSON>   (precedenza piu' alta)
//   - .omc-loop/prompts.json nel progetto     (comodo per pack per-run: muore col disarm)
//   Formato: { "prompts": { "<chiave>": "template con {{placeholder}}" } }
//   Chiavi sconosciute vengono ignorate; un file illeggibile fa ricadere sui default
//   (l'hook non deve mai rompersi per un pack sbagliato) e viene segnalato in history.log.
//
// Regole dei template:
//   - i placeholder sono {{nome}}; uno sconosciuto resta LETTERALE nel testo (diagnostica
//     onesta: si vede subito il typo nel pack), mai un crash;
//   - l'header HUD ([perseveranza · fase · barra...]) NON fa parte dei template: lo antepone
//     sempre l'hook. Un pack non puo' spegnere l'osservabilita' del loop;
//   - i default cambiano SOLO per decisione consapevole e con evidenza, mai per deriva:
//     la suite di regressione li esercita via fire() ed e' la rete contro le divergenze.
//     In 1.19.0 tre chiavi (plan-write, implement-first, review-advance) hanno adottato le
//     guide del pack vincente del primo esperimento SIA (bench/: baseline 0.7369 -> 0.9437),
//     giudicate valide anche a prescindere dai numeri; il resto e' identico allo storico.
//
// Nato per la sperimentazione SIA-style (evolvere i prompt misurandoli su un benchmark),
// utile anche per l'A/B testing manuale delle istruzioni.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_PROMPTS = {
  // --- hint componibili (entrano nelle istruzioni di fase come {{...}}) ---
  'hint-impl-high': ` Il task e' ad alta complessita': delega l'implementazione a {{executorRef}} con model=opus, tu coordina e controlla il risultato.`,
  'hint-ask': `{{LOOP}} ask <provider> {{slot}} -- "<prompt>" (provider tra: {{extList}}; per prompt lunghi passa via stdin: ... | {{LOOP}} ask <provider> {{slot}}; ollama-cloud interroga tutti i modelli in OLLAMA_MODEL)`,
  'hint-ext-framing': ` dichiarando nel prompt il contesto legittimo (review difensiva del PROPRIO codice, progetto autorizzato: evita i falsi rifiuti dei filtri di policy)`,
  'hint-ext-plan': ` Poi chiedi a un modello esterno una critica indipendente del piano con {{askHint}}, passandogli task e piano; integra le osservazioni fondate (pareri salvati in .omc-loop/external-plan-*.md).`,
  'hint-ext-fix': ` Prima di riprovare, chiedi una diagnosi indipendente a un modello esterno con {{askHint}}, descrivendo il problema che continua a fallire{{extFraming}}; diagnosi salvata in .omc-loop/external-fix-*.md.`,
  'hint-ext-verify': ` In aggiunta al subagent, chiedi a uno o piu' modelli esterni di falsificare il lavoro con {{askHint}}, passandogli piano e diff{{extFraming}}. Pesa i loro findings (salvati in .omc-loop/external-verify-*.md); un rifiuto di policy, un errore o un timeout del provider NON e' un finding: se nessun esterno risponde, prosegui col solo verdetto del subagent (la chiusura lo annota nel commit).`,
  'hint-security': ` Includi una lente security: secrets nel codice, input non fidati, injection, path traversal.`,
  'hint-commit': ` Poi committa lo step appena validato con un commit atomico, seguendo le convenzioni del repo.`,

  // --- fase plan ---
  'plan-write': `FASE: plan. Manca .omc-loop/plan.md. PRIMA esplora il codice rilevante (moduli coinvolti, pattern esistenti, test attuali), POI scrivi il piano come checklist markdown ('- [ ] step'), step piccoli e verificabili — ma NON frammentare in micro-step cio' che e' un unico cambiamento coeso (es. un helper insieme a TUTTI i suoi punti di chiamata): ogni step apre un intero giro di review, quindi raggruppa cio' che ha senso solo se verificato insieme.{{extPlanHint}} Poi valuta la complessita' del task CON ONESTA' (una modifica piccola e ben isolata e' spesso low, non medium per default) e registrala con: {{LOOP}} complexity low|medium|high (instrada i modelli delle fasi successive). Infine fermati.`,
  'plan-approval': `FASE: approvazione del piano (--approve-plan). Il piano e' scritto e il loop e' in PAUSA. Presenta ORA all'utente una sintesi del piano (obiettivo, gli step con il loro numero, scelte e rischi principali) e spiegagli che per approvarlo e avviare l'implementazione deve eseguire: {{LOOP}} resume (prima puo' modificare .omc-loop/plan.md a mano). NON iniziare a implementare e NON eseguire tu il resume: l'approvazione spetta all'utente.`,
  'implement-first': `FASE: implement. Apri .omc-loop/plan.md e implementa il PRIMO step non spuntato.{{implHint}} Copri TUTTO cio' che lo step promette, inclusi i casi limite e gli input ostili gia' descritti nella specifica o nei commenti del codice (non solo il caso comune): una review che trova un caso mancante costa un intero giro in piu'. NON spuntare la casella ora: si spunta solo dopo che la review e' passata. Se per procedere serve input dell'utente: esegui {{LOOP}} pause e poi fai la domanda.`,

  // --- fase review ---
  'review-delegate': `FASE: code-review. Delega a {{reviewerRef}} con model={{reviewModel}} (contesto pulito) la review dello step appena implementato, passandogli nel prompt: lo step del piano, l'elenco dei file toccati e il diff (se enorme: elenco dei file + estratti rilevanti). Verifichi: correttezza, edge case, regressioni, sicurezza, adeguatezza dei test. L'agente DEVE scrivere il verdetto in .omc-loop/review.json nel formato {"blocking": <numero di problemi bloccanti>, "findings": [{"severity": "...", "desc": "..."}]}: e' quel file a instradare il loop. NON correggere nulla in questa fase: le correzioni appartengono alla fase di fix, dove verranno ri-revisionate. Solo se l'agente non ha potuto scrivere il file, registra tu l'esito con: {{LOOP}} report pass oppure: {{LOOP}} report fail. NON modificare .omc-loop/state.json a mano.`,
  'review-fix': `FASE: fix (tentativo {{retries}}/{{maxRetries}}). La review ha lasciato problemi aperti: correggili TUTTI restando sullo stesso step del piano ed esegui i test pertinenti.{{implHint}}{{extFixHint}} NON spuntare lo step.`,
  'review-advance': `FASE: implement. Review superata: spunta lo step completato in .omc-loop/plan.md ('- [x]') e appendi 2-3 righe a .omc-loop/notes.md (decisioni prese, trappole incontrate).{{commitHint}} Se restano step non spuntati, implementa il PROSSIMO; se la sua complessita' e' chiaramente diversa da quella registrata, prima aggiornala con: {{LOOP}} complexity low|medium|high.{{implHint}} Se hai perso il filo, rileggi .omc-loop/plan.md e .omc-loop/notes.md. Se invece TUTTI gli step sono spuntati e il progetto e' completo: esegui PRIMA la suite col verbo test ({{LOOP}} test -- <comando>) per avere una prova verde fresca (un claim-done senza prova fresca viene rifiutato e costa un giro intero), e NELLA STESSA RISPOSTA esegui: {{LOOP}} claim-done (innesca la verifica finale). Se serve input dell'utente: {{LOOP}} pause e poi fai la domanda.`,
  'review-missing-outcome': `FASE: code-review (esito mancante). Non hai registrato l'esito della review. Completala se serve, poi esegui ORA: {{LOOP}} report pass oppure: {{LOOP}} report fail`,
  'review-advance-no-outcome': `FASE: implement (review senza esito registrato, considerata superata). Spunta lo step completato in .omc-loop/plan.md e appendi 2-3 righe a .omc-loop/notes.md.{{commitHint}} Implementa il PROSSIMO step non spuntato.{{implHint}} Se tutti gli step sono spuntati: {{LOOP}} claim-done. D'ora in poi registra SEMPRE l'esito con report pass|fail.`,

  // --- rampa di uscita: claim-done, cleanup, verifica finale ---
  'claim-open-steps': `claim-done RIFIUTATO: in .omc-loop/plan.md restano {{openSteps}} step non spuntati. Completali (ognuno passa per la sua review come gli altri) e, solo quando il piano e' interamente '- [x]', ridichiara: {{LOOP}} claim-done.`,
  'claim-no-fresh-test': `claim-done RIFIUTATO: manca la prova di un test verde fresco. Esegui ORA: {{testRun}} e, se l'esito e' verde, rilancia {{LOOP}} claim-done NELLA STESSA RISPOSTA. Se e' rosso, correggi prima i fallimenti.`,
  'cleanup': `FASE: cleanup pre-verifica. Hai dichiarato il progetto completo: prima del gate finale fai una passata di pulizia SENZA aggiungere funzionalita': rimuovi codice morto e duplicazioni, semplifica dove possibile senza cambiare comportamento, allinea lo stile al resto del repo, aggiorna README/docstring se il comportamento e' cambiato. Dopo la pulizia dimostra che i test restano verdi con: {{testRun}}. Al prossimo stop parte la verifica finale.`,
  'final-verify': `FASE: verifica finale avversariale. Hai dichiarato il progetto completo: ora va falsificato. Delega a {{verifierRef}} con model={{verifyModel}} (contesto pulito) la verifica, passandogli nel prompt il piano completo e il diff totale (se enorme: elenco dei file + estratti rilevanti): assuma che il lavoro sia SBAGLIATO, costruisca casi limite e input ostili, esegua DAVVERO test e build, verifichi ogni claim contro l'esecuzione reale.{{secHint}}{{extVerifyHint}} NON correggere nulla in questa fase. L'agente DEVE scrivere il verdetto in .omc-loop/verify.json nel formato {"pass": true|false, "findings": [{"severity": "...", "desc": "..."}]}: e' quel file a instradare il loop. Solo se non ha potuto scriverlo, registra tu l'esito con: {{LOOP}} report pass oppure: {{LOOP}} report fail`,
  'verify-postfix': `FASE: fix post-verifica (bocciatura {{finalFails}}/{{maxRetries}}). La verifica finale ha trovato difetti: correggili tutti e riapri in .omc-loop/plan.md gli step interessati ('- [ ]').{{implHint}} Quando tutto e' di nuovo completo e testato, riesegui: {{LOOP}} claim-done`,
  'verify-missing-outcome': `FASE: verifica finale (esito mancante). Non hai registrato l'esito della verifica. Completala se serve, poi esegui ORA: {{LOOP}} report pass oppure: {{LOOP}} report fail`,
  'verify-failed-no-outcome': `FASE: implement (verifica finale senza esito registrato: considerata FALLITA). Rivedi il lavoro, poi riesegui: {{LOOP}} claim-done e stavolta registra l'esito con report pass|fail.`,

  // --- recupero da stato incoerente ---
  'phase-recovered': `FASE: plan (stato incoerente, ripristinato). Verifica .omc-loop/plan.md: se manca scrivilo come checklist '- [ ] step', poi fermati.`,
};

// rendering puro: template (override se presente, altrimenti default) + variabili.
// Un placeholder senza variabile resta letterale; una chiave sconosciuta rende ''.
export function renderPrompt(key, vars = {}, overrides = {}) {
  const tpl = overrides && typeof overrides[key] === 'string' ? overrides[key] : DEFAULT_PROMPTS[key];
  if (typeof tpl !== 'string') return '';
  return tpl.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m);
}

// carica gli override: env OMC_PROMPT_PACK > <gateDir>/prompts.json > nessuno.
// Non lancia MAI: un file illeggibile produce { overrides: {}, error } e si va di default.
export function loadPromptOverrides(gateDir, env = {}) {
  const candidates = [];
  if (env.OMC_PROMPT_PACK) candidates.push({ path: String(env.OMC_PROMPT_PACK), source: 'OMC_PROMPT_PACK' });
  if (gateDir) candidates.push({ path: join(gateDir, 'prompts.json'), source: '.omc-loop/prompts.json' });
  for (const c of candidates) {
    try {
      if (!existsSync(c.path)) continue;
      const raw = JSON.parse(readFileSync(c.path, 'utf8'));
      const src = raw && typeof raw === 'object' && raw.prompts && typeof raw.prompts === 'object' ? raw.prompts : {};
      const overrides = {};
      for (const [k, v] of Object.entries(src)) {
        if (typeof v === 'string' && k in DEFAULT_PROMPTS) overrides[k] = v; // chiavi ignote: ignorate
      }
      return { overrides, source: c.source, error: null };
    } catch (e) {
      return { overrides: {}, source: c.source, error: e.message };
    }
  }
  return { overrides: {}, source: null, error: null };
}
