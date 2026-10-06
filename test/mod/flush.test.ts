// The debounced flushes: tokens (turn.step -> usage-flush) and the heartbeat (tool.call,
// classic.SubagentStop -> activity-flush), with the bridge's contract for each answer.
import { expect, test, describe } from 'claude-code/testing'
import { world, stepBottom, step, tokens, counts, CWD } from './world.ts'

const QUEUED = { ok: true, decision: { allowStop: true }, outcome: 'usage-queued', file: 'x.json' }
const WRITTEN = { ok: true, decision: { allowStop: true }, outcome: 'activity', atomic: true, journaled: 0 }
// the guard's answer for the mutating tools (Agent, Bash...): let it run
const FREE = { ok: true, deny: null, outcome: 'free' }
// activity-flush answered by `flush`, the guard always free: no answer meant for the flush is
// spent on a tool-check
const byOp = (flush: (q: any) => any) => (q: any) => (q.op === 'tool-check' ? FREE : q.op === 'activity-flush' ? flush(q) : { ok: true, journaled: 1 })

describe('usage-flush', () => {
  test('one flush 15 s after the first request, with every request until then; then a new window', async ($, on) => {
    const box = stepBottom(on)
    const w = world(on, { answer: () => QUEUED })
    box.usage = tokens(10, 1)
    await step($)
    await w.clock.advance(5000)
    await step($, 'agent-1')
    await w.clock.advance(9999)
    expect(w.ops('usage-flush')).toHaveLength(0)
    await w.clock.advance(1)
    const f = w.ops('usage-flush')
    expect(f).toHaveLength(1)
    expect(f[0].facts).toEqual({ usage: { byAgent: { main: counts(10, 1), 'agent-1': counts(10, 1) } } })
    expect(f[0].event).toEqual({ session_id: 'S1' })
    expect(f[0].cwd).toBe(CWD)
    expect(f[0].timeoutMs).toBe(8000)
    await w.clock.advance(60000)
    expect(w.ops('usage-flush')).toHaveLength(1, 'nothing new, nothing sent')
    await step($)
    await w.clock.advance(15000)
    expect(w.ops('usage-flush')).toHaveLength(2)
    expect(w.ops('usage-flush')[1].facts.usage.byAgent).toEqual({ main: counts(10, 1) })
  })

  test('a request without usage counts nothing and schedules nothing', async ($, on) => {
    const box = stepBottom(on)
    const w = world(on, { answer: () => QUEUED })
    box.usage = null
    await step($)
    await w.clock.advance(60000)
    expect(w.reqs).toHaveLength(0)
  })

  test('dropped (no file can exist): sent again with the next flush', async ($, on) => {
    const box = stepBottom(on)
    let n = 0
    const w = world(on, { answer: () => (++n === 1 ? { ok: false, error: 'ENOSPC: no space left' } : QUEUED) })
    box.usage = tokens(100)
    await step($)
    await w.clock.advance(15000)
    box.usage = tokens(1)
    await step($)
    await w.clock.advance(15000)
    const f = w.ops('usage-flush')
    expect(f).toHaveLength(2)
    expect(f[1].facts.usage.byAgent).toEqual({ main: counts(101) })
  })

  for (const [what, answer] of [
    ['unverified (a file may already be counted)', { ...QUEUED, unverified: true }],
    ['no answer (the bridge may have queued it)', 'reject'],
    ['no-loop (no run to count it for)', { ok: false, error: 'no-loop' }],
    ['another session\'s loop', { ok: true, decision: { allowStop: true }, outcome: 'foreign-session' }],
    ['state.json busy: queued as armUnknown', { ...QUEUED, armUnknown: true }],
  ] as const) {
    test(`${what}: never sent again`, async ($, on) => {
      const box = stepBottom(on)
      let n = 0
      const w = world(on, { answer: () => (++n === 1 ? answer : QUEUED) })
      box.usage = tokens(100)
      await step($)
      await w.clock.advance(15000)
      box.usage = tokens(1)
      await step($)
      await w.clock.advance(15000)
      const f = w.ops('usage-flush')
      expect(f).toHaveLength(2)
      expect(f[1].facts.usage.byAgent).toEqual({ main: counts(1) })
    })
  }

  test('no loop folder: the tokens are no run\'s, no node process', async ($, on) => {
    const box = stepBottom(on)
    const w = world(on, { gate: false, answer: () => QUEUED })
    box.usage = tokens(100)
    await step($)
    await w.clock.advance(15000)
    expect(w.reqs).toHaveLength(0)
  })

  test('a stop takes the pending tokens and cancels the flush', async ($, on) => {
    const box = stepBottom(on)
    const w = world(on, { answer: (q) => (q.op === 'stop' ? { ok: true, decision: { allowStop: true }, outcome: 'dormant' } : QUEUED) })
    box.usage = tokens(9)
    await step($)
    await $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
    await w.clock.advance(60000)
    expect(w.ops('usage-flush')).toHaveLength(0)
    expect(w.ops('stop')[0].facts.usage).toEqual({ byAgent: { main: counts(9) } })
  })
})

