// The loop's verbs from the mod: the `perseveranza` tool (Claude), the /pf command (the user),
// their registration at session.start, and the sign of life `arm` looks for.
import { expect, test, describe } from 'claude-code/testing'
import { world, CWD, USER_PROFILE } from './world.ts'

const TOOL = 'mcp__perseveranza__perseveranza'
const START = { cwd: CWD, surface: null, isInteractive: false }
const tool = ($: any, input: any) => $.tool.call({ tool: TOOL, ...input })
// the user's Enter at the prompt; a run without it comes from another plugin
const command = ($: any, args: string, kind = 'composer') => $.command.run({ command: 'pf', args, origin: { kind } })
// state.json as the mod reads it for the owner: this session's loop (S1), another's, nobody's
const OWN = JSON.stringify({ owner: { sessionId: 'S1' } })
const FOREIGN = JSON.stringify({ owner: { sessionId: 'other-session-123' } })
const UNCLAIMED = JSON.stringify({ owner: { sessionId: null } })

describe('session.start: the tool, the command, the sign of life', () => {
  test('the tool is registered with a closed schema of the loop\'s own verbs; the command is /pf, immediate', async ($, on) => {
    const w = world(on, { gate: false })
    await $.session.start(START as any)
    expect(w.registered.tools).toHaveLength(1)
    const t = w.registered.tools[0]
    expect(t.name).toBe('perseveranza')
    expect(t.inputSchema.additionalProperties).toBe(false)
    expect(t.inputSchema.required).toEqual(['verb'])
    expect(t.inputSchema.properties.verb.enum).toEqual(['status', 'history', 'explain', 'report', 'complexity', 'claim-done', 'pause', 'resume'])
    for (const v of ['arm', 'disarm', 'test', 'ask']) expect(t.inputSchema.properties.verb.enum).not.toContain(v)
    expect(Object.keys(t.inputSchema.properties)).toEqual(['verb', 'args', 'outcome', 'level', 'tail'])
    expect(t.inputSchema.properties.args.maxLength).toBe(200)
    expect(t.description).toContain('{"verb": "report", "args": "pass"}')
    expect(t.description).toContain('does NOT run the suite (test) or an external model (ask)')
    expect(t.description).toContain('src/cli/perseveranza.mjs')
    expect(w.registered.commands).toEqual([expect.objectContaining({ name: 'pf', immediate: true })])
    // no loop here: no node process for any of it
    expect(w.reqs).toHaveLength(0)
    expect(w.cliRuns).toHaveLength(0)
  })

  test('the sign of life: <USERPROFILE>/.perseveranza/mod-alive/<session>.json, with the version', async ($, on) => {
    const w = world(on, { gate: false, session: 'abc-123' })
    await $.session.start(START as any)
    expect(w.alive.map((a) => a.path)).toEqual([`${USER_PROFILE}/.perseveranza/mod-alive/abc-123.json`])
    expect(JSON.parse(w.alive[0].text)).toMatchObject({ session: 'abc-123', claudeCode: '2.1.289', cwd: CWD })
    expect(w.reqs).toHaveLength(0)
  })

  test('PERSEVERANZA_HOME wins over USERPROFILE and HOME', async ($, on) => {
    const w = world(on, { gate: false, perseveranzaHome: 'D:/ph/', homeEnv: '/home/u' })
    await $.session.start(START as any)
    expect(w.alive[0].path).toBe('D:/ph/mod-alive/S1.json')
  })

  test('USERPROFILE before HOME when both are set (os.homedir() on Windows), HOME without it', async ($, on) => {
    const w = world(on, { gate: false, userProfile: 'C:/Users/win', homeEnv: '/home/u' })
    await $.session.start(START as any)
    expect(w.alive[0].path).toBe('C:/Users/win/.perseveranza/mod-alive/S1.json')
  })

  test('HOME when there is no USERPROFILE', async ($, on) => {
    const w = world(on, { gate: false, userProfile: undefined, homeEnv: '/home/u' })
    await $.session.start(START as any)
    // (the engine resolves a rooted path on the platform: C:/home/u on Windows)
    expect(w.alive[0].path).toMatch(/^(C:)?\/home\/u\/\.perseveranza\/mod-alive\/S1\.json$/)
  })

  test('$.fs.write refused, or no home known: the bridge writes it (op alive)', async ($, on) => {
    const w = world(on, { gate: false, writeFails: true, answer: () => ({ ok: true, file: 'x' }) })
    await $.session.start(START as any)
    expect(w.ops('alive')).toHaveLength(1)
    expect(w.ops('alive')[0].facts).toMatchObject({ session: 'S1', claudeCode: '2.1.289' })
  })

  test('a session id that is not one is never a file name', async ($, on) => {
    const w = world(on, { gate: false, session: '../../evil' })
    await $.session.start(START as any)
    // nothing written anywhere, by the mod or through the bridge
    expect(w.alive).toHaveLength(0)
    expect(w.writes).toHaveLength(0)
    expect(w.ops('alive')).toHaveLength(0)
  })

  test('the surfaces: the terminal (claude) and none (claude -p) leave a sign of life', async ($, on) => {
    const w = world(on, { gate: false, surfaces: ['terminal', 'mobile'] })
    await $.session.start(START as any)
    expect(w.alive).toHaveLength(1)
  })

  for (const surfaces of [['desktop'], ['vscode'], ['mobile'], 'throw'] as const) {
    test(`a session drawn only by ${JSON.stringify(surfaces)} (no $.process.run there, or unknown): no sign of life, said in the log`, async ($, on) => {
      const w = world(on, { gate: false, surfaces: surfaces as any })
      await $.session.start(START as any)
      expect(w.alive).toHaveLength(0)
      expect(w.writes).toHaveLength(0)
      expect(w.ops('alive')).toHaveLength(0)
      expect(w.logs.some((l) => l.includes('not drawn by the CLI'))).toBe(true)
      // the tool and the command are still registered (the CLI stays the fallback)
      expect(w.registered.tools).toHaveLength(1)
    })
  }

  test('classic.SessionStart (a /clear brings a new id): its session\'s sign of life, and the notice in tool words', async ($, on) => {
    const w = world(on, { answer: () => ({ ok: true, context: null }) })
    await $.session.start(START as any)
    await $.classic.SessionStart({ source: 'clear', cwd: CWD, session_id: 'S2' } as any)
    expect(w.alive.map((a) => a.path)).toEqual([`${USER_PROFILE}/.perseveranza/mod-alive/S1.json`, `${USER_PROFILE}/.perseveranza/mod-alive/S2.json`])
    expect(w.ops('session-start')[0].facts).toEqual({ loopMode: 'tool' })
  })

  test('the tool registered: the stop says loopMode tool; refused: shell, and the command still comes', async ($, on) => {
    const w = world(on, { registerToolFails: true })
    await $.session.start(START as any)
    expect(w.registered.commands).toHaveLength(1)
    await $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
    expect(w.ops('stop')[0].facts.loopMode).toBe('shell')
    expect(w.logs.some((l) => l.includes('could not be registered'))).toBe(true)
  })

  test('registered: tool mode at the stop', async ($, on) => {
    const w = world(on, {})
    await $.session.start(START as any)
    await $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
    expect(w.ops('stop')[0].facts.loopMode).toBe('tool')
  })

  test('the command refused (a name taken): the tool stays', async ($, on) => {
    const w = world(on, { gate: false, registerCommandFails: true })
    await $.session.start(START as any)
    expect(w.registered.tools).toHaveLength(1)
    expect(w.logs.some((l) => l.includes('/pf could not be registered'))).toBe(true)
  })
})

