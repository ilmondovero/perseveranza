// Single source of truth for what the plugin ships. Used by:
//   - install.mjs        (manual install copies exactly these files, uninstall removes them)
//   - test/packaging     (every listed file exists; every runtime file is listed;
//                         hooks.json points at a listed file)
// Paths are relative to the repository root, forward slashes.

export const RUNTIME_FILES = [
  'src/core/machine.mjs',
  'src/core/transitions.mjs',
  'src/core/state.mjs',
  'src/core/verdicts.mjs',
  'src/core/plan.mjs',
  'src/core/prompts.mjs',
  'src/core/budget.mjs',
  'src/shell/stop.mjs',
  'src/shell/effects.mjs',
  'src/shell/git.mjs',
  'src/shell/journal.mjs',
  'src/shell/transcript.mjs',
  'src/shell/notify.mjs',
  'src/shell/packs.mjs',
  'src/shell/paths.mjs',
  'src/shell/archive.mjs',
  'src/shell/util.mjs',
  'src/cli/omc-loop.mjs',
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
];

export const COMMAND_FILES = ['commands/perseveranza.md'];

export const PLUGIN_FILES = ['.claude-plugin/plugin.json', 'hooks/hooks.json'];

// The Stop hook entry point, relative to the repository root.
export const HOOK_ENTRY = 'src/shell/stop.mjs';
// The CLI entry point (the "verbs"), relative to the repository root.
export const CLI_ENTRY = 'src/cli/omc-loop.mjs';

export const ALL_FILES = [...RUNTIME_FILES, ...AGENT_FILES, ...COMMAND_FILES, ...PLUGIN_FILES];