describe('activity-flush', () => {
  test('a delegation and its return: flushed within 2 s each, with the pending list and a journal line', async ($, on) => {
    const w = world(on, { answer: byOp(() => WRITTEN) })
    await $.tool.call({ tool: 'Agent', subagent_type: 'perseveranza:pf-reviewer', description: 'review', prompt: 'p' } as any)
    expect(w.ran).toHaveLength(1)
    await w.clock.advance(1999)
    expect(w.ops('activity-flush')).toHaveLength(0)
    await w.clock.advance(1)
    let f = w.ops('activity-flush')
    expect(f).toHaveLength(1)
    expect(f[0].facts.activity).toMatchObject({ at: 1_000_000, session: 'S1', event: 'delegate', tool: 'Agent', agent: 'perseveranza:pf-reviewer', pending: [{ at: 1_000_000, agent: 'perseveranza:pf-reviewer' }] })
    expect(f[0].facts.journal).toEqual([{ event: 'delegate', agent: 'perseveranza:pf-reviewer', pending: 1 }])
    expect(f[0].event).toEqual({ session_id: 'S1' })
    await $.classic.SubagentStop({ agent_id: 'a1', agent_type: 'perseveranza:pf-reviewer', stop_hook_active: false, cwd: CWD, agent_transcript_path: '' } as any)
    await w.clock.advance(2000)
    f = w.ops('activity-flush')
    expect(f).toHaveLength(2)
    expect(f[1].facts.activity).toMatchObject({ event: 'subagent-stop', agent: 'perseveranza:pf-reviewer', pending: [] })
    expect(f[1].facts.journal).toEqual([{ event: 'subagent-stop', agent: 'perseveranza:pf-reviewer', pending: 0 }])
  })

  test('plain tool calls: one heartbeat for a burst, then at most one every 30 s', async ($, on) => {
    const w = world(on, { answer: byOp(() => WRITTEN) })
    for (let i = 0; i < 5; i++) await $.tool.call({ tool: 'Read', file_path: 'a' + i } as any)
    await w.clock.advance(2000)
    expect(w.ops('activity-flush')).toHaveLength(1)
    expect(w.ops('activity-flush')[0].facts.activity).toMatchObject({ event: 'tool', tool: 'Read' })
    expect(w.ops('activity-flush')[0].facts.journal).toEqual([])
    await $.tool.call({ tool: 'Grep', pattern: 'x' } as any)
    // 30 s after the last flush (which was at +2 s)
    await w.clock.advance(29999)
    expect(w.ops('activity-flush')).toHaveLength(1)
    await w.clock.advance(1)
    expect(w.ops('activity-flush')).toHaveLength(2)
    expect(w.ops('activity-flush')[1].facts.activity.tool).toBe('Grep')
    // a delegation brings a pending heartbeat forward
    await $.tool.call({ tool: 'Read', file_path: 'b' } as any)
    await w.clock.advance(1000)
    await $.tool.call({ tool: 'Agent', subagent_type: 'pf-executor', prompt: 'p' } as any)
    await w.clock.advance(2000)
    expect(w.ops('activity-flush')).toHaveLength(3)
  })

  test('state.json busy: the heartbeat is sent again (5 times at most), lines first', async ($, on) => {
    const w = world(on, { answer: byOp(() => ({ ok: false, error: 'busy', retry: true })) })
    await $.tool.call({ tool: 'Agent', subagent_type: 'pf-executor', prompt: 'p' } as any)
    await w.clock.advance(2000)
    for (let i = 0; i < 10; i++) await w.clock.advance(30000)
    const f = w.ops('activity-flush')
    expect(f).toHaveLength(6)
    for (const q of f) expect(q.facts.journal).toEqual([{ event: 'delegate', agent: 'pf-executor', pending: 1 }])
  })

  for (const [what, answer] of [
    ['dormant', { ok: true, decision: { allowStop: true }, outcome: 'dormant' }],
    ['another session\'s loop', { ok: true, decision: { allowStop: true }, outcome: 'foreign-session' }],
    ['no answer', 'reject'],
  ] as const) {
    test(`${what}: the lines are not sent again`, async ($, on) => {
      let n = 0
      const w = world(on, { answer: byOp(() => (++n === 1 ? answer : WRITTEN)) })
      await $.tool.call({ tool: 'Agent', subagent_type: 'pf-executor', prompt: 'p' } as any)
      await w.clock.advance(2000)
      // the first flush got the answer under test (not a tool-check)
      expect(w.ops('activity-flush')).toHaveLength(1)
      expect(n).toBe(1)
      await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
      await w.clock.advance(60000)
      const f = w.ops('activity-flush')
      expect(f).toHaveLength(2)
      expect(n).toBe(2)
      expect(f[1].facts.journal).toEqual([])
      expect(f[1].facts.activity).toMatchObject({ event: 'tool', tool: 'Bash', pending: [{ agent: 'pf-executor' }] })
    })
  }

  test('no loop folder: nothing flushed, no node process', async ($, on) => {
    const w = world(on, { gate: false, answer: () => WRITTEN })
    await $.tool.call({ tool: 'Agent', subagent_type: 'pf-executor', prompt: 'p' } as any)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
    await w.clock.advance(60000)
    expect(w.reqs).toHaveLength(0)
    expect(w.ran).toHaveLength(2)
  })
})

