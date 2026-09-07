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
  'src/core/staleness.mjs',
  'src/core/time.mjs',
  'src/shell/stop.mjs',
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
// The SessionStart hook entry point (a new session learns about a loop it does not own).
export const SESSION_HOOK_ENTRY = 'src/shell/session-start.mjs';
// The activity hook entry point (the heartbeat of a turn: delegations, tools, subagent returns).
export const ACTIVITY_HOOK_ENTRY = 'src/shell/activity-hook.mjs';

// Every hook the plugin registers: hooks/hooks.json must match this table (packaging test)
// and install.mjs writes exactly these into settings.json.
export const HOOK_SPECS = [
  { event: 'Stop', matcher: '', entry: HOOK_ENTRY, timeout: 120 },
  { event: 'SessionStart', matcher: '', entry: SESSION_HOOK_ENTRY, timeout: 15 },
  { event: 'PreToolUse', matcher: 'Agent|Task|Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit', entry: ACTIVITY_HOOK_ENTRY, timeout: 10 },
  { event: 'PostToolUse', matcher: 'Agent|Task|Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit', entry: ACTIVITY_HOOK_ENTRY, timeout: 10 },
  { event: 'SubagentStop', matcher: '', entry: ACTIVITY_HOOK_ENTRY, timeout: 10 },
];
// The CLI entry point (the "verbs"), relative to the repository root.
export const CLI_ENTRY = 'src/cli/omc-loop.mjs';

export const ALL_FILES = [...RUNTIME_FILES, ...AGENT_FILES, ...COMMAND_FILES, ...PLUGIN_FILES];
