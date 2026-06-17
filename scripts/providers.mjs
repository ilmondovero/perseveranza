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
    // default forte e adatto al ruolo (review/critica/falsificazione di codice); override con
    // OLLAMA_MODEL. Altri modelli validi al 2026-06: deepseek-v3.1:671b, gpt-oss:120b.
    model: (env) => env.OLLAMA_MODEL || 'qwen3-coder:480b',
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

async function askHttpOllama(p, prompt, env, timeoutMs) {
  const model = p.model(env);
  const key = env.OLLAMA_API_KEY;
  if (!key) return { ok: false, model, output: "OLLAMA_API_KEY non impostata nell'ambiente locale." };
  const host = p.host(env);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, model, output: `HTTP ${res.status} ${res.statusText}: ${body.slice(0, 600)}` };
    }
    const data = await res.json();
    const output = data?.message?.content?.trim() || JSON.stringify(data).slice(0, 2000);
    return { ok: true, model, output };
  } catch (e) {
    const why = e?.name === 'AbortError' ? `timeout dopo ${Math.round(timeoutMs / 1000)}s` : (e?.message || String(e));
    return { ok: false, model, output: `errore di rete: ${why}` };
  } finally {
    clearTimeout(t);
  }
}

// interroga un provider; restituisce sempre {ok, model, output, exitCode?} (non lancia)
export async function askProvider(id, prompt, { env = {}, timeoutMs = 180000 } = {}) {
  const p = PROVIDERS[id];
  if (!p) return { ok: false, model: id, output: `provider sconosciuto: ${id}. Disponibili: ${Object.keys(PROVIDERS).join(', ')}` };
  if (p.transport === 'http') return askHttpOllama(p, prompt, env, timeoutMs);
  // prompt su stdin (input), flag fissi sulla command line; shell:true per i .cmd di npm
  const r = spawnSync(p.cmdline(), { shell: true, input: prompt, encoding: 'utf8', timeout: timeoutMs });
  if (r.error) return { ok: false, model: id, output: `impossibile eseguire ${id}: ${r.error.message}`, exitCode: null };
  const out = `${r.stdout || ''}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`.trim();
  const ok = r.status === 0;
  return { ok, model: id, output: out || (ok ? '(nessun output)' : `comando fallito (exit ${r.status})`), exitCode: r.status };
}