describe('the sign of life kept fresh by the session\'s tool calls (a long-lived session keeps a young file)', () => {
  const TEN_MIN = 10 * 60 * 1000
  const bash = ($: any) => $.tool.call({ tool: 'Bash', command: 'ls' })

  test('a tool call writes it, again only after 10 minutes, with $.fs.write and no process', async ($, on) => {
    const w = world(on, { gate: false, session: 'long-1' })
    await bash($)
    expect(w.alive.map((a) => a.path)).toEqual([`${USER_PROFILE}/.perseveranza/mod-alive/long-1.json`])
    const first = JSON.parse(w.alive[0].text)
    expect(first).toMatchObject({ session: 'long-1', cwd: CWD })
    await bash($)
    await w.clock.advance(TEN_MIN - 1000)
    await bash($)
    expect(w.alive).toHaveLength(1)
    await w.clock.advance(2000)
    await bash($)
    expect(w.alive).toHaveLength(2)
    expect(JSON.parse(w.alive[1].text).at).toBeGreaterThan(first.at + TEN_MIN)
    expect(w.reqs).toHaveLength(0)
    expect(w.ran).toHaveLength(4)
  })

  test('the session start counts: no rewrite within 10 minutes of it, one after', async ($, on) => {
    const w = world(on, { gate: false })
    await $.session.start(START as any)
    await bash($)
    expect(w.alive).toHaveLength(1)
    await w.clock.advance(TEN_MIN + 1)
    await bash($)
    expect(w.alive).toHaveLength(2)
  })

  test('a call of the perseveranza tool refreshes it too', async ($, on) => {
    const w = world(on, { stateText: OWN, answer: () => ({ ok: true, deny: null }) })
    await tool($, { verb: 'status' })
    expect(w.alive).toHaveLength(1)
  })

  test('$.fs.write refused: no bridge (a refresh never starts a process), no log at every call', async ($, on) => {
    const w = world(on, { gate: false, writeFails: true })
    await bash($)
    await bash($)
    expect(w.alive).toHaveLength(0)
    expect(w.reqs).toHaveLength(0)
    expect(w.logs.filter((l) => l.includes('sign of life'))).toHaveLength(0)
    expect(w.ran).toHaveLength(2)
  })

  test('a Desktop session: no sign of life from a tool call either, and one log per window at most', async ($, on) => {
    const w = world(on, { gate: false, surfaces: ['desktop'] })
    await bash($)
    await bash($)
    expect(w.alive).toHaveLength(0)
    expect(w.logs.filter((l) => l.includes('not drawn by the CLI'))).toHaveLength(1)
  })

  test('a session id that is not one: nothing written', async ($, on) => {
    const w = world(on, { gate: false, session: '../x' })
    await bash($)
    expect(w.alive).toHaveLength(0)
    expect(w.writes).toHaveLength(0)
  })
})

