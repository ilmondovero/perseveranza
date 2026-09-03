// Registry of external model providers (the independent "second opinion").
// THE single source of truth for how they are detected, invoked, and configured.
//
// Two transports:
//   - cli : a local CLI (codex / agy / grok / cursor / claude)
//   - http: a remote API (ollama-cloud) via fetch
//
// The prompt NEVER goes through a shell:
//   - cmdline(): fixed flags via shell (for npm .cmd shims on Windows), prompt on stdin;
//   - argv():    argument array WITHOUT a shell (CLIs that reserve stdin and take the prompt
//                as an argument: no quoting can break);
//   - cwd():     isolated working directory for the child (headless auto-approval flags must
//                apply to an empty temp dir, never to the repo; `claude -p` in the project dir
//                would load OUR hook).
//
// The http transport takes a model list where each entry can carry its reasoning effort:
// see parseModels() below.
//
// Timeout per opinion: OMC_ASK_TIMEOUT_MS (default 180 s, floor 1 s), per-provider override
// in config ("providers.timeouts").
//
// SECURITY: the ollama-cloud key lives only in OLLAMA_API_KEY / the local config file; it is
// never written to disk by us, never in artifacts, never in the repo.

import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { parseTimeoutMs } from '../shell/util.mjs';

// Model spec for the http transport: "glm-5.3#low,deepseek-v4-flash:0731#false".
// The separator is '#', not ':', because ':' already separates the ollama tag
// (deepseek-v4-flash:0731). What follows '#' is the reasoning effort, sent as `think`:
//   high | medium | low | max | true  -> reasoning on, at that effort
//   false (aliases: none, off)        -> reasoning off
//   omitted                           -> model default; `think` is not sent at all
// An unrecognized value never reaches the server: it is refused locally with a clear
// message, the way an invalid OLLAMA_HOST is.
const THINK_LEVELS = ['high', 'medium', 'low', 'max'];
const DEFAULT_OLLAMA_MODEL = 'glm-5.2';

export function parseModels(spec, fallback = DEFAULT_OLLAMA_MODEL) {
  const out = [];
  for (const entry of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const cut = entry.indexOf('#');
    const name = (cut < 0 ? entry : entry.slice(0, cut)).trim();
    if (!name) continue;
    const raw = cut < 0 ? '' : entry.slice(cut + 1).trim().toLowerCase();
    if (raw === '') out.push({ name });
    else if (raw === 'true') out.push({ name, think: true });
    else if (raw === 'false' || raw === 'none' || raw === 'off') out.push({ name, think: false });
    else if (THINK_LEVELS.includes(raw)) out.push({ name, think: raw });
    else out.push({ name, invalid: raw });
  }
  return out.length ? out : [{ name: fallback }];
}

// Display form: "glm-5.3 (think: low)". Used in logs, arm output and artifact headers.
export function modelLabel(m) {
  if (!m) return '';
  if (typeof m === 'string') return m;
  if (m.invalid !== undefined) return `${m.name} (think: ${m.invalid} - INVALID)`;
  return m.think === undefined ? m.name : `${m.name} (think: ${m.think})`;
}

