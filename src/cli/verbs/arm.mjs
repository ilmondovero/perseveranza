import { parseArgs } from 'node:util';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gate, writeNewState, VerbError, positiveInt } from '../shared.mjs';
import { defaultState, COMPLEXITIES, LENSES, AUTO_LENSES_HIGH, ADVISOR_MODEL_RE, DEFAULT_ADVISOR_MODEL } from '../../core/state.mjs';
import { appendJournal } from '../../shell/journal.mjs';
import { spawnWatchdog } from '../../shell/watchdog.mjs';
import { RETAINED_STATE } from '../../shell/archive.mjs';
import { baselineDirty, ignorePath, volatilePaths, FINGERPRINT_IGNORE_ENV, MAX_IGNORE } from '../../shell/git.mjs';
import { detectAvailable, hasBinary, modelLabel, PROVIDERS, checkProvider } from '../../providers/registry.mjs';
import { effectiveEnv, disabledProviders, detectLang, lastChecks, recordCheck, disableProvider, providerTimeoutOverride, reachabilitySummary } from '../../providers/config.mjs';
import { packPath } from '../../shell/packs.mjs';
import { ROOT, home, samePath } from '../../shell/paths.mjs';
import { legacyRunNotice, legacyEnvNotice } from '../../shell/legacy.mjs';
import { readModFault, modFaultText, clearModFault } from '../../shell/mod-fault.mjs';
import { currentSession, readAlive, pruneAlive, aliveDir, MOD_OFF_CAUSES } from '../../shell/mod-alive.mjs';
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
  verifiers: { type: 'string' },
  advisor: { type: 'string' },
  'advisor-model': { type: 'string' },
  force: { type: 'boolean' },
  check: { type: 'boolean' },
  'no-mod-check': { type: 'boolean' },
  // a path (or folder) whose UNTRACKED files are not the work: repeatable, or comma-separated
  ignore: { type: 'string', multiple: true },
};

// Is the perseveranza mod alive in the session that arms? (mod-alive.mjs) -> what arm does:
//   { refuse: text }                      inside a Claude Code session whose mod left no sign of
//                                         life: nothing would drive the loop (3.0 has no
//                                         settings hooks), so arm says why and how to go on;
//   { loopMode: 'tool', note }            the mod is alive here: the instructions name its tool;
//   { loopMode: 'shell', note, warn? }    --no-mod-check, or no session at all (a terminal, a
//                                         script): armed, the instructions name the CLI, and a
//                                         terminal is warned that only a session with the mod
//                                         drives the loop.
export function modCheck(env, { noModCheck = false, now = Date.now() } = {}) {
  const session = currentSession(env);
  if (session.id) pruneAlive(env, { now, keep: session.id });
  if (noModCheck) {
    return { loopMode: 'shell', note: `Mod check skipped (--no-mod-check): the instructions name the CLI (${session.id ? `session ${session.id.slice(0, 8)}` : 'no Claude Code session'}).` };
  }
  if (!session.id) {
    return {
      loopMode: 'shell',
      warn: `WARNING: not inside a Claude Code session (no ${session.bad ? 'valid ' : ''}CLAUDE_CODE_SESSION_ID${session.bad ? `: "${session.bad}"` : ''}), so the perseveranza mod could not be checked. The loop is driven only by a Claude Code session (CLI, 2.1.287 or later) with the perseveranza plugin loaded; its instructions will name the CLI command.`,
    };
  }
  const alive = readAlive(session.id, env);
  if (alive.alive) {
    const cc = alive.info && typeof alive.info.claudeCode === 'string' ? ` on Claude Code ${alive.info.claudeCode.slice(0, 40)}` : '';
    return { loopMode: 'tool', note: `Mod: alive in this session (${session.id.slice(0, 8)}${cc}): the instructions name the \`perseveranza\` tool (mcp__perseveranza__perseveranza) for the loop's own verbs; the suite (test) and the external models (ask) stay shell commands run with Bash, and the CLI stays the fallback.` };
  }
  return {
    refuse: [
      `perseveranza NOT armed: the perseveranza mod is not running in this Claude Code session (${session.id.slice(0, 8)}: no sign of life in ${alive.path || aliveDir(env)}).`,
      'Since 3.0 the mod is the only driver of the loop: armed without it, nothing would run the phases.',
      'Probable causes:',
      ...MOD_OFF_CAUSES.map((c) => `  - ${c}`),
      'How to go on: fix the cause and start a new session (or /clear), then arm again; check with `claude plugin validate` and the line `mod:` of `status` once armed.',
      'To arm anyway (a test, or a loop another session with the mod will drive): add --no-mod-check.',
    ].join('\n'),
  };
}

