// Registro centralizzato dei provider di modelli esterni (il "secondo parere" indipendente).
// UNICA fonte di verita' per: come si rilevano, come si interrogano, quale modello/chiave usano.
// Cosi' aggiungere un provider = una voce qui, niente flag sparsi nel resto del codice.
//
// Due trasporti:
//   - cli : una CLI locale (codex / agy / grok / cursor / claude) invocata con i suoi flag
//   - http: una API remota (ollama-cloud) chiamata via fetch
//
// Tre stili di invocazione CLI, per rispettare i vincoli di ciascun binario SENZA mai
// esporre il prompt a una shell:
//   - cmdline(): flag fissi via shell (per i .cmd di npm su Windows), prompt su stdin;
//   - argv():    array di argomenti SENZA shell (per le CLI che riservano stdin e vogliono
//                il prompt come argomento: nessun quoting possibile, argv puri);
//   - cwd():     directory di lavoro isolata per il processo figlio (vedi note per-provider).
//
// Il timeout di un parere e' configurabile con OMC_ASK_TIMEOUT_MS (ms, default 180s,
// floor 1s, validato): i prompt di falsificazione al gate (piano + diff) su modelli
// grossi possono legittimamente superare i 3 minuti.
//
// SICUREZZA: la chiave di ollama-cloud vive SOLO in OLLAMA_API_KEY (variabile d'ambiente
// locale), non viene mai scritta su disco ne' negli artefatti ne' nel repo.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTimeoutMs } from './util.mjs';

// File di configurazione locale (FUORI dal repo, nel profilo utente): tiene la chiave e i
// modelli senza doverli mettere tra le variabili d'ambiente (niente `setx`/riavvio shell).
// Formato:  { "ollama": { "apiKey": "...", "model": "glm-5.2,kimi-k2.7-code", "host": "..." } }
// La chiave NON va mai nel repo: questo file vive in ~/.perseveranza/config.json.
export const CONFIG_PATH = join(homedir(), '.perseveranza', 'config.json');

export function loadConfig(path = CONFIG_PATH) {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, 'utf8')) || {};
  } catch { return {}; }
}

// env "effettivo" per i provider: parte dall'ambiente reale e RIEMPIE i buchi dal file.
// Precedenza: variabile d'ambiente reale > file di config > default del registro.
export function effectiveEnv(realEnv = {}, path = CONFIG_PATH) {
  const o = (loadConfig(path).ollama) || {};
  const m = { ...realEnv };
  if (m.OLLAMA_API_KEY == null && o.apiKey) m.OLLAMA_API_KEY = String(o.apiKey);
  if (m.OLLAMA_MODEL == null && o.model) m.OLLAMA_MODEL = String(o.model);
  if (m.OLLAMA_HOST == null && o.host) m.OLLAMA_HOST = String(o.host);
  return m;
}

