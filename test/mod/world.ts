// The world beneath the mod in `claude plugin test`: no file system, no processes, no
// network. Every mods API call the mod makes is answered here, by the test's own hooks (which
// sit beneath every plugin), and every bridge request ($.process.run) is recorded and answered
// by the test's `answer` function, the way src/shell/mod-bridge.mjs would; a run of the CLI
// (the tool, the command) is recorded apart (cliRuns) and answered by `cli`.
import { mock } from 'claude-code/testing'

export type Req = { op: string; cwd: string; event: any; facts: any; argv: string[]; timeoutMs?: number }
// what the bridge answers: an object (printed as JSON), a raw string (stdout as is),
// 'reject' ($.process.run rejects: the bridge did not start or timed out)
export type Answer = object | string | 'reject'

export type WorldOptions = {
  // may answer late: a Promise (e.g. after `await w.clock.sleep(ms)`) holds the bridge call
  answer?: (req: Req) => Answer | Promise<Answer>
  // $.fs.exists: true/false for every path, 'throw', or a function of the path
  gate?: boolean | 'throw' | ((path: string) => boolean | 'throw')
  // instead of gate: the names that exist in the project's .perseveranza/ (the folder exists too)
  files?: string[]
  // $.fs.read of .perseveranza/state.json (absent: the read is refused; a function: read at each call)
  stateText?: string | (() => string)
  // $.fs.write refused
  writeFails?: boolean
  // what Claude Code (or a settings hook) beneath answers at Stop
  stopBottom?: object
  // what a settings hook beneath answers at SessionStart
  sessionStartBottom?: object
  version?: any
  nodeEnv?: string
  cwd?: string
  session?: string
  now?: number
  // $.env.get of the homes the mod's sign of life is written under (verbs.js aliveHome)
  userProfile?: string
  homeEnv?: string
  perseveranzaHome?: string
  // $.tool.register / $.command.register refused (the name taken, an older Claude Code)
  registerToolFails?: boolean
  registerCommandFails?: boolean
  // a run of the CLI (src/cli/perseveranza.mjs): what it answers ('reject': it did not start)
  cli?: (run: CliRun) => CliAnswer | Promise<CliAnswer>
  // $.session.surfaces(): [] by default (a -p run), 'throw' to refuse
  surfaces?: string[] | 'throw'
  // $.fs.list: the entries of a folder by its path ('throw': refused; absent: none)
  list?: (path: string) => any[] | 'throw'
}

// one run of the CLI by the tool or the command: argv after the CLI path, and how it was run
export type CliRun = { argv: string[]; node: string; cli: string; cwd?: string; env: Record<string, string>; stdin: string; timeoutMs?: number }
export type CliAnswer = { exitCode?: number; stdout?: string; stderr?: string; isStdoutTruncated?: boolean } | 'reject'
export const isCli = (argv: string[]) => typeof argv[1] === 'string' && argv[1].replaceAll('\\', '/').endsWith('/src/cli/perseveranza.mjs')

export const USER_PROFILE = 'C:/Users/u'

export const CWD = 'C:/proj'
export const ROOT_HINT = 'src/shell/mod-bridge.mjs'

export const OK_ALLOW = { ok: true, decision: { allowStop: true } }

