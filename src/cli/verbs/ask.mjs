import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gate, requireState, argsAfterDoubleDash, fileSafe, VerbError } from '../shared.mjs';
import { appendJournal } from '../../shell/journal.mjs';
import { askProvider, providerModels, modelLabel } from '../../providers/registry.mjs';
import { effectiveEnv, providerTimeoutOverride } from '../../providers/config.mjs';

// Ask an external model and PERSIST the opinion as .omc-loop/external-<slot>-<provider>[-model].md
// (prompt + answer), echoing it to the screen too.
export async function run({ argv, rawArgv, cwd, env }) {
  const paths = gate(cwd);
  const s = requireState(paths);
  const provider = argv[0];
  const slotRaw = argv[1];
  if (!provider || !slotRaw) throw new VerbError('Usage: ask <provider> <slot> -- <prompt>   (or: <prompt> | ask <provider> <slot>)');
  const slot = fileSafe(slotRaw).toLowerCase() || 'misc';
  let prompt = argsAfterDoubleDash(rawArgv);
  if (!prompt && !process.stdin.isTTY) { try { prompt = readFileSync(0, 'utf8'); } catch { /* no stdin */ } }
  prompt = (prompt || '').trim();
  if (!prompt) throw new VerbError('Empty prompt: pass it after -- or through stdin.');
  const externals = s.options.externals;
  if (externals.length && !externals.includes(provider)) {
    console.log(`Note: '${provider}' was not among the providers detected at arm (${externals.join(', ')}). Trying anyway.`);
  }
  const provEnv = effectiveEnv(env);
  const models = providerModels(provider, provEnv);
  const timeoutMs = providerTimeoutOverride(provider, env);
  const ts = new Date().toISOString();
  let anyOk = false;
  for (const m of models) {
    const shown = modelLabel(m);
    console.log(`Asking ${provider}${shown ? ` / ${shown}` : ''} (slot: ${slot})...`);
    const r = await askProvider(provider, prompt, { env: provEnv, model: m, timeoutMs });
    anyOk = anyOk || r.ok;
    const label = r.model && r.model !== provider ? `${provider} (${r.model})` : provider;
    // The reasoning effort is part of the file name: the same model at two efforts is two opinions.
    const suffix = m ? `-${fileSafe(m.name)}${m.think === undefined ? '' : `-${fileSafe(String(m.think))}`}` : '';
    const file = join(paths.gateDir, `external-${slot}-${fileSafe(provider)}${suffix}.md`);
    const doc = `# External opinion - ${label}\n\n`
      + `- slot: ${slot}\n- when: ${ts}\n- status: ${r.ok ? 'ok' : 'ERROR'}\n\n`
      + `## Prompt\n\n${prompt}\n\n## Answer\n\n${r.output}\n`;
    try { writeFileSync(file, doc); console.log(`[saved as .omc-loop/${file.split(/[\\/]/).pop()}]`); }
    catch (e) { console.log(`[could not save the artifact: ${e.message}]`); }
    appendJournal(paths.gateDir, { type: 'ask', provider, model: m ? m.name : null, think: m && m.think !== undefined ? m.think : null, slot, ok: r.ok, chars: String(r.output).length });
    console.log(`\n----- ${label} -----\n${r.output}\n`);
  }
  return anyOk ? 0 : 1;
}