export const PROVIDERS = {
  // NOTA invocazione CLI: il prompt viaggia SEMPRE su stdin, mai sulla command line.
  // Cosi' la riga di comando contiene solo flag fissi (nessun input utente) ed evitiamo del
  // tutto i problemi di quoting/escape della shell su Windows (in particolare il `%` di cmd.exe
  // non e' quotabile). `shell: true` serve a risolvere i .cmd di npm su Windows.
  codex: {
    transport: 'cli',
    detect: ({ has }) => has('codex'),
    // exec = non interattivo; --skip-git-repo-check per girare anche fuori da un repo git;
    // legge il prompt da stdin
    cmdline: () => 'codex exec --skip-git-repo-check',
  },
  agy: {
    transport: 'cli',
    // headless via stdin non-TTY: agy esegue il prompt e stampa la risposta su stdout,
    // senza flag (dalla 1.1.x `-p ""` viene rifiutato: "Error: empty prompt", e il prompt
    // NON deve mai finire sulla command line). Verificato su Windows con la 1.1.3: il
    // vecchio bug della print mode (gemini-cli#27466) non riguarda questa invocazione.
    // Ha preso il posto di `gemini` nel registro (client free-tier dismesso a monte:
    // IneligibleTierError — rilevabile ma sempre morto a runtime).
    detect: ({ has }) => has('agy'),
    cmdline: () => 'agy',
  },
  grok: {
    transport: 'cli',
    detect: ({ has }) => has('grok'),
    // grok RISERVA stdin e vuole il prompt come argomento: argv puri senza shell (nessun
    // quoting possibile). --always-approve evita i prompt interattivi in headless; la cwd
    // isolata tiene l'auto-approvazione lontana dal repo (il contesto viaggia nel prompt).
    // Invocazione modellata su quella testata da OMC (`omc ask grok`); non verificata su
    // questa macchina (CLI assente): un eventuale errore resta un ERRORE onesto in artefatto.
    argv: (prompt) => ['grok', '-p', prompt, '--always-approve'],
    cwd: () => tmpdir(),
  },
  cursor: {
    transport: 'cli',
    detect: ({ has }) => has('cursor-agent'),
    // cursor-agent in print mode vuole il prompt come argomento posizionale: argv puri senza
    // shell. --force/--trust/--sandbox disabled sono richiesti dall'headless (invocazione
    // modellata su quella testata da OMC); la cwd isolata fa si' che il "trust" valga per una
    // directory temporanea vuota, MAI per il repo. Non verificata qui (CLI assente).
    argv: (prompt) => ['cursor-agent', '--print', '--force', '--trust', '--sandbox', 'disabled', prompt],
    cwd: () => tmpdir(),
  },
  claude: {
    transport: 'cli',
    detect: ({ has }) => has('claude'),
    // -p = print mode non interattiva, prompt su stdin (verificato con la 2.1.212: risposta
    // su stdout, exit 0). ATTENZIONE, e' lo stesso vendor della sessione principale: il parere
    // vale come CONTROPROVA a contesto pulito, non come diversita' di modello (chi non lo
    // vuole lo spegne con la denylist). cwd ISOLATA obbligatoria: un `claude -p` nella dir
    // del progetto caricherebbe anche i NOSTRI hook, e il suo Stop potrebbe rivendicare un
    // loop non ancora rivendicato (sessionId null) o interferire con lo scoping; fuori dal
    // progetto lo Stop hook e' dormiente per costruzione.
    cmdline: () => 'claude -p',
    cwd: () => tmpdir(),
  },
  'ollama-cloud': {
    transport: 'http',
    // disponibile se c'e' la chiave locale; nessuna CLI da installare
    detect: ({ env }) => !!env.OLLAMA_API_KEY,
    // OLLAMA_MODEL puo' essere UNA LISTA separata da virgole: in tal caso una sola chiamata
    // `ask ollama-cloud` interroga TUTTI i modelli elencati (un artefatto a testa).
    // Default recente e forte (override con OLLAMA_MODEL). I modelli cloud vengono ritirati
    // nel tempo: la lista reale e' su https://ollama.com/search?c=cloud (o GET /v1/models).
    models: (env) => {
      const list = (env.OLLAMA_MODEL || 'glm-5.2').split(',').map((m) => m.trim()).filter(Boolean);
      return list.length ? list : ['glm-5.2']; // OLLAMA_MODEL="," o " " -> niente lista vuota
    },
    host: (env) => (env.OLLAMA_HOST || 'https://ollama.com').replace(/\/+$/, ''),
  },
};

// provider disabilitati dall'utente nel file di config:
//   { "providers": { "disabled": ["codex"] } }
// Serve quando un provider e' rilevabile ma inutilizzabile a runtime (tier dismesso,
// filtri di policy, rete aziendale): lo si spegne da config senza disinstallare nulla.
export function disabledProviders(path = CONFIG_PATH) {
  const d = (loadConfig(path).providers || {}).disabled;
  return Array.isArray(d) ? d.map(String) : [];
}

// id dei provider disponibili su questa macchina (CLI presente, oppure chiave presente),
// esclusi quelli disabilitati da config (il chiamante passa `disabled`: testabile in isolamento)
export function detectAvailable({ has, env, platform, disabled = [] }) {
  return Object.entries(PROVIDERS)
    .filter(([id, p]) => {
      if (disabled.includes(id)) return false;
      try { return p.detect({ has, env, platform }); } catch { return false; }
    })
    .map(([id]) => id);
}

