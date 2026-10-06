// classic.Stop under the mod: the bridge's answer is the decision; no answer is fail-closed
// (one recovery block) but never an endless block (stop_hook_active), and a project without a
// loop folder is never blocked nor pays for a node process.
import { expect, test, describe } from 'claude-code/testing'
import { world, stepBottom, step, tokens, counts, OK_ALLOW, ROOT_HINT, CWD } from './world.ts'

const BLOCK = { ok: true, decision: { block: 'PHASE: implement. Do the next step.' }, outcome: 'always' }
const UNCLAIMED = JSON.stringify({ owner: { sessionId: '' } })
const OWNED = (id: string) => JSON.stringify({ owner: { sessionId: id } })

describe('classic.Stop', () => {
  test('a project without a loop folder: no bridge call, Claude stops', async ($, on) => {
    const w = world(on, { gate: false, answer: () => BLOCK })
    const r: any = await $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
    expect(w.reqs).toHaveLength(0)
    expect(r.block).toBeUndefined()
  })

  test('the bridge blocks: the next instruction, with the facts only the mod sees', async ($, on) => {
    const w = world(on, { answer: (q) => (q.op === 'stop' ? BLOCK : { ok: true, journaled: 1 }) })
    const bg = [{ id: 'a1', type: 'subagent', status: 'running', agent_type: 'perseveranza:pf-executor', description: 'step one' }]
    const r: any = await $.classic.Stop({ stop_hook_active: false, cwd: CWD, background_tasks: bg, last_assistant_message: 'done' } as any)
    expect(r.block).toBe('PHASE: implement. Do the next step.')
    const [q] = w.ops('stop')
    expect(q.cwd).toBe(CWD)
    expect(q.argv[0]).toBe('node')
    expect(q.argv[1].replaceAll('\\', '/')).toEndWith(ROOT_HINT)
    expect(q.timeoutMs).toBe(125000)
    expect(q.facts).toEqual({ backgroundTasks: bg, loopMode: 'shell', usage: {} })
    expect(q.event.last_assistant_message).toBe('done')
    expect(q.event.stop_hook_active).toBe(false)
  })

  test('the bridge lets Claude stop: no block', async ($, on) => {
    world(on, { answer: () => OK_ALLOW })
    const r: any = await $.classic.Stop({ stop_hook_active: true, cwd: CWD } as any)
    expect(r.block).toBeUndefined()
  })

  test('PERSEVERANZA_NODE names the node binary', async ($, on) => {
    const w = world(on, { nodeEnv: 'C:/tools/node.exe', answer: () => OK_ALLOW })
    await $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
    expect(w.ops('stop')[0].argv[0]).toBe('C:/tools/node.exe')
  })

  for (const [what, answer] of [
    ['no answer (the bridge did not start)', 'reject'],
    ['an answer that is not JSON', 'Error: Cannot find module'],
    ['an answer with ok: false', { ok: false, error: 'request is not a JSON object' }],
  ] as const) {
    test(`${what}: one recovery block, journaled; with stop_hook_active already true, Claude stops`, async ($, on) => {
      // an unclaimed loop: this session's to resume
      const w = world(on, { stateText: UNCLAIMED, answer: (q) => (q.op === 'stop' ? answer : { ok: true, journaled: 1 }) })
      const r: any = await $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
      expect(r.block).toContain('could not reach its helper')
      expect(r.block).toContain('src/cli/perseveranza.mjs" status')
      const j = w.ops('journal').map((q) => q.facts.lines[0])
      expect(j).toContainEqual(expect.objectContaining({ type: 'mod-hook-skipped', hook: 'classic.Stop', recovery: true }))
      // the next stop fails too: never an endless block
      const r2: any = await $.classic.Stop({ stop_hook_active: true, cwd: CWD } as any)
      expect(r2.block).toBeUndefined()
      expect(w.ops('journal').map((q) => q.facts.lines[0])).toContainEqual(expect.objectContaining({ type: 'mod-hook-skipped', hook: 'classic.Stop', recovery: false }))
    })
  }

  test('the bridge fails and the loop folder cannot be checked: Claude stops (a session with no loop is never blocked)', async ($, on) => {
    // even with a state that reads as unclaimed: the unknown gate decides
    const w = world(on, { gate: 'throw', stateText: UNCLAIMED, answer: () => 'reject' })
    const r: any = await $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
    expect(w.ops('stop')).toHaveLength(1)
    expect(r.block).toBeUndefined()
  })

  test('the Claude Code version goes to the journal once, after the first stop of a live loop', async ($, on) => {
    const w = world(on, { answer: (q) => (q.op === 'stop' ? BLOCK : { ok: true, journaled: 1 }) })
    await $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
    await $.classic.Stop({ stop_hook_active: true, cwd: CWD } as any)
    const hello = w.ops('journal').filter((q) => q.facts.lines[0].type === 'mod-start')
    expect(hello).toHaveLength(1)
    expect(hello[0].facts.lines[0]).toEqual({ type: 'mod-start', claudeCode: '2.1.289', ok: true, min: '2.1.287', problem: '' })
  })

  test('a dormant stop sends no version line', async ($, on) => {
    const w = world(on, { answer: () => ({ ok: true, decision: { allowStop: true }, outcome: 'dormant' }) })
    await $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
    expect(w.ops('journal')).toHaveLength(0)
  })
})

