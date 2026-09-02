// Loads the prompt pack override layers, highest precedence first:
//   env OMC_PROMPT_PACK > <gate>/prompts.json > packs/<lang>.json > (defaults, implicit)
// Never throws: an unreadable layer is skipped and reported in `errors`.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validatePack } from '../core/prompts.mjs';
import { ROOT } from './paths.mjs';

export function packPath(lang, root = ROOT) {
  return join(root, 'packs', `${String(lang).replace(/[^a-z0-9_-]/gi, '')}.json`);
}

function loadOne(path, source) {
  if (!existsSync(path)) return null;
  try {
    const v = validatePack(JSON.parse(readFileSync(path, 'utf8')));
    if (v.error) return { source, path, error: v.error };
    return { source, path, overrides: v.overrides, unknownKeys: v.unknownKeys, badPlaceholders: v.badPlaceholders };
  } catch (e) {
    return { source, path, error: e.message };
  }
}

// -> { layers: [overrides...], sources: [{source, path}], errors: [{source, path, error}] }
export function loadPromptLayers({ gateDir, env = process.env, lang = 'en', root = ROOT } = {}) {
  const candidates = [];
  if (env.OMC_PROMPT_PACK) candidates.push({ path: String(env.OMC_PROMPT_PACK), source: 'OMC_PROMPT_PACK' });
  if (gateDir) candidates.push({ path: join(gateDir, 'prompts.json'), source: '.omc-loop/prompts.json' });
  if (lang && lang !== 'en') candidates.push({ path: packPath(lang, root), source: `packs/${lang}.json` });
  const layers = [];
  const sources = [];
  const errors = [];
  for (const c of candidates) {
    const r = loadOne(c.path, c.source);
    if (!r) continue;
    if (r.error) { errors.push(r); continue; }
    layers.push(r.overrides);
    sources.push({ source: r.source, path: r.path, keys: Object.keys(r.overrides).length });
  }
  return { layers, sources, errors };
}
