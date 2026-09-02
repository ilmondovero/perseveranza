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
// Timeout per opinion: OMC_ASK_TIMEOUT_MS (default 180 s, floor 1 s), per-provider override
// in config ("providers.timeouts").
//
// SECURITY: the ollama-cloud key lives only in OLLAMA_API_KEY / the local config file; it is
// never written to disk by us, never in artifacts, never in the repo.

import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { parseTimeoutMs } from '../shell/util.mjs';

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
    models: (env) => {
      const list = (env.OLLAMA_MODEL || 'glm-5.2').split(',').map((m) => m.trim()).filter(Boolean);
      return list.length ? list : ['glm-5.2'];
    },
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

async function askHttpOllama(p, prompt, env, timeoutMs, model) {
  const m = model || p.models(env)[0] || 'glm-5.2';
  const key = env.OLLAMA_API_KEY;
  if (!key) return { ok: false, model: m, output: 'OLLAMA_API_KEY is not set.' };
  const host = p.host(env);
  let endpoint;
  try {
    const u = new URL(`${host}/api/chat`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not http(s)');
    endpoint = u.toString();
  } catch {
    return { ok: false, model: m, output: `OLLAMA_HOST is not a valid http(s) URL: ${host}` };
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
    const why = e?.name === 'AbortError' ? `timeout after ${Math.round(timeoutMs / 1000)}s` : (e?.message || String(e));
    return { ok: false, model: m, output: `network error: ${why}` };
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