describe('classic.Stop and the tokens', () => {
  test('the tokens measured since the last flush go with the stop, per agent, exact', async ($, on) => {
    const box = stepBottom(on)
    const w = world(on, { answer: () => BLOCK })
    box.usage = tokens(100, 20, 300, 40)
    await step($)
    box.usage = tokens(7, 3)
    await step($, 'agent-9')
    await step($, 'agent-9')
    await $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
    expect(w.ops('stop')[0].facts.usage).toEqual({ byAgent: { main: counts(100, 20, 300, 40), 'agent-9': counts(14, 6) } })
    expect(w.ops('usage-flush')).toHaveLength(0)
    // taken: the next stop carries nothing (an empty mod reading)
    await $.classic.Stop({ stop_hook_active: true, cwd: CWD } as any)
    expect(w.ops('stop')[1].facts.usage).toEqual({})
  })

  test('usageDropped: the delta goes again with the next stop', async ($, on) => {
    const box = stepBottom(on)
    let n = 0
    const w = world(on, { answer: (q) => (q.op === 'stop' && ++n === 1 ? { ...BLOCK, usageDropped: 'ENOSPC' } : BLOCK) })
    box.usage = tokens(50)
    await step($)
    await $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
    box.usage = tokens(5)
    await step($)
    await $.classic.Stop({ stop_hook_active: true, cwd: CWD } as any)
    expect(w.ops('stop')[1].facts.usage).toEqual({ byAgent: { main: counts(55) } })
  })

  for (const [what, answer] of [
    ['usageUnverified (may already be counted)', { ...BLOCK, usageUnverified: 'f.json' }],
    ['no answer (it may be queued already)', 'reject'],
    ['ok: false (it may be queued already)', { ok: false, error: 'boom' }],
  ] as const) {
    test(`${what}: the delta is never sent again`, async ($, on) => {
      const box = stepBottom(on)
      let n = 0
      const w = world(on, { answer: (q) => (q.op === 'stop' ? (++n === 1 ? answer : BLOCK) : { ok: true, journaled: 1 }) })
      box.usage = tokens(50)
      await step($)
      await $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
      await $.classic.Stop({ stop_hook_active: true, cwd: CWD } as any)
      expect(w.ops('stop')[1].facts.usage).toEqual({})
    })
  }

  test('a request with only output or cache tokens is counted', async ($, on) => {
    const box = stepBottom(on)
    const w = world(on, { answer: () => BLOCK })
    box.usage = tokens(0, 0, 500)
    await step($)
    box.usage = tokens(0, 7)
    await step($, 'agent-2')
    await $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
    expect(w.ops('stop')[0].facts.usage).toEqual({ byAgent: { main: counts(0, 0, 500), 'agent-2': counts(0, 7) } })
  })

  test('the stop waits for a token flush on its way: a delta the flush gives back goes with this stop', async ($, on) => {
    const box = stepBottom(on)
    let w: any
    w = world(on, {
      answer: async (q) => {
        if (q.op === 'usage-flush') { await w.clock.sleep(1000); return { ok: false, error: 'ENOSPC' } }
        return BLOCK
      },
    })
    box.usage = tokens(40)
    await step($)
    await w.clock.advance(15000)
    expect(w.ops('usage-flush')).toHaveLength(1)
    // the flush is held by the bridge; the stop comes now
    const p = $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
    await w.clock.settle()
    expect(w.ops('stop')).toHaveLength(0)
    await w.clock.advance(1000)
    await p
    expect(w.ops('stop')[0].facts.usage).toEqual({ byAgent: { main: counts(40) } })
  })

  test('a flush that hangs holds the stop 5 s at most', async ($, on) => {
    const box = stepBottom(on)
    let w: any
    w = world(on, {
      answer: async (q) => {
        if (q.op === 'usage-flush') { await w.clock.sleep(60000); return { ok: false, error: 'ENOSPC' } }
        return BLOCK
      },
    })
    box.usage = tokens(40)
    await step($)
    await w.clock.advance(15000)
    box.usage = tokens(2)
    await step($)
    const p = $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
    await w.clock.advance(4999)
    expect(w.ops('stop')).toHaveLength(0)
    await w.clock.advance(1)
    const r: any = await p
    expect(r.block).toContain('PHASE: implement')
    // what was in memory goes; the held delta comes back later, for the next stop
    expect(w.ops('stop')[0].facts.usage).toEqual({ byAgent: { main: counts(2) } })
    await w.clock.advance(60000)
    await $.classic.Stop({ stop_hook_active: true, cwd: CWD } as any)
    expect(w.ops('stop')[1].facts.usage).toEqual({ byAgent: { main: counts(40) } })
  })

  test('no flush on its way: the stop does not wait', async ($, on) => {
    const box = stepBottom(on)
    const w = world(on, { answer: () => BLOCK })
    box.usage = tokens(3)
    await step($)
    const p = $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
    await w.clock.settle()
    expect(w.ops('stop')).toHaveLength(1)
    await p
  })
})

