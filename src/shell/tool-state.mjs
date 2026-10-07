// Other tools' local state in a project: files their hooks rewrite at every tool call of a
// session, never the task's work. git.mjs leaves their UNTRACKED files out of the work tree's
// fingerprint and out of the closing commit (a tracked file there still counts).
//
// The one module that names them (test/packaging/names.test.mjs allows it): the first is
// oh-my-claudecode's state folder, whose name is also the prefix of perseveranza's own 2.x names
// (legacy.mjs); the repository spells it only where it must.
//   oh-my-claudecode's folder      state, sessions, locks, project memory (a real run: its
//                                  state/*.json changed between the green suite and the
//                                  verifier's pass, and voided the pass)
//   .claude/settings.local.json    Claude Code's per-project permissions ("always allow")
//   .claude/scheduled_tasks.lock   Claude Code's lock of the scheduled tasks
// Not .claude/ as a whole: it holds the project's commands, agents and settings, which are code.
export const VOLATILE_PATHS = ['.omc', '.claude/settings.local.json', '.claude/scheduled_tasks.lock'];