export async function run({ argv, cwd, env }) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }); }
  catch (e) { throw new VerbError(`arm: ${e.message}`); }
  const { values: v, positionals } = parsed;
  const task = positionals.join(' ').trim();
  if (!task) throw new VerbError('Missing the task description: arm "<task>"');
  // before anything is written: a loop nothing would drive is not armed
  const mod = modCheck(env, { noModCheck: !!v['no-mod-check'] });
  if (mod.refuse) throw new VerbError(mod.refuse);
  if (v.complexity && !COMPLEXITIES.includes(v.complexity)) throw new VerbError('Invalid --complexity: use low|medium|high');
  // the final verification lenses: a list, or "auto" (by complexity, when the round is asked)
  let verifiers = null;
  if (v.verifiers != null && v.verifiers.trim().toLowerCase() !== 'auto') {
    const asked = v.verifiers.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const unknown = asked.filter((x) => !LENSES.includes(x));
    if (!asked.length || unknown.length) throw new VerbError(`Invalid --verifiers${unknown.length ? ` (${unknown.join(', ')})` : ''}: a comma-separated list of ${LENSES.join(', ')}, or auto`);
    verifiers = [...new Set(asked)];
  }
  // the internal advisor: on by default; its model from the flag, else PERSEVERANZA_ADVISOR_MODEL, else opus
  const advisorFlag = v.advisor == null ? 'on' : v.advisor.trim().toLowerCase();
  if (advisorFlag !== 'on' && advisorFlag !== 'off') throw new VerbError('Invalid --advisor: use on|off');
  if (v['advisor-model'] != null && !ADVISOR_MODEL_RE.test(v['advisor-model'].trim())) throw new VerbError('Invalid --advisor-model: a model name such as opus, sonnet or haiku (letters, digits, . _ : - [ ])');
  const envModel = typeof env.PERSEVERANZA_ADVISOR_MODEL === 'string' ? env.PERSEVERANZA_ADVISOR_MODEL.trim() : '';
  const envModelBad = !!envModel && !ADVISOR_MODEL_RE.test(envModel);
  // --ignore: relative paths inside the project, never one that would leave out everything
  const askedIgnore = (v.ignore || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
  const badIgnore = askedIgnore.filter((x) => !ignorePath(x));
  if (badIgnore.length) throw new VerbError(`Invalid --ignore (${badIgnore.join(', ')}): a relative path or folder inside the project (no absolute path, no '..', no '.' alone, no glob or pathspec magic)`);
  const fingerprintIgnore = [...new Set(askedIgnore.map(ignorePath))];
  if (fingerprintIgnore.length > MAX_IGNORE) throw new VerbError(`Too many --ignore paths (${fingerprintIgnore.length}, at most ${MAX_IGNORE})`);
  const advisorModel = v['advisor-model'] != null ? v['advisor-model'].trim() : envModel && !envModelBad ? envModel : DEFAULT_ADVISOR_MODEL;
  const paths = gate(cwd);
  // a project rooted in the home directory: its loop folder would be ~/.perseveranza itself,
  // and disarming would archive (move) the config and the runs archive with the run
  if (samePath(paths.gateDir, home(env))) {
    throw new VerbError(`Cannot arm here: the loop folder of this directory would be ${home(env)}, which holds the perseveranza config and the runs archive. Arm inside a project directory.`);
  }
  if (existsSync(join(paths.gateDir, RETAINED_STATE))) {
    throw new VerbError('A previous run is retained in .perseveranza after an archive failure. Fix the archive destination and run `disarm` to archive it before arming a new task.');
  }
  if (existsSync(paths.statePath) && !v.force) {
    throw new VerbError('perseveranza is ALREADY armed in this project. Use `status` to see it, `disarm` to stop it, or `arm --force` to overwrite it (the current loop is lost).');
  }
  if (!existsSync(paths.gateDir)) mkdirSync(paths.gateDir, { recursive: true });
  // the mod's fault marker of a run that is gone: reported, then cleared (it is not this run's)
  const leftoverFault = readModFault(paths.gateDir);

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
      verifiers,
      advisor: advisorFlag === 'on',
      advisorModel,
      loopMode: mod.loopMode,
      fingerprintIgnore,
    },
    limits: {
      maxIterations: v.max ? positiveInt(v.max, 25) : 25,
      maxIterationsExplicit: !!v.max,
      maxRetries: v['max-retries'] ? positiveInt(v['max-retries'], 3) : 3,
      maxTokens,
    },
    baselineDirty: baselineDirty(cwd, { volatile: volatilePaths({ env, extra: fingerprintIgnore }).paths }),
    armedAt: new Date().toISOString(),
    engineVersion: currentVersion(ROOT),
  });
  writeNewState(paths, state);
  appendJournal(paths.gateDir, { type: 'note', text: `armed: ${task}`, options: state.options, limits: state.limits, force: !!v.force });
  // the plan of the first turn is written under the command's instructions: its advisor hint is this arm's
  appendJournal(paths.gateDir, { type: 'advisor-hint', slot: 'plan', reason: !state.options.advisor ? 'off' : externals.length ? 'fallback' : 'no-external', ...(state.options.advisor ? { model: advisorModel } : {}), via: 'arm' });
  if (leftoverFault) {
    const text = modFaultText(leftoverFault);
    clearModFault(paths.gateDir);
    appendJournal(paths.gateDir, { type: 'note', text: `a previous run's mod fault was cleared: ${text}` });
    console.log(`Note: a previous run left a mod fault (.perseveranza/mod-fault.json): ${text}. Cleared; check that \`node\` runs for Claude Code (PERSEVERANZA_NODE) before relying on the mod.`);
  }
  spawnWatchdog(paths.gateDir, env);

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
  console.log(`Final verification lenses: ${verifiers ? verifiers.join(', ') : `auto (${AUTO_LENSES_HIGH.join(', ')} with complexity high, otherwise general)`}`);
  console.log(state.options.advisor
    ? `Internal advisor: on (model ${advisorModel}, agent pf-advisor)${envModelBad ? `; PERSEVERANZA_ADVISOR_MODEL "${envModel}" is not a model name, ignored` : ''}. ${externals.length ? 'If no external model answers on the plan, before' : 'Before'} stopping with the plan ask pf-advisor with model=${advisorModel} (clean context) for a critique of task + plan: it writes .perseveranza/advisor-plan-0.md. It is consultative (a missing opinion does not block) and returns from the 2nd fix of a step.`
    : 'Internal advisor: off (--advisor off)');
  const vol = volatilePaths({ env, extra: fingerprintIgnore });
  console.log(`Not the work (untracked files left out of the tree snapshot and of the final commit): ${vol.paths.join(', ')}`);
  if (vol.rejected.length) console.log(`Note: ${FINGERPRINT_IGNORE_ENV} entries refused (absolute, '..', '.', glob): ${vol.rejected.join(', ')}`);
  if (state.options.testCmd) console.log(`Test suite: ${state.options.testCmd} (claim-done will require a fresh green run through the test verb)`);
  console.log(mod.warn || mod.note);
  console.log(`Instruction language: ${lang}${lang === 'en' ? ' (shipped defaults)' : ` (packs/${lang}.json)`}`);
  if (state.baselineDirty.length) console.log(`Note: ${state.baselineDirty.length} file(s) already modified before the task; the final commit may include them.`);
  for (const l of [...legacyRunNotice(cwd), ...legacyEnvNotice(env)]) console.log(l);
  console.log("Initial phase: plan. Write the plan to .perseveranza/plan.md as a '- [ ] step' checklist, then stop: from there the Stop hook drives.");
  maybeSpawnRefresh(env);
  const upd = updateAvailable(ROOT, env);
  if (upd) console.log(`⬆ perseveranza v${upd} is available — update from /plugin`);
  return 0;
}

export { join };