describe('session.start: the old signs of life are pruned through the bridge, only when there are too many or old ones', () => {
  const file = (name: string, mtimeMs: number) => ({ name, kind: 'file', size: 10, mtimeMs, isLink: false })
  const NOW = 1_000_000_000_000

  test('a few recent ones: listed with $.fs.list, no process', async ($, on) => {
    const w = world(on, { gate: false, now: NOW, list: () => [file('a.json', NOW - 1000), file('b.json', NOW - 2000)] })
    await $.session.start(START as any)
    expect(w.listed).toEqual([`${USER_PROFILE}/.perseveranza/mod-alive`])
    expect(w.reqs).toHaveLength(0)
  })

  test('more than 200: the bridge prunes them (op alive, prune, this session kept), once per process', async ($, on) => {
    const many = Array.from({ length: 201 }, (_, i) => file(`s-${i}.json`, NOW - i * 1000))
    const w = world(on, { gate: false, now: NOW, list: () => many, answer: () => ({ ok: true, removed: 101 }) })
    await $.session.start(START as any)
    expect(w.ops('alive')).toHaveLength(1)
    expect(w.ops('alive')[0].facts).toEqual({ prune: true, session: 'S1' })
    await $.session.start(START as any)
    expect(w.ops('alive')).toHaveLength(1)
  })

  test('one older than 30 days: pruned', async ($, on) => {
    const old = NOW - 31 * 24 * 3600 * 1000
    const w = world(on, { gate: false, now: NOW, list: () => [file('a.json', NOW), file('b.json', old)], answer: () => ({ ok: true, removed: 1 }) })
    await $.session.start(START as any)
    expect(w.ops('alive')).toHaveLength(1)
  })

  test('what is not a sign of life (another name, a folder) does not count', async ($, on) => {
    const old = NOW - 31 * 24 * 3600 * 1000
    const w = world(on, { gate: false, now: NOW, list: () => [file('notes.txt', old), file('bad name.json', old), { name: 'dir.json', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }, ...Array.from({ length: 300 }, (_, i) => file(`x ${i}.json`, NOW))] })
    await $.session.start(START as any)
    expect(w.reqs).toHaveLength(0)
  })

  test('the list refused (no folder yet): nothing, the session goes on', async ($, on) => {
    const w = world(on, { gate: false, list: () => 'throw' })
    await $.session.start(START as any)
    expect(w.reqs).toHaveLength(0)
    expect(w.registered.tools).toHaveLength(1)
  })
})

