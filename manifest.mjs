// Single source of truth for what the plugin ships. Used by:
//   - install.mjs        (a manual install copies exactly these files into a plugin directory
//                         that settings.json loads with CLAUDE_CODE_PLUGIN_DIRS)
//   - test/packaging     (every listed file exists; every runtime file is listed;
//                         hooks.json names the mod's hooks module and nothing else)
// The plugin registers no settings hook ("hooks" in hooks.json or settings.json): since 3.0 the
// loop is driven by the mod alone (hooks/register.js), never by two drivers.
// Paths are relative to the repository root, forward slashes.

export const RUNTIME_FILES = [
  'src/core/machine.mjs',
  'src/core/transitions.mjs',
  'src/core/state.mjs',
  'src/core/verdicts.mjs',
  'src/core/plan.mjs',
  'src/core/prompts.mjs',
  'src/core/budget.mjs',
  'src/core/staleness.mjs',
  'src/core/time.mjs',
  'src/core/subagents.mjs',
  'src/shell/stop.mjs',
  'src/shell/stop-core.mjs',
  'src/shell/mod-bridge.mjs',
  'src/shell/mod-fault.mjs',
  'src/shell/mod-alive.mjs',
  'src/shell/usage-inbox.mjs',
  'src/shell/state-file.mjs',
  'src/shell/session-start.mjs',
  'src/shell/activity.mjs',
  'src/shell/activity-hook.mjs',
  'src/shell/watchdog.mjs',
  'src/shell/life.mjs',
  'src/shell/restore.mjs',
  'src/shell/effects.mjs',
  'src/shell/git.mjs',
  'src/shell/journal.mjs',
  'src/shell/transcript.mjs',
  'src/shell/notify.mjs',
  'src/shell/packs.mjs',
  'src/shell/paths.mjs',
  'src/shell/legacy.mjs',
  'src/shell/legacy-hashes.mjs',
  'src/shell/archive.mjs',
  'src/shell/util.mjs',
  'src/cli/perseveranza.mjs',
  'src/cli/verbs/arm.mjs',
  'src/cli/verbs/ask.mjs',
  'src/cli/verbs/claim-done.mjs',
  'src/cli/verbs/complexity.mjs',
  'src/cli/verbs/config.mjs',
  'src/cli/verbs/disarm.mjs',
  'src/cli/verbs/explain.mjs',
  'src/cli/verbs/history.mjs',
  'src/cli/verbs/hud.mjs',
  'src/cli/verbs/pause.mjs',
  'src/cli/verbs/prompts.mjs',
  'src/cli/verbs/providers.mjs',
  'src/cli/verbs/report.mjs',
  'src/cli/verbs/resume.mjs',
  'src/cli/verbs/runs.mjs',
  'src/cli/verbs/status.mjs',
  'src/cli/verbs/test.mjs',
  'src/cli/shared.mjs',
  'src/providers/registry.mjs',
  'src/providers/config.mjs',
  'src/hud/render.mjs',
  'src/hud/statusline.mjs',
  'src/hud/resolver.mjs',
  'src/update.mjs',
  'packs/it.json',
];

export const AGENT_FILES = [
  'agents/pf-reviewer.md',
  'agents/pf-verifier.md',
  'agents/pf-executor.md',
  'agents/pf-advisor.md',
];

export const COMMAND_FILES = ['commands/perseveranza.md'];

// The mod (Claude Code 2.1.287 or later): hooks/hooks.json names only this hooks module, and
// the module imports the rest of hooks/lib and src/core by relative path (test/packaging checks
// that every file it reaches is shipped).
export const MOD_ENTRY = 'hooks/register.js';
export const MOD_FILES = [
  MOD_ENTRY,
  'hooks/lib/core.js',
  'hooks/lib/gate.js',
  'hooks/lib/usage.js',
  'hooks/lib/activity.js',
  'hooks/lib/stop.js',
  'hooks/lib/subagent.js',
  'hooks/lib/spawn.js',
  'hooks/lib/session.js',
  'hooks/lib/tool.js',
  'hooks/lib/verbs.js',
];

export const PLUGIN_FILES = ['.claude-plugin/plugin.json', 'hooks/hooks.json', ...MOD_FILES];

// The CLI entry point (the "verbs"), relative to the repository root.
export const CLI_ENTRY = 'src/cli/perseveranza.mjs';

export const ALL_FILES = [...RUNTIME_FILES, ...AGENT_FILES, ...COMMAND_FILES, ...PLUGIN_FILES];
