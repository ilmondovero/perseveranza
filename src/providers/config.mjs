// Local configuration: ~/.perseveranza/config.json (never inside a repo).
// {
//   "ollama":    { "apiKey": "...", "model": "glm-5.3#low,deepseek-v4-flash:0731#none", "host": "https://ollama.com" },
//   "providers": { "disabled": ["codex"], "disabledReasons": { "codex": {"at": "...", "reason": "..."} },
//                  "timeouts": { "ollama-cloud": 300000 } },
//   "lang":      "it",
//   "statusline": { "base": "<previous statusline command>" }
// }
// Precedence for provider settings: real environment variable > config file > registry default.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { configPath } from '../shell/paths.mjs';

export function loadConfig(env = process.env) {
  try {
    const p = configPath(env);
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, 'utf8')) || {};
  } catch { return {}; }
}

export function saveConfig(cfg, env = process.env) {
  const p = configPath(env);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2));
}

// Effective env for the providers: real env first, config fills the holes.
export function effectiveEnv(realEnv = process.env) {
  const o = loadConfig(realEnv).ollama || {};
  const m = { ...realEnv };
  if (m.OLLAMA_API_KEY == null && o.apiKey) m.OLLAMA_API_KEY = String(o.apiKey);
  if (m.OLLAMA_MODEL == null && o.model) m.OLLAMA_MODEL = String(o.model);
  if (m.OLLAMA_HOST == null && o.host) m.OLLAMA_HOST = String(o.host);
  return m;
}

export function disabledProviders(env = process.env) {
  const d = (loadConfig(env).providers || {}).disabled;
  return Array.isArray(d) ? d.map(String) : [];
}

export function providerTimeoutOverride(id, env = process.env) {
  const t = ((loadConfig(env).providers || {}).timeouts || {})[id];
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.max(1000, Math.trunc(n)) : null;
}

// Record a provider as disabled with a reason (used by `providers check`).
export function disableProvider(id, reason, env = process.env) {
  const cfg = loadConfig(env);
  cfg.providers = cfg.providers || {};
  const set = new Set(Array.isArray(cfg.providers.disabled) ? cfg.providers.disabled.map(String) : []);
  set.add(id);
  cfg.providers.disabled = [...set];
  cfg.providers.disabledReasons = { ...(cfg.providers.disabledReasons || {}), [id]: { at: new Date().toISOString(), reason: String(reason).slice(0, 300) } };
  saveConfig(cfg, env);
}

export function enableProvider(id, env = process.env) {
  const cfg = loadConfig(env);
  if (!cfg.providers) return;
  cfg.providers.disabled = (cfg.providers.disabled || []).filter((x) => String(x) !== id);
  if (cfg.providers.disabledReasons) delete cfg.providers.disabledReasons[id];
  saveConfig(cfg, env);
}

// Language of the injected instructions: PERSEVERANZA_LANG > config.lang > DEFAULT_LANG.
// Italian by default (the project's home language); the shipped defaults in prompts.mjs are
// English and packs/<lang>.json overrides them. No locale sniffing: explicit settings only,
// so the language never changes with the shell a session was started from.
export const DEFAULT_LANG = 'it';
export function detectLang(env = process.env) {
  const pick = (v) => (typeof v === 'string' && /^[a-z]{2}/i.test(v) ? v.slice(0, 2).toLowerCase() : null);
  return pick(env.PERSEVERANZA_LANG) || pick(loadConfig(env).lang) || DEFAULT_LANG;
}
