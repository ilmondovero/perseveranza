// Registro centralizzato dei provider di modelli esterni (il "secondo parere" indipendente).
// UNICA fonte di verita' per: come si rilevano, come si interrogano, quale modello/chiave usano.
// Cosi' aggiungere un provider = una voce qui, niente flag sparsi nel resto del codice.
//
// Due trasporti:
//   - cli : una CLI locale (codex / gemini / agy) invocata con i suoi flag
//   - http: una API remota (ollama-cloud) chiamata via fetch
//
// SICUREZZA: la chiave di ollama-cloud vive SOLO in OLLAMA_API_KEY (variabile d'ambiente
// locale), non viene mai scritta su disco ne' negli artefatti ne' nel repo.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
  gemini: {
    transport: 'cli',
    detect: ({ has }) => has('gemini'),
    // -p forza la modalita' headless; il valore del prompt e' "appended to stdin", quindi
    // passiamo il prompt vero su stdin e teniamo -p vuoto (costante, niente da quotare)
    cmdline: () => 'gemini -p ""',
  },
  agy: {
    transport: 'cli',
    // su Windows la print mode -p non scrive su stdout in headless (bug gemini-cli#27466)
    detect: ({ has, platform }) => platform !== 'win32' && has('agy'),
    cmdline: () => 'agy -p ""',
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

// id dei provider disponibili su questa macchina (CLI presente, oppure chiave presente)
export function detectAvailable({ has, env, platform }) {
  return Object.entries(PROVIDERS)
    .filter(([, p]) => {
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

// interroga un provider (un singolo modello); restituisce sempre {ok, model, output, exitCode?}
export async function askProvider(id, prompt, { env = {}, timeoutMs = 180000, model = null } = {}) {
  const p = PROVIDERS[id];
  if (!p) return { ok: false, model: id, output: `provider sconosciuto: ${id}. Disponibili: ${Object.keys(PROVIDERS).join(', ')}` };
  if (p.transport === 'http') return askHttpOllama(p, prompt, env, timeoutMs, model);
  // prompt su stdin (input), flag fissi sulla command line; shell:true per i .cmd di npm
  const r = spawnSync(p.cmdline(), { shell: true, input: prompt, encoding: 'utf8', timeout: timeoutMs });
  if (r.error) return { ok: false, model: id, output: `impossibile eseguire ${id}: ${r.error.message}`, exitCode: null };
  const out = `${r.stdout || ''}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`.trim();
  const ok = r.status === 0;
  return { ok, model: id, output: out || (ok ? '(nessun output)' : `comando fallito (exit ${r.status})`), exitCode: r.status };
}