export const PROVIDERS = {
  codex: {
    transport: 'cli',
    detect: ({ has }) => has('codex'),
    cmdline: () => 'codex exec --skip-git-repo-check',
  },
  agy: {
    transport: 'cli',
    // headless via non-TTY stdin, no flags: `-p ""` is rejected since 1.1.x and the prompt
    // must not touch the command line
    detect: ({ has }) => has('agy'),
    cmdline: () => 'agy',
  },
  grok: {
    transport: 'cli',
    detect: ({ has }) => has('grok'),
    argv: (prompt) => ['grok', '-p', prompt, '--always-approve'],
    cwd: () => tmpdir(),
  },
  cursor: {
    transport: 'cli',
    detect: ({ has }) => has('cursor-agent'),
    argv: (prompt) => ['cursor-agent', '--print', '--force', '--trust', '--sandbox', 'disabled', prompt],
    cwd: () => tmpdir(),
  },
  claude: {
    transport: 'cli',
    // same vendor as the main session: a clean-context counter-check, not model diversity
    detect: ({ has }) => has('claude'),
    cmdline: () => 'claude -p',
    cwd: () => tmpdir(),
  },
  'ollama-cloud': {
    transport: 'http',
    detect: ({ env }) => !!env.OLLAMA_API_KEY,
    models: (env) => parseModels(env.OLLAMA_MODEL),
    host: (env) => (env.OLLAMA_HOST || 'https://ollama.com').replace(/\/+$/, ''),
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export function hasBinary(name) {
  try {
    return spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore', timeout: 4000 }).status === 0;
  } catch { return false; }
}

export function detectAvailable({ has = hasBinary, env = {}, platform = process.platform, disabled = [] } = {}) {
  return Object.entries(PROVIDERS)
    .filter(([id, p]) => {
      if (disabled.includes(id)) return false;
      try { return p.detect({ has, env, platform }); } catch { return false; }
    })
    .map(([id]) => id);
}

export function providerModels(id, env = {}) {
  const p = PROVIDERS[id];
  if (p && p.transport === 'http' && typeof p.models === 'function') return p.models(env);
  return [null];
}

export function askTimeoutMs(env = {}, override = null) {
  return override ?? parseTimeoutMs(env.OMC_ASK_TIMEOUT_MS, 180000);
}

// The model can arrive already parsed (from models()), as a spec string ("glm-5.3#low"), or
// missing: then the first configured one.
function normalizeModel(model, p, env) {
  if (model && typeof model === 'object') return model;
  if (typeof model === 'string' && model.trim()) return parseModels(model)[0];
  return p.models(env)[0] || { name: DEFAULT_OLLAMA_MODEL };
}

async function askHttpOllama(p, prompt, env, timeoutMs, model) {
  const m = normalizeModel(model, p, env);
  const label = modelLabel(m);
  if (m.invalid !== undefined) {
    return { ok: false, model: label, output: `invalid reasoning effort "${m.invalid}" for ${m.name}: use high, medium, low, max, true or false (aliases for false: none, off).` };
  }
  const key = env.OLLAMA_API_KEY;
  if (!key) return { ok: false, model: label, output: 'OLLAMA_API_KEY is not set.' };
  const host = p.host(env);
  let endpoint;
  try {
    const u = new URL(`${host}/api/chat`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not http(s)');
    endpoint = u.toString();
  } catch {
    return { ok: false, model: label, output: `OLLAMA_HOST is not a valid http(s) URL: ${host}` };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const payload = { model: m.name, stream: false, messages: [{ role: 'user', content: prompt }] };
  if (m.think !== undefined) payload.think = m.think;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, model: label, output: `HTTP ${res.status} ${res.statusText}: ${body.slice(0, 600)}` };
    }
    const data = await res.json();
    const msg = data?.message || {};
    // With reasoning on the answer is in content and the chain of thought in thinking; a model
    // that only thinks and says nothing is still worth reporting, so fall back to it.
    const output = msg.content?.trim() || msg.thinking?.trim() || JSON.stringify(data).slice(0, 2000);
    return { ok: true, model: label, output };
  } catch (e) {
    const why = e?.name === 'AbortError' ? `timeout after ${Math.round(timeoutMs / 1000)}s` : (e?.message || String(e));
    return { ok: false, model: label, output: `network error: ${why}` };
  } finally {
    clearTimeout(t);
  }
}

// Ask one provider (one model). Always resolves to { ok, model, output, exitCode? }.
export async function askProvider(id, prompt, { env = {}, timeoutMs = null, model = null, spawn = spawnSync } = {}) {
  const p = PROVIDERS[id];
  if (!p) return { ok: false, model: id, output: `unknown provider: ${id}. Available: ${PROVIDER_IDS.join(', ')}` };
  const t = askTimeoutMs(env, timeoutMs);
  if (p.transport === 'http') return askHttpOllama(p, prompt, env, t, model);
  const opts = { encoding: 'utf8', timeout: t, env };
  if (p.cwd) opts.cwd = p.cwd();
  let r;
  if (p.argv) {
    const [cmd, ...args] = p.argv(prompt);
    r = spawn(cmd, args, opts);
  } else {
    r = spawn(p.cmdline(), { ...opts, shell: true, input: prompt });
  }
  if (r.error) {
    const hint = process.platform === 'win32' && p.argv && /EINVAL/i.test(String(r.error.code || r.error.message))
      ? ' (probably a .cmd shim: on Windows this CLI needs the native binary)' : '';
    return { ok: false, model: id, output: `cannot run ${id}: ${r.error.message}${hint}`, exitCode: null };
  }
  const out = `${r.stdout || ''}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`.trim();
  const ok = r.status === 0;
  return { ok, model: id, output: out || (ok ? '(no output)' : `command failed (exit ${r.status})`), exitCode: r.status };
}

// Liveness probe: a trivial prompt with a short timeout. -> { id, ok, ms, output }
export async function checkProvider(id, { env = {}, timeoutMs = 60000, spawn = spawnSync } = {}) {
  const t0 = Date.now();
  const r = await askProvider(id, 'Reply with the single word OK.', { env, timeoutMs, spawn });
  return { id, ok: r.ok, ms: Date.now() - t0, output: String(r.output).slice(0, 300) };
}