describe('the tool: each verb runs the CLI, no shell, in the session folder', () => {
  const cases: [string, any, string[]][] = [
    ['status', { verb: 'status' }, ['status']],
    ['report pass, as the words', { verb: 'report', args: 'pass' }, ['report', 'pass']],
    ['report fail, as a field', { verb: 'report', outcome: 'fail' }, ['report', 'fail']],
    ['complexity low, as the words (what Haiku sent in the e2e)', { verb: 'complexity', args: 'low' }, ['complexity', 'low']],
    ['complexity high, as a field', { verb: 'complexity', level: 'high' }, ['complexity', 'high']],
    ['complexity, verb and words in one string', { verb: 'complexity medium' }, ['complexity', 'medium']],
    ['claim-done', { verb: 'claim-done' }, ['claim-done']],
    ['pause', { verb: 'pause' }, ['pause']],
    ['resume', { verb: 'resume' }, ['resume']],
    ['history', { verb: 'history', tail: 5 }, ['history', '--tail', '5']],
    ['history, the words', { verb: 'history', args: '--tail 7' }, ['history', '--tail', '7']],
    ['explain', { verb: 'explain' }, ['explain']],
  ]
  for (const [name, input, argv] of cases) {
    test(name, async ($, on) => {
      const w = world(on, { stateText: OWN, cli: () => ({ exitCode: 0, stdout: 'Outcome recorded.' }), answer: () => ({ ok: true, deny: null }) })
      const r: any = await tool($, input)
      expect(w.cliRuns).toHaveLength(1)
      const run = w.cliRuns[0]
      expect(run.argv).toEqual(argv)
      expect(run.node).toBe('node')
      expect(run.cwd).toBe(CWD)
      expect(run.env).toEqual({ PERSEVERANZA_VIA: 'tool' })
      expect(run.stdin).toBe('')
      expect(run.timeoutMs).toBe(60000)
      expect(r.result).toBe(`perseveranza ${argv[0]}: done (exit 0)\nOutcome recorded.`)
      // answered by the mod: never handed on to Claude Code (a call no hook answers fails)
      expect(w.ran).toHaveLength(0)
    })
  }

  test('a verb that refuses: its exit code and its words, as a result', async ($, on) => {
    const w = world(on, { stateText: OWN, cli: () => ({ exitCode: 1, stdout: 'claim-done REFUSED: no green test', stderr: 'warn' }), answer: () => ({ ok: true, deny: null }) })
    const r: any = await tool($, { verb: 'claim-done' })
    expect(r.result).toBe('perseveranza claim-done: FAILED or REFUSED (exit 1)\nclaim-done REFUSED: no green test\n[stderr]\nwarn')
  })

  test('a long output is cut, its head and its tail kept', async ($, on) => {
    const long = 'H' + 'x'.repeat(50000) + 'TAIL'
    world(on, { cli: () => ({ exitCode: 0, stdout: long }) })
    const r: any = await tool($, { verb: 'status' })
    expect(r.result.length).toBeLessThan(20200)
    expect(r.result).toContain('characters cut')
    expect(r.result.endsWith('TAIL')).toBe(true)
    expect(r.result).toContain('\nH')
  })

  test('the CLI does not start: an error result naming the shell fallback, the session goes on', async ($, on) => {
    world(on, { cli: () => 'reject' })
    const r: any = await tool($, { verb: 'status' })
    expect(r.deny).toContain('could not run')
    expect(r.deny).toContain('src/cli/perseveranza.mjs" status')
  })

  test('PERSEVERANZA_NODE names the node of the CLI too', async ($, on) => {
    const w = world(on, { nodeEnv: 'C:/node/node.exe' })
    await tool($, { verb: 'status' })
    expect(w.cliRuns[0].node).toBe('C:/node/node.exe')
  })

  test('the call is the turn\'s activity (the heartbeat)', async ($, on) => {
    const w = world(on, { stateText: OWN, answer: (q) => (q.op === 'tool-check' ? { ok: true, deny: null } : { ok: true, outcome: 'activity' }) })
    await tool($, { verb: 'report', args: 'pass' })
    await w.clock.advance(31000)
    expect(w.ops('activity-flush')).toHaveLength(1)
    expect(w.ops('activity-flush')[0].facts.activity).toMatchObject({ tool: TOOL })
  })
})