describe('the delegations not back yet', () => {
  const VERIFY = (lens: string) => ({ tool: 'Agent', subagent_type: 'perseveranza:pf-verifier', description: `verify ${lens}`, prompt: `write .perseveranza/verify-${lens}.json` })
  const STOPPED = (id: string, active = false) => ({ agent_id: id, agent_type: 'perseveranza:pf-verifier', stop_hook_active: active, cwd: CWD, agent_transcript_path: '' })
  const SEND_BACK = { ok: true, decision: { block: 'Write .perseveranza/verify-tests.json' }, check: { ok: false, reason: 'missing' } }
  const LET_GO = { ok: true, decision: { allowStop: true }, check: { ok: true, reason: 'valid' } }

  test('two verifiers side by side: the one still running stays pending, a judge sent back stays pending', async ($, on) => {
    let verdict: any = SEND_BACK
    const w = world(on, { answer: (q) => (q.op === 'tool-check' ? FREE : q.op === 'route-model' ? { ok: true, model: null, outcome: 'no-route' } : q.op === 'subagent-stop' ? verdict : WRITTEN) })
    // two Agent calls (a at +0, b at +1 s), each spawning its verifier
    await $.tool.call(VERIFY('security') as any)
    await w.clock.advance(1000)
    await $.tool.call(VERIFY('tests') as any)
    const [ta, tb] = w.ran.map((e: any) => e.tool_use_id)
    expect(ta).toBeTruthy()
    expect(tb).not.toBe(ta)
    const sa: any = await $.agent.spawn({ tool_use_id: ta, prompt: VERIFY('security').prompt, description: 'verify security', subagentType: 'perseveranza:pf-verifier' } as any)
    const sb: any = await $.agent.spawn({ tool_use_id: tb, prompt: VERIFY('tests').prompt, description: 'verify tests', subagentType: 'perseveranza:pf-verifier' } as any)
    expect(w.spawned.map((e: any) => e.tool_use_id)).toEqual([ta, tb])
    await w.clock.advance(5000)
    // the second verifier (b) stops without its verdict: sent back, both still pending
    const r1: any = await $.classic.SubagentStop(STOPPED(sb.agentId) as any)
    expect(r1.block).toContain('verify-tests.json')
    await w.clock.advance(5000)
    const flushed = w.ops('activity-flush')
    expect(flushed[flushed.length - 1].facts.activity.pending.map((d: any) => d.at)).toEqual([1_000_000, 1_001_000])
    // b writes it and is let go: b's delegation closes, a's (the older one, same name) stays
    verdict = LET_GO
    const r2: any = await $.classic.SubagentStop(STOPPED(sb.agentId, true) as any)
    expect(r2.block).toBeUndefined()
    await w.clock.advance(2000)
    const last = w.ops('activity-flush').pop()!
    expect(last.facts.activity).toMatchObject({ event: 'subagent-stop', agent: 'perseveranza:pf-verifier' })
    expect(last.facts.activity.pending).toEqual([{ at: 1_000_000, agent: 'perseveranza:pf-verifier', id: ta }])
    expect(last.facts.journal).toEqual([{ event: 'subagent-stop', agent: 'perseveranza:pf-verifier', pending: 1 }])
    // a stop seen twice for the same agent closes nothing more
    await $.classic.SubagentStop(STOPPED(sb.agentId, true) as any)
    await w.clock.advance(2000)
    const before = w.ops('activity-flush').length
    await $.tool.call({ tool: 'Read', file_path: 'x' } as any)
    await w.clock.advance(30000)
    expect(w.ops('activity-flush').length).toBeGreaterThan(before)
    expect(w.ops('activity-flush').pop()!.facts.activity.pending).toEqual([{ at: 1_000_000, agent: 'perseveranza:pf-verifier', id: ta }])
    await $.classic.SubagentStop(STOPPED(sa.agentId) as any)
    await w.clock.advance(2000)
    expect(w.ops('activity-flush').pop()!.facts.activity.pending).toEqual([])
  })

  test('the bridge fails at a judge\'s stop and the judge is sent back: its delegation stays open', async ($, on) => {
    const w = world(on, { answer: (q) => (q.op === 'tool-check' ? FREE : q.op === 'subagent-stop' ? 'reject' : q.op === 'journal' ? { ok: true, journaled: 1 } : WRITTEN) })
    await $.tool.call(VERIFY('tests') as any)
    await w.clock.advance(2000)
    const r: any = await $.classic.SubagentStop(STOPPED('x1') as any)
    expect(r.block).toContain('could not be checked')
    await w.clock.advance(60000)
    expect(w.ops('activity-flush').every((q) => q.facts.activity.pending.length === 1)).toBe(true)
    // let go (stop_hook_active): closed
    await $.classic.SubagentStop(STOPPED('x1', true) as any)
    await w.clock.advance(2000)
    expect(w.ops('activity-flush').pop()!.facts.activity.pending).toEqual([])
  })
})