export function world(on: any, opts: WorldOptions = {}) {
  const clock = mock.clock(on, { now: opts.now ?? 1_000_000 })
  const reqs: Req[] = []
  const logs: string[] = []
  const statuses: (string | undefined)[] = []
  const answer = opts.answer ?? (() => OK_ALLOW)
  const cliRuns: CliRun[] = []
  on('process.run', async ($: any, e: any) => {
    if (isCli(e.argv)) {
      const run: CliRun = { argv: e.argv.slice(2), node: e.argv[0], cli: e.argv[1], cwd: e.init && e.init.cwd, env: (e.init && e.init.env) || {}, stdin: (e.init && e.init.stdin) || '', timeoutMs: e.init ? e.init.timeoutMs : undefined }
      cliRuns.push(run)
      const a = opts.cli ? await opts.cli(run) : { exitCode: 0, stdout: 'ok' }
      if (a === 'reject') return { deny: 'spawn node ENOENT' }
      return { value: { exitCode: a.exitCode ?? 0, stdout: a.stdout ?? '', stderr: a.stderr ?? '', isStdoutTruncated: !!a.isStdoutTruncated, isStderrTruncated: false } }
    }
    const body = JSON.parse(e.init && e.init.stdin ? e.init.stdin : '{}')
    const req: Req = { ...body, argv: e.argv, timeoutMs: e.init ? e.init.timeoutMs : undefined }
    reqs.push(req)
    const a = await answer(req)
    if (a === 'reject') return { deny: 'spawn node ENOENT' }
    return { value: { exitCode: 0, stdout: typeof a === 'string' ? a : JSON.stringify(a), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // the engine may hand a path over in the platform's own separators: compared with '/'
  const slash = (p: any) => String(p).replaceAll('\\', '/')
  const exists: string[] = []
  on('fs.exists', ($: any, e: any) => {
    const path = slash(e.path)
    exists.push(path)
    if (opts.files) {
      const m = path.match(/\/\.perseveranza(?:\/([^/]+))?$/)
      return { value: !!m && (!m[1] || opts.files.includes(m[1])) }
    }
    const v = typeof opts.gate === 'function' ? opts.gate(path) : opts.gate ?? true
    return v === 'throw' ? { deny: 'fs refused' } : { value: v }
  })
  const reads: string[] = []
  on('fs.read', ($: any, e: any) => {
    reads.push(slash(e.path))
    const text = typeof opts.stateText === 'function' ? opts.stateText() : opts.stateText
    return typeof text === 'string' && slash(e.path).endsWith('/.perseveranza/state.json') ? { value: text } : { deny: 'ENOENT' }
  })
  const writes: { path: string; text: string }[] = []
  // the mod's sign of life (<home>/mod-alive/<session>.json) apart from the project's files
  const alive: { path: string; text: string }[] = []
  on('fs.write', ($: any, e: any) => {
    if (opts.writeFails) return { deny: 'EACCES' }
    const w = { path: slash(e.path), text: String(e.text) }
    if (/\/mod-alive\/[^/]+\.json$/.test(w.path)) alive.push(w); else writes.push(w)
    return { value: undefined }
  })
  const registered: { tools: any[]; commands: any[] } = { tools: [], commands: [] }
  on('tool.register', ($: any, e: any) => {
    if (opts.registerToolFails) return { deny: 'refused' }
    registered.tools.push(e)
    return { value: { tool: 'mcp__perseveranza__' + e.name } }
  })
  on('command.register', ($: any, e: any) => {
    if (opts.registerCommandFails) return { deny: '"/perseveranza" refused' }
    registered.commands.push(e)
    return { value: { command: e.name } }
  })
  on('session.surfaces', () => (opts.surfaces === 'throw' ? { deny: 'no surfaces' } : { value: opts.surfaces ?? [] }))
  const listed: string[] = []
  on('fs.list', ($: any, e: any) => {
    listed.push(slash(e.path))
    const v = opts.list ? opts.list(slash(e.path)) : []
    return v === 'throw' ? { deny: 'ENOENT' } : { value: v }
  })
  on('session.cwd', () => ({ value: opts.cwd ?? CWD }))
  on('session.id', () => ({ value: opts.session ?? 'S1' }))
  on('session.version', () => ({ value: 'version' in opts ? opts.version : { version: '2.1.289', base: '2.1.289' } }))
  const envOf: Record<string, string | undefined> = {
    PERSEVERANZA_NODE: opts.nodeEnv,
    USERPROFILE: 'userProfile' in opts ? opts.userProfile : USER_PROFILE,
    HOME: opts.homeEnv,
    PERSEVERANZA_HOME: opts.perseveranzaHome,
  }
  on('env.get', ($: any, e: any) => ({ value: envOf[e.name] }))
  on('ui.log', ($: any, e: any) => { logs.push(String(e.text)); return { value: undefined } })
  on('ui.status', ($: any, e: any) => { statuses.push(e.text); return { value: undefined } })
  // the bottom of each event the mod hooks: what Claude Code would do without the mod
  on('classic.Stop', () => opts.stopBottom ?? {})
  on('classic.SubagentStop', () => ({}))
  on('classic.SessionStart', () => opts.sessionStartBottom ?? {})
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  const spawned: any[] = []
  on('agent.spawn', ($: any, e: any) => { spawned.push(e); return { model: e.model ?? 'inherit', agentId: 'agent-' + spawned.length } })
  const ran: any[] = []
  on('tool.call', ($: any, e: any) => { ran.push(e); return { result: 'ran' } })
  const ops = (op: string) => reqs.filter((r) => r.op === op)
  return { clock, reqs, ops, logs, statuses, spawned, ran, exists, reads, writes, alive, registered, cliRuns, listed }
}

// One model request through turn.step, answered with this usage.
export async function step($: any, agentId?: string) {
  const s: any = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku', messageCount: 1, ...(agentId ? { agentId } : {}) })
  let n: any
  while (!(n = await s.next()).done) { /* chunks */ }
  return n.value
}

// The bottom of turn.step, answering every request with the usage the test sets.
export function stepBottom(on: any) {
  const box: { usage: any } = { usage: null }
  on('turn.step', async function* ($: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: box.usage }
  })
  return box
}

export const tokens = (input: number, output = 0, read = 0, creation = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: creation, model: 'claude-haiku' })
export const counts = (input: number, output = 0, read = 0, creation = 0) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheCreationTokens: creation })