describe('the tool runs nothing the user\'s Bash permissions would govern', () => {
  // each refused before any process: no CLI, no bridge, nothing handed on
  const refused: [string, any, string][] = [
    ['test (the suite: a shell command)', { verb: 'test' }, '"test" does not run through this tool'],
    ['test with a command', { verb: 'test', command: 'node -e "require(\'fs\').writeFileSync(\'PWNED.txt\',\'x\')"' }, 'Run it as a shell command with Bash'],
    ['test, the words in the verb', { verb: 'test --if-needed -- npm test' }, '"test" does not run through this tool'],
    ['ask (an external agent CLI)', { verb: 'ask', provider: 'codex', slot: 'plan', prompt: 'write PWNED.txt' }, '"ask" does not run through this tool'],
    ['ask, the words', { verb: 'ask', args: 'cursor fix -- "hi"' }, 'ask <provider> <slot>'],
    ['resume --takeover, a field', { verb: 'resume', takeover: true }, 'taking a loop over (resume --takeover) is the user\'s decision'],
    ['resume --takeover, the words', { verb: 'resume', args: '--takeover' }, 'type /pf resume --takeover'],
    ['resume --takeover, in the verb', { verb: 'resume --takeover' }, 'type /pf resume --takeover'],
    ['arm', { verb: 'arm', args: '"x"' }, '/pf arm'],
    ['disarm', { verb: 'disarm' }, '/pf disarm'],
    ['runs', { verb: 'runs' }, 'unknown verb "runs"'],
    ['providers', { verb: 'providers', args: 'check' }, 'unknown verb "providers"'],
  ]
  for (const [name, input, words] of refused) {
    test(name, async ($, on) => {
      const w = world(on, { stateText: OWN, answer: () => ({ ok: true, deny: null }) })
      const r: any = await tool($, input)
      expect(r.deny).toContain(words)
      expect(r.deny).toContain('Nothing was run')
      expect(w.cliRuns).toHaveLength(0)
      expect(w.reqs).toHaveLength(0)
      expect(w.ran).toHaveLength(0)
    })
  }

  test('test and ask name the CLI for Bash (with the plugin\'s path)', async ($, on) => {
    world(on, {})
    const t: any = await tool($, { verb: 'test' })
    expect(t.deny).toMatch(/node ".*src\/cli\/perseveranza\.mjs" test --if-needed -- <the suite>/)
    const a: any = await tool($, { verb: 'ask' })
    expect(a.deny).toMatch(/node ".*src\/cli\/perseveranza\.mjs" ask <provider> <slot> -- "<prompt>"/)
  })

  test('a loop of another session: every verb that changes something refused, the read-only ones run', async ($, on) => {
    const w = world(on, { stateText: FOREIGN, answer: () => ({ ok: true, deny: null }) })
    for (const input of [{ verb: 'report', args: 'pass' }, { verb: 'complexity', args: 'low' }, { verb: 'claim-done' }, { verb: 'pause' }, { verb: 'resume' }]) {
      const r: any = await tool($, input)
      expect(r.deny).toContain('belongs to session other-se, not to this one (S1)')
      expect(r.deny).toContain('/pf resume --takeover')
    }
    expect(w.cliRuns).toHaveLength(0)
    expect(w.reqs).toHaveLength(0)
    for (const verb of ['status', 'history', 'explain']) await tool($, { verb })
    expect(w.cliRuns.map((c) => c.argv[0])).toEqual(['status', 'history', 'explain'])
  })

  for (const [name, stateText] of [['another session\'s', FOREIGN], ['S1\'s', OWN]] as const) {
    test(`no session id known (empty): ${name} loop is not this session's, every verb that changes something refused`, async ($, on) => {
      const w = world(on, { stateText, session: '', answer: () => ({ ok: true, deny: null }) })
      for (const input of [{ verb: 'report', args: 'pass' }, { verb: 'pause' }, { verb: 'claim-done' }]) {
        const r: any = await tool($, input)
        expect(r.deny).toContain('not to this one')
      }
      expect(w.cliRuns).toHaveLength(0)
    })
  }

  test('a loop nobody claimed yet (just armed, or released by the user): the tool may act on it', async ($, on) => {
    const w = world(on, { stateText: UNCLAIMED, answer: () => ({ ok: true, deny: null }) })
    const r: any = await tool($, { verb: 'complexity', args: 'low' })
    expect(r.result).toContain('done')
    expect(w.cliRuns[0].argv).toEqual(['complexity', 'low'])
  })

  test('the owner unreadable: refused (the CLI with Bash stays), nothing run', async ($, on) => {
    const w = world(on, {})
    const r: any = await tool($, { verb: 'pause' })
    expect(r.deny).toContain('owner could not be read')
    expect(r.deny).toContain('perseveranza.mjs" pause')
    expect(w.cliRuns).toHaveLength(0)
  })
})