describe('classic.Stop beneath and after', () => {
  test('a block keeps what the hooks beneath answered', async ($, on) => {
    world(on, { stopBottom: { systemMessage: 'from beneath' }, answer: () => BLOCK })
    const r: any = await $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
    expect(r.block).toBe('PHASE: implement. Do the next step.')
    expect(r.systemMessage).toBe('from beneath')
  })

  test('a version line the bridge did not journal is offered again, three times at most', async ($, on) => {
    const w = world(on, { answer: (q) => (q.op === 'stop' ? BLOCK : { ok: true, journaled: 0, outcome: 'foreign-session' }) })
    for (let i = 0; i < 5; i++) await $.classic.Stop({ stop_hook_active: i > 0, cwd: CWD, session_id: 'S1' } as any)
    const hello = w.ops('journal').filter((q) => q.facts.lines[0].type === 'mod-start')
    expect(hello).toHaveLength(3)
    expect(hello[0].event).toEqual({ session_id: 'S1' })
  })
})

// The gate is a loop, not a folder: ~/.perseveranza (the config and the archive) and a project
// whose run was archived both have a .perseveranza/ folder and no loop.
describe('a .perseveranza folder without a loop', () => {
  test('no hook starts a node process, nothing is blocked, nothing written, even with node unreachable', async ($, on) => {
    const box = stepBottom(on)
    const w = world(on, { files: ['config.json', 'runs'], stateText: UNCLAIMED, answer: () => 'reject' })
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false } as any)
    const ss: any = await $.classic.SessionStart({ source: 'startup', cwd: CWD, session_id: 'S1', transcript_path: '' } as any)
    expect(ss.additionalContext).toBeUndefined()
    box.usage = tokens(10)
    await step($)
    await $.tool.call({ tool: 'Agent', subagent_type: 'perseveranza:pf-verifier', prompt: 'p' } as any)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
    await $.tool.call({ tool: 'Edit', file_path: 'a', old_string: 'a', new_string: 'b' } as any)
    await $.agent.spawn({ prompt: 'p', description: 'd', subagentType: 'perseveranza:pf-executor', model: 'opus' } as any)
    const sub: any = await $.classic.SubagentStop({ agent_id: 'v1', agent_type: 'perseveranza:pf-verifier', stop_hook_active: false, cwd: CWD, agent_transcript_path: '' } as any)
    expect(sub.block).toBeUndefined()
    await w.clock.advance(60000)
    const r: any = await $.classic.Stop({ stop_hook_active: false, cwd: CWD, session_id: 'S1' } as any)
    expect(r.block).toBeUndefined()
    await w.clock.advance(60000)
    expect(w.reqs).toHaveLength(0)
    expect(w.writes).toHaveLength(0)
    expect(w.ran).toHaveLength(3)
    expect(w.spawned[0].model).toBe('opus')
    // what the gate looked at: the loop's state files, never the folder
    expect(w.exists.some((p: string) => p.endsWith('/.perseveranza/state.json'))).toBe(true)
    expect(w.exists.some((p: string) => p.endsWith('/.perseveranza'))).toBe(false)
  })

  for (const [what, files, armed] of [
    ['only the pending copy of a save cut short', ['state.json.pending'], true],
    ['a pending copy and the disarm mark', ['state.json.pending', 'state.disarmed.mark'], false],
    ['a pending copy and a retained state', ['state.json.pending', 'state.disarmed.json'], false],
    ['state.json', ['state.json', 'state.disarmed.mark'], true],
  ] as const) {
    test(`${what}: ${armed ? 'a loop, the bridge is asked' : 'no loop, no node process'}`, async ($, on) => {
      const w = world(on, { files: [...files], answer: () => BLOCK })
      const r: any = await $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
      expect(w.ops('stop')).toHaveLength(armed ? 1 : 0)
      expect(r.block).toBe(armed ? 'PHASE: implement. Do the next step.' : undefined)
    })
  }
})

