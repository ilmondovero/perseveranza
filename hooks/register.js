// perseveranza as a Claude Code mod (2.1.287 or later): the entry point. Only the on(...)
// calls, with literal event names, and the `io` object below; what each hook does lives in
// ./lib (one adapter per event), and the loop itself in the Node shell, reached through the
// bridge (src/shell/mod-bridge.mjs) with $.process.run, which is CLI only.
//
// io: the mods API calls the adapters use, as plain closures. A hooks module may pass `$` only
// to a function declared at the top of this same file, never to an imported one, so the
// adapters get these closures instead (`claude plugin validate` lists them "via io").
//
// Failure policy (PIANO-MOD, section 4): every hook is fail-open (a hook that throws is skipped
// and Claude Code goes on) except classic.Stop and classic.SubagentStop, whose .catch answers
// explicitly; their adapters say when that may block and when it may not.
import { createMod } from './lib/core.js';
import { onStop, onStopFailed } from './lib/stop.js';
import { onSubagentStop, onSubagentStopFailed } from './lib/subagent.js';
import { routeFor, rememberAgent } from './lib/spawn.js';
import { onToolCall } from './lib/tool.js';
import { addStep, scheduleUsage } from './lib/usage.js';
import { onSessionStart, sessionNotice } from './lib/session.js';
import { serveTool, serveCommand } from './lib/verbs.js';
import { isOwnTool } from './lib/core.js';

function io($) {
  return {
    run: (argv, init) => $.process.run(argv, init),
    after: (ms, fn) => $.clock.after(ms, fn),
    now: () => $.clock.now(),
    cwd: () => $.session.cwd(),
    sessionId: () => $.session.id(),
    version: () => $.session.version(),
    nodeEnv: () => $.env.get('PERSEVERANZA_NODE'),
    root: () => $.plugin.root,
    sleep: (ms) => $.clock.sleep(ms),
    exists: (path) => $.fs.exists(path),
    read: (path) => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    list: (path) => $.fs.list(path),
    surfaces: () => $.session.surfaces(),
    log: (text) => $.ui.log(text, { to: 'debug' }),
    status: (text) => $.ui.status(text),
    registerTool: (spec) => $.tool.register(spec),
    registerCommand: (spec) => $.command.register(spec),
    pluginName: () => $.plugin.name,
    perseveranzaHome: () => $.env.get('PERSEVERANZA_HOME'),
    userProfile: () => $.env.get('USERPROFILE'),
    home: () => $.env.get('HOME'),
  };
}

export function register(on) {
  const mod = createMod();

  on('session.start', async ($, e, next) => {
    await onSessionStart(io($), mod, e);
    return next(e);
  });

  on('classic.SessionStart', async ($, e, next) => {
    const text = await sessionNotice(io($), mod, e);
    const r = await next(e);
    if (!text) return r;
    const base = r && typeof r === 'object' ? r : {};
    return { ...base, additionalContext: [...(Array.isArray(base.additionalContext) ? base.additionalContext : []), text] };
  });

  on('classic.Stop', async ($, e, next) => {
    const decision = await onStop(io($), mod, e);
    const r = await next(e);
    return decision ? { ...(r && typeof r === 'object' ? r : {}), block: decision.block } : r;
  }).catch(async ($, e, next) => {
    const decision = await onStopFailed(io($), mod, e, next.error && next.error.message ? next.error.message : next.error && next.error.kind);
    const r = await next(e);
    return decision ? { ...(r && typeof r === 'object' ? r : {}), block: decision.block } : r;
  });

  on('classic.SubagentStop', async ($, e, next) => {
    const decision = await onSubagentStop(io($), mod, e);
    const r = await next(e);
    return decision ? { ...(r && typeof r === 'object' ? r : {}), block: decision.block } : r;
  }).catch(async ($, e, next) => {
    const decision = await onSubagentStopFailed(io($), mod, e, next.error && next.error.message ? next.error.message : next.error && next.error.kind);
    const r = await next(e);
    return decision ? { ...(r && typeof r === 'object' ? r : {}), block: decision.block } : r;
  });

  on('agent.spawn', async ($, e, next) => {
    const model = await routeFor(io($), mod, e);
    const r = await next(model ? { ...e, model } : e);
    rememberAgent(mod, e, r);
    return r;
  });

  on('tool.call', async ($, e, next) => {
    // the mod's own tool: answered here (validated, gated, run through the CLI), never passed on
    if (isOwnTool(mod, e)) return serveTool(io($), mod, e);
    const refused = await onToolCall(io($), mod, e);
    return refused ? { deny: refused.deny } : next(e);
  });

  // /pf (verbs.js COMMAND_NAME): the matcher is a literal, like the event names
  on('command.run', { command: 'pf' }, async ($, e) => serveCommand(io($), mod, e));

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e);
    if (addStep(mod, e, result)) scheduleUsage(io($), mod);
    return result;
  });
}