describe('the tool: arguments checked before any process', () => {
  const bad: [string, any, string][] = [
    ['no verb', {}, '"verb" is missing'],
    ['a verb not a string', { verb: 3 }, '"verb" is missing'],
    ['an unknown verb', { verb: 'bogus' }, 'unknown verb "bogus"'],
    ['an unknown argument', { verb: 'status', extra: 1 }, 'unknown argument "extra"'],
    ['an argument of another verb', { verb: 'report', outcome: 'pass', level: 'low' }, '"level" is not an argument of report'],
    ['no outcome', { verb: 'report' }, 'report takes one word: pass or fail'],
    ['an outcome outside the enum', { verb: 'report', outcome: 'maybe' }, '"outcome" must be one of pass, fail'],
    ['words outside the enum', { verb: 'report', args: 'maybe' }, 'report takes one word'],
    ['a field and words that disagree', { verb: 'report', outcome: 'pass', args: 'fail' }, 'disagree'],
    ['a level outside the enum', { verb: 'complexity', level: 'huge' }, '"level" must be one of low, medium, high'],
    ['words after a verb that takes none', { verb: 'claim-done', args: 'now' }, 'claim-done takes no words'],
    ['args not a string', { verb: 'report', args: ['pass'] }, '"args" must be a string'],
    ['args too long', { verb: 'history', args: 'x'.repeat(201) }, 'longer than 200'],
    ['a tail out of range', { verb: 'history', tail: 0 }, 'from 1 to 500'],
    ['a tail not a number', { verb: 'history', tail: '5; rm' }, 'from 1 to 500'],
  ]
  for (const [name, input, words] of bad) {
    test(name, async ($, on) => {
      const w = world(on, { stateText: OWN })
      const r: any = await tool($, input)
      expect(r.deny).toContain(words)
      expect(r.deny).toContain('Nothing was run')
      expect(w.cliRuns).toHaveLength(0)
      expect(w.reqs).toHaveLength(0)
    })
  }
})

describe('the tool: the gate and the reconciliation', () => {
  test('no loop armed (no state.json): refused with the reason, no node process; status runs', async ($, on) => {
    const w = world(on, { files: ['config.json', 'runs'] })
    for (const verb of ['claim-done', 'pause', 'explain']) {
      const r: any = await tool($, { verb })
      expect(r.deny).toContain('no loop is armed')
      expect(r.deny).toContain('state.json')
    }
    const r2: any = await tool($, { verb: 'report', args: 'pass' })
    expect(r2.deny).toContain('nothing to report')
    expect(w.cliRuns).toHaveLength(0)
    expect(w.reqs).toHaveLength(0)
    const s: any = await tool($, { verb: 'status' })
    expect(s.result).toContain('perseveranza status: done')
    expect(w.cliRuns.map((c) => c.argv[0])).toEqual(['status'])
  })

  test('the gate check fails: the CLI decides (it says when there is no loop)', async ($, on) => {
    const w = world(on, { gate: 'throw', stateText: OWN, answer: () => ({ ok: true, deny: null }) })
    await tool($, { verb: 'pause' })
    expect(w.cliRuns).toHaveLength(1)
  })

  test('a restored loop being reconciled: a verb that changes something is refused by the guard, no CLI', async ($, on) => {
    const w = world(on, { stateText: OWN, answer: (q) => (q.op === 'tool-check' ? { ok: true, deny: 'perseveranza: the loop is being reconciled after a restore; the `report` verb is refused' } : { ok: true }) })
    const r: any = await tool($, { verb: 'report', outcome: 'pass' })
    expect(r.deny).toContain('reconciled')
    expect(w.ops('tool-check')[0].event).toMatchObject({ tool: TOOL, input: { verb: 'report' }, session_id: 'S1' })
    expect(w.cliRuns).toHaveLength(0)
  })

  test('the read-only verbs do not ask the guard nor read the owner', async ($, on) => {
    const w = world(on, {})
    for (const verb of ['status', 'history', 'explain']) await tool($, { verb })
    expect(w.ops('tool-check')).toHaveLength(0)
    expect(w.reads).toHaveLength(0)
    expect(w.cliRuns).toHaveLength(3)
  })

  test('the guard fails: fail-open (the verb runs), journaled as a skipped hook', async ($, on) => {
    const w = world(on, { stateText: OWN, answer: (q) => (q.op === 'tool-check' ? 'reject' : { ok: true, journaled: 1 }) })
    const r: any = await tool($, { verb: 'pause' })
    expect(r.result).toContain('perseveranza pause: done')
    expect(w.ops('journal')[0].facts.lines[0]).toMatchObject({ type: 'mod-hook-skipped', hook: 'tool.call' })
  })

  test('another tool is not the mod\'s: handed on as before', async ($, on) => {
    const w = world(on, {})
    await $.tool.call({ tool: 'mcp__other__perseveranza', verb: 'status' } as any)
    expect(w.cliRuns).toHaveLength(0)
    expect(w.ran).toHaveLength(1)
  })
})