describe('the flushes run one at a time', () => {
  test('an activity flush waits for a token flush still with the bridge', async ($, on) => {
    const box = stepBottom(on)
    let w: any
    w = world(on, {
      answer: async (q) => {
        if (q.op === 'usage-flush') { await w.clock.sleep(3000); return QUEUED }
        return q.op === 'tool-check' ? FREE : WRITTEN
      },
    })
    box.usage = tokens(5)
    await step($)
    await w.clock.advance(15000)
    expect(w.ops('usage-flush')).toHaveLength(1)
    await $.tool.call({ tool: 'Agent', subagent_type: 'pf-executor', prompt: 'p' } as any)
    await w.clock.advance(2000)
    expect(w.ops('activity-flush')).toHaveLength(0)
    await w.clock.advance(1000)
    expect(w.ops('activity-flush')).toHaveLength(1)
  })

  test('a delta given back while newer tokens of the same agent wait: both go with the next flush', async ($, on) => {
    const box = stepBottom(on)
    let w: any
    let n = 0
    w = world(on, {
      answer: async (q) => {
        if (q.op === 'usage-flush' && ++n === 1) { await w.clock.sleep(1000); return { ok: false, error: 'ENOSPC' } }
        return QUEUED
      },
    })
    box.usage = tokens(100)
    await step($)
    await w.clock.advance(15000)
    // while the first flush is with the bridge, main asks again
    box.usage = tokens(1)
    await step($)
    await w.clock.advance(1000)
    await w.clock.advance(15000)
    const f = w.ops('usage-flush')
    expect(f).toHaveLength(2)
    expect(f[1].facts.usage.byAgent).toEqual({ main: counts(101) })
  })
})

describe('a failed gate check (the file system refused)', () => {
  test('the tokens are flushed all the same (the bridge knows)', async ($, on) => {
    const box = stepBottom(on)
    const w = world(on, { gate: 'throw', answer: () => QUEUED })
    box.usage = tokens(5)
    await step($)
    await w.clock.advance(15000)
    expect(w.ops('usage-flush')).toHaveLength(1)
  })

  test('the heartbeat is flushed all the same', async ($, on) => {
    const w = world(on, { gate: 'throw', answer: () => WRITTEN })
    await $.tool.call({ tool: 'Read', file_path: 'a' } as any)
    await w.clock.advance(2000)
    expect(w.ops('activity-flush')).toHaveLength(1)
  })
})
