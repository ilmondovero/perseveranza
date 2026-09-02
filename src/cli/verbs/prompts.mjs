import { readFileSync, existsSync } from 'node:fs';
import { DEFAULT_PROMPTS, PROMPT_KEYS, PROMPT_VARS, validatePack, missingKeys } from '../../core/prompts.mjs';
import { loadPromptLayers, packPath } from '../../shell/packs.mjs';
import { gate, VerbError } from '../shared.mjs';
import { ROOT } from '../../shell/paths.mjs';

// prompts validate [file]  | prompts keys | prompts show <key> | prompts layers
export function run({ argv, cwd, env }) {
  const sub = argv[0] || 'keys';
  if (sub === 'keys') {
    for (const k of PROMPT_KEYS) console.log(`  ${k.padEnd(24)} {{${(PROMPT_VARS[k] || []).join('}} {{')}}}`.replace('{{}}', ''));
    return 0;
  }
  if (sub === 'show') {
    const k = argv[1];
    if (!k || !(k in DEFAULT_PROMPTS)) throw new VerbError(`Usage: prompts show <${PROMPT_KEYS.join('|')}>`);
    console.log(DEFAULT_PROMPTS[k]);
    return 0;
  }
  if (sub === 'layers') {
    const paths = gate(cwd);
    const r = loadPromptLayers({ gateDir: paths.gateDir, env, lang: argv[1] || 'en', root: ROOT });
    if (!r.sources.length && !r.errors.length) console.log('No override layer active: defaults only.');
    for (const s of r.sources) console.log(`  ${s.source.padEnd(24)} ${s.keys} key(s)  ${s.path}`);
    for (const e of r.errors) console.log(`  ${e.source.padEnd(24)} ERROR ${e.error}`);
    return r.errors.length ? 1 : 0;
  }
  if (sub === 'validate') {
    const file = argv[1] || packPath('it', ROOT);
    if (!existsSync(file)) throw new VerbError(`File not found: ${file}`);
    let raw;
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new VerbError(`Invalid JSON: ${e.message}`); }
    const v = validatePack(raw);
    if (v.error) throw new VerbError(`Invalid pack: ${v.error}`);
    const missing = missingKeys(v.overrides);
    console.log(`${file}: ${Object.keys(v.overrides).length} key(s) overridden`);
    if (v.unknownKeys.length) console.log(`  unknown keys (ignored): ${v.unknownKeys.join(', ')}`);
    for (const b of v.badPlaceholders) console.log(`  BAD placeholder in "${b.key}": ${b.placeholder ? `{{${b.placeholder}}}` : ''} ${b.reason}`);
    if (argv.includes('--complete') && missing.length) console.log(`  missing keys (fall back to defaults): ${missing.join(', ')}`);
    const bad = v.badPlaceholders.length || (argv.includes('--complete') && missing.length);
    console.log(bad ? 'INVALID' : 'OK');
    return bad ? 1 : 0;
  }
  throw new VerbError('Usage: prompts [keys | show <key> | layers [lang] | validate [file] [--complete]]');
}