async function askHttpOllama(p, prompt, env, timeoutMs, model) {
  const m = model || p.models(env)[0] || 'glm-5.2';
  const key = env.OLLAMA_API_KEY;
  if (!key) return { ok: false, model: m, output: "OLLAMA_API_KEY non impostata nell'ambiente locale." };
  const host = p.host(env);
  // valida l'host PRIMA di spedire la chiave: niente schema strano (la chiave esce solo verso http(s))
  let endpoint;
  try {
    const u = new URL(`${host}/api/chat`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('schema non http(s)');
    endpoint = u.toString();
  } catch {
    return { ok: false, model: m, output: `OLLAMA_HOST non valido (atteso http/https): ${host}` };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, stream: false, messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, model: m, output: `HTTP ${res.status} ${res.statusText}: ${body.slice(0, 600)}` };
    }
    const data = await res.json();
    const output = data?.message?.content?.trim() || JSON.stringify(data).slice(0, 2000);
    return { ok: true, model: m, output };
  } catch (e) {
    const why = e?.name === 'AbortError' ? `timeout dopo ${Math.round(timeoutMs / 1000)}s` : (e?.message || String(e));
    return { ok: false, model: m, output: `errore di rete: ${why}` };
  } finally {
    clearTimeout(t);
  }
}

// modelli da interrogare per un provider: per ollama-cloud e' la lista di OLLAMA_MODEL,
// per le CLI e' un singolo [null] (il modello e' quello della CLI stessa)
export function providerModels(id, env = {}) {
  const p = PROVIDERS[id];
  if (p && p.transport === 'http' && typeof p.models === 'function') return p.models(env);
  return [null];
}

// timeout effettivo di un parere esterno: override esplicito > OMC_ASK_TIMEOUT_MS (validata,
// floor 1s) > default 180s. Esportata per i test.
export function askTimeoutMs(env = {}, override = null) {
  return override ?? parseTimeoutMs(env.OMC_ASK_TIMEOUT_MS, 180000);
}

// interroga un provider (un singolo modello); restituisce sempre {ok, model, output, exitCode?}
export async function askProvider(id, prompt, { env = {}, timeoutMs = null, model = null } = {}) {
  const p = PROVIDERS[id];
  if (!p) return { ok: false, model: id, output: `provider sconosciuto: ${id}. Disponibili: ${Object.keys(PROVIDERS).join(', ')}` };
  const t = askTimeoutMs(env, timeoutMs);
  if (p.transport === 'http') return askHttpOllama(p, prompt, env, t, model);
  const opts = { encoding: 'utf8', timeout: t };
  if (p.cwd) opts.cwd = p.cwd(); // isolamento del figlio: vedi le note per-provider nel registro
  let r;
  if (p.argv) {
    // prompt come SINGOLO elemento argv, SENZA shell: niente quoting, niente metacaratteri.
    // Su Windows funziona solo con binari nativi: uno shim .cmd senza shell viene rifiutato
    // da Node (EINVAL, mitigazione CVE-2024-27980) -> errore onesto, nessun fallback insicuro.
    const [cmd, ...args] = p.argv(prompt);
    r = spawnSync(cmd, args, opts);
  } else {
    // prompt su stdin (input), flag fissi sulla command line; shell:true per i .cmd di npm
    r = spawnSync(p.cmdline(), { ...opts, shell: true, input: prompt });
  }
  if (r.error) {
    const hint = process.platform === 'win32' && p.argv && /EINVAL/i.test(String(r.error.code || r.error.message))
      ? ' (probabile shim .cmd: su Windows questa CLI richiede il binario nativo)' : '';
    return { ok: false, model: id, output: `impossibile eseguire ${id}: ${r.error.message}${hint}`, exitCode: null };
  }
  const out = `${r.stdout || ''}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`.trim();
  const ok = r.status === 0;
  return { ok, model: id, output: out || (ok ? '(nessun output)' : `comando fallito (exit ${r.status})`), exitCode: r.status };
}
