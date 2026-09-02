// Where things live. The only module that knows about the user profile layout.
//   PERSEVERANZA_HOME  overrides ~/.perseveranza (config, runs archive, update cache) — used by tests.
//   CLAUDE_CONFIG_DIR  overrides ~/.claude (Claude Code's own convention).
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const GATE_DIRNAME = '.omc-loop';

export function home(env = process.env) {
  return env.PERSEVERANZA_HOME || join(homedir(), '.perseveranza');
}
export function configPath(env = process.env) { return join(home(env), 'config.json'); }
export function runsDir(env = process.env) { return join(home(env), 'runs'); }
export function claudeDir(env = process.env) { return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'); }

export function gatePaths(cwd) {
  const gateDir = join(cwd, GATE_DIRNAME);
  return {
    cwd,
    gateDir,
    statePath: join(gateDir, 'state.json'),
    planPath: join(gateDir, 'plan.md'),
    notesPath: join(gateDir, 'notes.md'),
    journalPath: join(gateDir, 'journal.jsonl'),
    escalationPath: join(gateDir, 'ESCALATION.md'),
    stopFile: join(gateDir, 'STOP'),
    promptsPath: join(gateDir, 'prompts.json'),
    projectName: basename(cwd),
  };
}

// The command Claude runs for the verbs (used inside injected instructions).
export function loopCommand(root = ROOT) {
  return `node "${join(root, 'src', 'cli', 'omc-loop.mjs')}"`;
}
