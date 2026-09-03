import { parseArgs } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gate, saveState, VerbError, positiveInt } from '../shared.mjs';
import { defaultState, COMPLEXITIES } from '../../core/state.mjs';
import { appendJournal } from '../../shell/journal.mjs';
import { baselineDirty } from '../../shell/git.mjs';
import { detectAvailable, hasBinary, modelLabel, PROVIDERS } from '../../providers/registry.mjs';
import { effectiveEnv, disabledProviders, detectLang } from '../../providers/config.mjs';
import { packPath } from '../../shell/packs.mjs';
import { ROOT } from '../../shell/paths.mjs';
import { currentVersion, updateAvailable, maybeSpawnRefresh } from '../../update.mjs';

export const OPTIONS = {
  max: { type: 'string' },
  'max-retries': { type: 'string' },
  complexity: { type: 'string' },
  commit: { type: 'boolean' },
  external: { type: 'string' },
  test: { type: 'string' },
  'no-git-finish': { type: 'boolean' },
  'no-push': { type: 'boolean' },
  'approve-plan': { type: 'boolean' },
  'budget-tokens': { type: 'string' },
  lang: { type: 'string' },
  force: { type: 'boolean' },
};

export function run({ argv, cwd, env }) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }); }
  catch (e) { throw new VerbError(`arm: ${e.message}`); }
  const { values: v, positionals } = parsed;
  const task = positionals.join(' ').trim();
  if (!task) throw new VerbError('Missing the task description: arm "<task>"');
  if (v.complexity && !COMPLEXITIES.includes(v.complexity)) throw new VerbError('Invalid --complexity: use low|medium|high');
  const paths = gate(cwd);
  if (existsSync(paths.statePath) && !v.force) {
    throw new VerbError('perseveranza is ALREADY armed in this project. Use `status` to see it, `disarm` to stop it, or `arm --force` to overwrite it (the current loop is lost).');
  }
  if (!existsSync(paths.gateDir)) mkdirSync(paths.gateDir, { recursive: true });

  const provEnv = effectiveEnv(env);
  const disabled = disabledProviders(env);
  const externals = v.external === 'off' ? [] : detectAvailable({ has: hasBinary, env: provEnv, platform: process.platform, disabled });
  const lang = (v.lang || detectLang(env)).toLowerCase();
  if (lang !== 'en' && !existsSync(packPath(lang, ROOT))) {
    console.log(`Note: no prompt pack for language "${lang}" (packs/${lang}.json): instructions will be in English.`);
  }
  const maxTokens = v['budget-tokens'] ? positiveInt(v['budget-tokens'], null) : null;
  const state = defaultState({
    task,
    complexity: v.complexity || 'medium',
    options: {
      commitSteps: !!v.commit,
      gitFinish: !v['no-git-finish'],
      gitPush: !v['no-push'],
      approvePlan: !!v['approve-plan'],
      testCmd: v.test || null,
      externals,
      lang,
    },
    limits: {
      maxIterations: v.max ? positiveInt(v.max, 25) : 25,
      maxIterationsExplicit: !!v.max,
      maxRetries: v['max-retries'] ? positiveInt(v['max-retries'], 3) : 3,
      maxTokens,
    },
    baselineDirty: baselineDirty(cwd),
    armedAt: new Date().toISOString(),
    engineVersion: currentVersion(ROOT),
  });
  saveState(paths, state);
  appendJournal(paths.gateDir, { type: 'note', text: `armed: ${task}`, options: state.options, limits: state.limits, force: !!v.force });

  console.log(`perseveranza ARMED (max ${state.limits.maxIterations} iterations${v.max ? '' : ', adaptive after the plan'}, ${state.limits.maxRetries} fixes per step${maxTokens ? `, ${maxTokens} tokens` : ''}${state.options.commitSteps ? ', commit per step' : ''}). Task: ${task}`);
  console.log(`External models for the second opinion: ${externals.length ? externals.join(', ') : 'none'}${v.external !== 'off' && disabled.length ? ` (disabled by config: ${disabled.join(', ')})` : ''}`);
  if (externals.includes('ollama-cloud')) {
    const ms = PROVIDERS['ollama-cloud'].models(provEnv);
    console.log(`  ollama-cloud: model${ms.length > 1 ? 's' : ''} ${ms.map(modelLabel).join(', ')} (host ${PROVIDERS['ollama-cloud'].host(provEnv)})`);
  }
  if (state.options.testCmd) console.log(`Test suite: ${state.options.testCmd} (claim-done will require a fresh green run through the test verb)`);
  console.log(`Instruction language: ${lang}${lang === 'en' ? ' (shipped defaults)' : ` (packs/${lang}.json)`}`);
  if (state.baselineDirty.length) console.log(`Note: ${state.baselineDirty.length} file(s) already modified before the task; the final commit may include them.`);
  console.log("Initial phase: plan. Write the plan to .omc-loop/plan.md as a '- [ ] step' checklist, then stop: from there the Stop hook drives.");
  maybeSpawnRefresh(env);
  const upd = updateAvailable(ROOT, env);
  if (upd) console.log(`⬆ perseveranza v${upd} is available — update from /plugin`);
  return 0;
}

export { join };