// The bridge fails at a stop of a live loop: recovery once, for this session's loop only, and
// a durable trace when the failure cannot even be journaled.
describe('classic.Stop when the bridge fails', () => {
  test('node unreachable: the fault marker is written, the recovery block given, the line under the prompt', async ($, on) => {
    const w = world(on, { stateText: OWNED('S1'), answer: () => 'reject' })
    const r: any = await $.classic.Stop({ stop_hook_active: false, cwd: CWD, session_id: 'S1' } as any)
    expect(r.block).toContain('could not reach its helper')
    expect(w.writes).toHaveLength(1)
    expect(w.writes[0].path).toBe(`${CWD}/.perseveranza/mod-fault.json`)
    expect(JSON.parse(w.writes[0].text)).toEqual({ at: 1_000_000, hook: 'classic.Stop', error: expect.stringContaining('ENOENT'), session: 'S1', stopHookActive: false, recovery: true })
    expect(w.statuses.join(' ')).toContain('could not reach its helper')
    expect(w.logs.join(' ')).toContain('could not reach its helper')
  })

  test('stop_hook_active: Claude stops, and the stop leaves its trace', async ($, on) => {
    const w = world(on, { stateText: OWNED('S1'), answer: () => 'reject' })
    const r: any = await $.classic.Stop({ stop_hook_active: true, cwd: CWD, session_id: 'S1' } as any)
    expect(r.block).toBeUndefined()
    expect(JSON.parse(w.writes[0].text)).toMatchObject({ stopHookActive: true, recovery: false })
    expect(w.statuses.join(' ')).toContain('watchdog takes over')
  })

  test('journaled through the bridge: no marker', async ($, on) => {
    const w = world(on, { stateText: OWNED('S1'), answer: (q) => (q.op === 'stop' ? 'reject' : { ok: true, journaled: 1 }) })
    const r: any = await $.classic.Stop({ stop_hook_active: false, cwd: CWD, session_id: 'S1' } as any)
    expect(r.block).toContain('could not reach its helper')
    expect(w.ops('journal')[0].event).toEqual({ session_id: 'S1' })
    expect(w.writes).toHaveLength(0)
  })

  test('the marker cannot be written: the recovery block all the same', async ($, on) => {
    world(on, { stateText: OWNED('S1'), writeFails: true, answer: () => 'reject' })
    const r: any = await $.classic.Stop({ stop_hook_active: false, cwd: CWD, session_id: 'S1' } as any)
    expect(r.block).toContain('could not reach its helper')
  })

  test('another session\'s loop: never blocked, nothing written, no node process for the catch', async ($, on) => {
    const w = world(on, { stateText: OWNED('OTHER'), answer: () => 'reject' })
    const r: any = await $.classic.Stop({ stop_hook_active: false, cwd: CWD, session_id: 'S1' } as any)
    expect(r.block).toBeUndefined()
    expect(w.writes).toHaveLength(0)
    expect(w.ops('journal')).toHaveLength(0)
  })

  test('the owner cannot be read: blocked only if this process drove the loop before', async ($, on) => {
    let fail = true
    const w = world(on, { answer: (q) => (q.op === 'stop' ? (fail ? 'reject' : BLOCK) : 'reject') })
    const r1: any = await $.classic.Stop({ stop_hook_active: false, cwd: CWD, session_id: 'S1' } as any)
    expect(r1.block).toBeUndefined()
    expect(w.writes).toHaveLength(0)
    fail = false
    await $.classic.Stop({ stop_hook_active: false, cwd: CWD, session_id: 'S1' } as any)
    fail = true
    const r3: any = await $.classic.Stop({ stop_hook_active: false, cwd: CWD, session_id: 'S1' } as any)
    expect(r3.block).toContain('could not reach its helper')
    expect(w.writes).toHaveLength(1)
  })

  test('a dormant or foreign answer is not driving', async ($, on) => {
    let n = 0
    const w = world(on, { answer: (q) => (q.op === 'stop' ? (++n === 1 ? { ok: true, decision: { allowStop: true }, outcome: 'foreign-session' } : n === 2 ? { ok: true, decision: { allowStop: true }, outcome: 'dormant' } : 'reject') : 'reject') })
    for (let i = 0; i < 3; i++) await $.classic.Stop({ stop_hook_active: false, cwd: CWD, session_id: 'S1' } as any)
    expect(w.writes).toHaveLength(0)
  })
})
