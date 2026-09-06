import { parseArgs } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gate, saveState, VerbError, positiveInt } from '../shared.mjs';
import { defaultState, COMPLEXITIES } from '../../core/state.mjs';
import { appendJournal } from '../../shell/journal.mjs';
import { RETAINED_STATE } from '../../shell/archive.mjs';
import { baselineDirty } from '../../shell/git.mjs';
import { detectAvailable, hasBinary, modelLabel, PROVIDERS, checkProvider } from '../../providers/registry.mjs';
import { effectiveEnv, disabledProviders, detectLang, lastChecks, recordCheck, disableProvider, providerTimeoutOverride, reachabilitySummary } from '../../providers/config.mjs';
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
  check: { type: 'boolean' },
};

export async function run({ argv, cwd, env }) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }); }
  catch (e) { throw new VerbError(`arm: ${e.message}`); }
  const { values: v, positionals } = parsed;
  const task = positionals.join(' ').trim();
  if (!task) throw new VerbError('Missing the task description: arm "<task>"');
  if (v.complexity && !COMPLEXITIES.includes(v.complexity)) throw new VerbError('Invalid --complexity: use low|medium|high');
  const paths = gate(cwd);
  if (existsSync(join(paths.gateDir, RETAINED_STATE))) {
    throw new VerbError('A previous run is retained in .omc-loop after an archive failure. Fix the archive destination and run `disarm` to archive it before arming a new task.');
  }
  if (existsSync(paths.statePath) && !v.force) {
    throw new VerbError('perseveranza is ALREADY armed in this project. Use `status` to see it, `disarm` to stop it, or `arm --force` to overwrite it (the current loop is lost).');
  }
  if (!existsSync(paths.gateDir)) mkdirSync(paths.gateDir, { recursive: true });

  const provEnv = effectiveEnv(env);
  const disabled = disabledProviders(env);
  let externals = v.external === 'off' ? [] : detectAvailable({ has: hasBinary, env: provEnv, platform: process.platform, disabled });
  // --check: probe the detected providers NOW (in parallel) and keep only those that answer.
  // "Installed" and "reachable" are different facts: a real run announced four providers and
  // got one answer. The dead ones are disabled in the config with the reason, as `providers
  // check` does, so the next arm does not announce them either.
  const probed = [];
  if (v.check && externals.length) {
    const results = await Promise.all(externals.map((id) => checkProvider(id, { env: provEnv, timeoutMs: providerTimeoutOverride(id, env) || 60000 })));
    for (const r of results) {
      const error = String(r.output).split('\n')[0];
      recordCheck(r.id, { ok: r.ok, ms: r.ms, error }, env);
      probed.push(`${r.id}: ${r.ok ? `ok (${r.ms} ms)` : `FAILED (${error})`}`);
      if (!r.ok) disableProvider(r.id, error || 'probe failed at arm', env);
    }
    externals = externals.filter((id) => results.find((r) => r.id === id)?.ok);
  }
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
  if (probed.length) console.log(`  probed now: ${probed.join(' · ')}`);
  else if (externals.length) {
    const r = reachabilitySummary(externals, lastChecks(env));
    const parts = [];
    if (r.ok.length) parts.push(`answered the last check: ${r.ok.join(', ')}`);
    if (r.failed.length) parts.push(`FAILED the last check: ${r.failed.join(', ')}`);
    if (r.never.length) parts.push(`never probed: ${r.never.join(', ')}`);
    console.log(`  detected means installed, not reachable — ${parts.join(' · ')}. Probe with \`providers check\` or arm with --check.`);
  }
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