describe('/pf: the user\'s command', () => {
  test('status: the CLI\'s output as text, no model turn, exit code for -p', async ($, on) => {
    const w = world(on, { cli: () => ({ exitCode: 0, stdout: 'phase: plan' }) })
    const r: any = await command($, 'status')
    expect(r).toEqual({ text: 'perseveranza status: done (exit 0)\nphase: plan', exitCode: 0 })
    expect(w.cliRuns[0]).toMatchObject({ argv: ['status'], env: { PERSEVERANZA_VIA: 'command' }, cwd: CWD })
  })

  test('no words: status', async ($, on) => {
    const w = world(on, {})
    await command($, '')
    expect(w.cliRuns[0].argv).toEqual(['status'])
  })

  test('arm with the CLI\'s arguments, quotes split like a shell, never given to one; the session id and the sign of life go first', async ($, on) => {
    const w = world(on, { gate: false, session: 'sess-9' })
    await command($, `arm "fix the \\"login\\" bug; rm -rf /" --complexity low --test 'npm test' --no-push`)
    expect(w.cliRuns[0].argv).toEqual(['arm', 'fix the "login" bug; rm -rf /', '--complexity', 'low', '--test', 'npm test', '--no-push'])
    expect(w.cliRuns[0].env).toEqual({ PERSEVERANZA_VIA: 'command', CLAUDE_CODE_SESSION_ID: 'sess-9' })
    expect(w.cliRuns[0].timeoutMs).toBe(180000)
    expect(w.alive.map((a) => a.path)).toEqual([`${USER_PROFILE}/.perseveranza/mod-alive/sess-9.json`])
  })

  test('arm from claude -p (origin sdk) and the Remote Control bridge run too', async ($, on) => {
    const w = world(on, { gate: false })
    await command($, 'arm "x"', 'sdk')
    await command($, 'arm "y"', 'bridge')
    expect(w.cliRuns.map((c) => c.argv[1])).toEqual(['x', 'y'])
  })

  test('arm refused by the CLI: its exit code and its words', async ($, on) => {
    world(on, { gate: false, cli: () => ({ exitCode: 1, stdout: 'perseveranza is ALREADY armed in this project.' }) })
    const r: any = await command($, 'arm "x"')
    expect(r.exitCode).toBe(1)
    expect(r.text).toContain('ALREADY armed')
  })

  test('disarm runs without state.json (a retained run is the CLI\'s to archive)', async ($, on) => {
    const w = world(on, { gate: false })
    const r: any = await command($, 'disarm')
    expect(r.exitCode).toBe(0)
    expect(w.cliRuns[0].argv).toEqual(['disarm'])
  })

  test('a verb that takes no words refuses extra ones: `/pf disarm the legacy alarm module` disarms nothing', async ($, on) => {
    const w = world(on, {})
    for (const words of ['disarm the legacy alarm module', 'disarm --no-archive please', 'pause for lunch', 'resume now', 'resume --takeover yes', 'claim-done x', 'status of things', 'report', 'report pass now', 'complexity extreme']) {
      const r: any = await command($, words)
      expect(r.exitCode).toBe(2)
      expect(r.text).toContain('Nothing was run')
    }
    expect(w.cliRuns).toHaveLength(0)
    expect(w.reqs).toHaveLength(0)
  })

  test('a verb on the loop without one: refused, no process (ask and test included)', async ($, on) => {
    const w = world(on, { gate: false })
    for (const words of ['report pass', 'ask codex plan -- "hi"', 'test -- npm test', 'resume --takeover']) {
      const r: any = await command($, words)
      expect(r.exitCode).toBe(1)
      expect(r.text).toContain('no loop is armed')
    }
    expect(w.cliRuns).toHaveLength(0)
  })

  test('test and ask from the user: the words go as the CLI takes them', async ($, on) => {
    const w = world(on, {})
    await command($, 'test --if-needed -- npm test')
    await command($, 'ask codex plan -- "is this right?"')
    await command($, 'resume --takeover')
    expect(w.cliRuns[0]).toMatchObject({ argv: ['test', '--if-needed', '--', 'npm', 'test'], timeoutMs: 600000 })
    expect(w.cliRuns[1]).toMatchObject({ argv: ['ask', 'codex', 'plan', '--', 'is this right?'], timeoutMs: 600000 })
    expect(w.cliRuns[2].argv).toEqual(['resume', '--takeover'])
  })

  test('from another plugin ($.command.run: origin plugin) or an unknown origin: arm, disarm, test, ask and a takeover run nothing', async ($, on) => {
    const w = world(on, {})
    for (const kind of ['plugin', 'peer', 'channel', 'unclassified', '']) {
      for (const words of ['arm "x" --force', 'disarm', 'test -- npm test', 'ask codex plan -- "x"', 'resume --takeover']) {
        const r: any = await command($, words, kind)
        expect(r.exitCode).toBe(1)
        expect(r.text).toContain('runs only when the user types it')
      }
    }
    expect(w.cliRuns).toHaveLength(0)
    // what only reads, or moves this session's loop, runs for them
    await command($, 'status', 'plugin')
    await command($, 'resume', 'plugin')
    expect(w.cliRuns.map((c) => c.argv)).toEqual([['status'], ['resume']])
  })

  test('no origin at all, or an origin without a kind: the same refusal, nothing run', async ($, on) => {
    const w = world(on, {})
    for (const e of [{ command: 'pf' }, { command: 'pf', origin: {} }, { command: 'pf', origin: { kind: 3 } }, { command: 'pf', origin: null }]) {
      for (const args of ['arm "x"', 'disarm', 'test -- npm test', 'ask codex plan -- "x"', 'resume --takeover']) {
        const r: any = await $.command.run({ ...e, args } as any)
        expect(r.exitCode).toBe(1)
        expect(r.text).toContain('an unknown origin')
      }
    }
    expect(w.cliRuns).toHaveLength(0)
  })

  test('runs show: the ids runs list prints (project/stamp, or the stamp), nothing else', async ($, on) => {
    const w = world(on, {})
    await command($, 'runs show my-proj/2026-10-05T10-04-16-591Z-nriWqy')
    await command($, 'runs show 2026-10-05T10-04-16-591Z-nriWqy --all')
    expect(w.cliRuns.map((c) => c.argv)).toEqual([['runs', 'show', 'my-proj/2026-10-05T10-04-16-591Z-nriWqy'], ['runs', 'show', '2026-10-05T10-04-16-591Z-nriWqy', '--all']])
    for (const bad of ['a/b/c', '/abs', 'proj/..', '../x', '.hidden', 'proj/.x', 'a\\b', 'C:x', 'proj/']) {
      const r: any = await command($, `runs show '${bad}'`)
      expect(r.exitCode).toBe(2)
    }
    expect(w.cliRuns).toHaveLength(2)
  })

  test('help, an unknown verb (a task typed as for the markdown command), an unclosed quote', async ($, on) => {
    const w = world(on, {})
    const h: any = await command($, 'help')
    expect(h.exitCode).toBe(0)
    expect(h.text).toContain('/perseveranza <task>')
    const u: any = await command($, 'write the docs')
    expect(u.exitCode).toBe(2)
    expect(u.text).toContain('unknown verb "write"')
    expect(u.text).toContain('/perseveranza <task>')
    const q: any = await command($, 'arm "unclosed')
    expect(q.exitCode).toBe(2)
    expect(q.text).toContain('quote is not closed')
    expect(w.cliRuns).toHaveLength(0)
  })

  test('the CLI does not start: said, exit 1', async ($, on) => {
    world(on, { cli: () => 'reject' })
    const r: any = await command($, 'status')
    expect(r.exitCode).toBe(1)
    expect(r.text).toContain('could not run')
  })

  test('an exit code outside 0..255 becomes 1 (a negative one too); 2 stays 2, said as a failure', async ($, on) => {
    let code = 300
    world(on, { cli: () => ({ exitCode: code, stdout: '' }) })
    expect(((await command($, 'status')) as any).exitCode).toBe(1)
    code = -1
    expect(((await command($, 'status')) as any).exitCode).toBe(1)
    code = 2
    const r: any = await command($, 'status')
    expect(r.exitCode).toBe(2)
    expect(r.text).toContain('FAILED or REFUSED (exit 2)')
  })
})
