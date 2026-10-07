// agent.spawn (model routing), classic.SubagentStop (the judges' verdicts), tool.call (the
// reconciliation guard): what the mod does with each bridge answer, and when it fails.
import { expect, test, describe } from 'claude-code/testing'
import { world, CWD } from './world.ts'

const ROUTED = (model: string) => ({ ok: true, model, outcome: 'routed' })
const SPAWN = { tool_use_id: 'tu1', prompt: 'review step one', description: 'review', subagentType: 'perseveranza:pf-reviewer', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-haiku', background: false, fork: false, model: 'opus' }

describe('agent.spawn', () => {
  test('a pf-* subagent spawns on the routed model, asked of the bridge with its type, the asked model and the session', async ($, on) => {
    const w = world(on, { answer: () => ROUTED('haiku') })
    const r: any = await $.agent.spawn(SPAWN as any)
    expect(w.spawned[0].model).toBe('haiku')
    expect(r.model).toBe('haiku')
    const [q] = w.ops('route-model')
    expect(q.event).toEqual({ subagentType: 'perseveranza:pf-reviewer', model: 'opus', session_id: 'S1' })
    expect(q.cwd).toBe(CWD)
  })

  test('any other subagent, or a fork: no bridge call, the model stays', async ($, on) => {
    const w = world(on, { answer: () => ROUTED('haiku') })
    await $.agent.spawn({ ...SPAWN, subagentType: 'general-purpose' } as any)
    await $.agent.spawn({ ...SPAWN, fork: true } as any)
    expect(w.reqs).toHaveLength(0)
    expect(w.spawned.map((e: any) => e.model)).toEqual(['opus', 'opus'])
  })

  test('no route (no loop, another session, the advisor): the model stays', async ($, on) => {
    const w = world(on, { answer: () => ({ ok: true, model: null, outcome: 'dormant' }) })
    await $.agent.spawn(SPAWN as any)
    expect(w.spawned[0].model).toBe('opus')
  })

  test('no loop folder: no bridge call', async ($, on) => {
    const w = world(on, { gate: false, answer: () => ROUTED('haiku') })
    await $.agent.spawn(SPAWN as any)
    expect(w.reqs).toHaveLength(0)
    expect(w.spawned[0].model).toBe('opus')
  })

  for (const [what, answer] of [['no answer', 'reject'], ['ok: false', { ok: false, error: 'boom' }]] as const) {
    test(`${what}: fail-open (the spawn goes on with its model) and journaled as mod-hook-skipped, three times at most`, async ($, on) => {
      const w = world(on, { answer: (q) => (q.op === 'route-model' ? answer : { ok: true, journaled: 1 }) })
      for (let i = 0; i < 5; i++) await $.agent.spawn(SPAWN as any)
      expect(w.spawned).toHaveLength(5)
      expect(w.spawned.every((e: any) => e.model === 'opus')).toBe(true)
      const skips = w.ops('journal').map((q) => q.facts.lines[0])
      expect(skips).toHaveLength(3)
      expect(skips[0]).toMatchObject({ type: 'mod-hook-skipped', hook: 'agent.spawn', count: 1 })
      expect(w.logs.length).toBe(5)
    })
  }
})

describe('classic.SubagentStop', () => {
  const JUDGE = { agent_id: 'r1', agent_type: 'perseveranza:pf-reviewer', stop_hook_active: false, cwd: CWD, agent_transcript_path: '' }
  const SEND_BACK = { ok: true, decision: { block: 'Write .perseveranza/review.json with requestId R-1' }, check: { ok: false, reason: 'missing' } }

  test('a judge without its verdict is sent back, at most twice; the asks are counted for the bridge', async ($, on) => {
    const w = world(on, { answer: (q) => (q.op === 'subagent-stop' ? SEND_BACK : { ok: true }) })
    const r1: any = await $.classic.SubagentStop(JUDGE as any)
    expect(r1.block).toContain('review.json')
    const r2: any = await $.classic.SubagentStop({ ...JUDGE, stop_hook_active: true } as any)
    expect(r2.block).toContain('review.json')
    const r3: any = await $.classic.SubagentStop({ ...JUDGE, stop_hook_active: true } as any)
    expect(r3.block).toBeUndefined()
    const q = w.ops('subagent-stop')
    expect(q.map((x) => x.facts.askedTimes)).toEqual([0, 1])
    expect(q[0].event.agent_type).toBe('perseveranza:pf-reviewer')
    // another judge has its own count
    const r4: any = await $.classic.SubagentStop({ ...JUDGE, agent_id: 'r2' } as any)
    expect(r4.block).toContain('review.json')
  })

  test('the verdict is there: the judge goes', async ($, on) => {
    world(on, { answer: () => ({ ok: true, decision: { allowStop: true }, check: { ok: true, reason: 'valid' } }) })
    const r: any = await $.classic.SubagentStop(JUDGE as any)
    expect(r.block).toBeUndefined()
  })

  test('not a judge: no bridge call, only the heartbeat', async ($, on) => {
    const w = world(on, { answer: () => SEND_BACK })
    const r: any = await $.classic.SubagentStop({ ...JUDGE, agent_type: 'perseveranza:pf-executor' } as any)
    expect(r.block).toBeUndefined()
    expect(w.ops('subagent-stop')).toHaveLength(0)
    await w.clock.advance(2000)
    expect(w.ops('activity-flush')).toHaveLength(1)
  })

  test('a verifier spawned with one lens file in its prompt: the lens goes to the check', async ($, on) => {
    const w = world(on, { answer: (q) => (q.op === 'route-model' ? ROUTED('opus') : SEND_BACK) })
    await $.agent.spawn({ ...SPAWN, subagentType: 'perseveranza:pf-verifier', prompt: 'lens security: write .perseveranza/verify-security.json' } as any)
    await $.agent.spawn({ ...SPAWN, subagentType: 'perseveranza:pf-verifier', prompt: 'write verify-security.json or verify-tests.json' } as any)
    await $.classic.SubagentStop({ ...JUDGE, agent_id: 'agent-1', agent_type: 'perseveranza:pf-verifier' } as any)
    await $.classic.SubagentStop({ ...JUDGE, agent_id: 'agent-2', agent_type: 'perseveranza:pf-verifier' } as any)
    const q = w.ops('subagent-stop')
    expect(q[0].facts).toEqual({ askedTimes: 0, lens: 'security' })
    expect(q[1].facts).toEqual({ askedTimes: 0 })
  })

  for (const [what, answer] of [['no answer', 'reject'], ['ok: false', { ok: false, error: 'boom' }], ['not JSON', 'Traceback']] as const) {
    test(`${what}: the judge is sent back once to make sure of its file; never with stop_hook_active, never past the cap`, async ($, on) => {
      const w = world(on, { answer: (q) => (q.op === 'subagent-stop' ? answer : { ok: true, journaled: 1 }) })
      const r1: any = await $.classic.SubagentStop(JUDGE as any)
      expect(r1.block).toContain('could not be checked')
      expect(w.ops('journal').map((q) => q.facts.lines[0])).toContainEqual(expect.objectContaining({ type: 'mod-hook-skipped', hook: 'classic.SubagentStop' }))
      const r2: any = await $.classic.SubagentStop({ ...JUDGE, stop_hook_active: true } as any)
      expect(r2.block).toBeUndefined()
      const r3: any = await $.classic.SubagentStop({ ...JUDGE, agent_id: 'r9' } as any)
      expect(r3.block).toContain('could not be checked')
      const r4: any = await $.classic.SubagentStop({ ...JUDGE, agent_id: 'r9' } as any)
      expect(r4.block).toContain('could not be checked')
      const r5: any = await $.classic.SubagentStop({ ...JUDGE, agent_id: 'r9' } as any)
      expect(r5.block).toBeUndefined()
    })
  }

  test('the bridge fails in a project without a loop folder: the judge goes', async ($, on) => {
    world(on, { gate: 'throw', answer: () => 'reject' })
    const r: any = await $.classic.SubagentStop(JUDGE as any)
    expect(r.block).toBeUndefined()
  })
})

describe('tool.call', () => {
  test('a reconciling loop refuses a tool that would mutate: denied, not run, not counted as life', async ($, on) => {
    const w = world(on, { answer: (q) => (q.op === 'tool-check' ? { ok: true, deny: 'perseveranza: reconciling', outcome: 'refused' } : { ok: true }) })
    const r: any = await $.tool.call({ tool: 'Edit', file_path: 'a.js', old_string: 'a', new_string: 'b' } as any)
    expect(w.ran).toHaveLength(0)
    expect(JSON.stringify(r)).toContain('reconciling')
    const [q] = w.ops('tool-check')
    expect(q.event).toEqual({ session_id: 'S1', tool: 'Edit', input: { file_path: 'a.js', old_string: 'a', new_string: 'b' } })
    await w.clock.advance(60000)
    expect(w.ops('activity-flush')).toHaveLength(0)
  })

  test('allowed: the tool runs', async ($, on) => {
    const w = world(on, { answer: (q) => (q.op === 'tool-check' ? { ok: true, deny: null, outcome: 'free' } : { ok: true, outcome: 'activity' }) })
    await $.tool.call({ tool: 'Bash', command: 'git status' } as any)
    expect(w.ran).toHaveLength(1)
  })

  test('a tool that cannot mutate is never checked', async ($, on) => {
    const w = world(on, { answer: () => ({ ok: true, deny: 'no', outcome: 'refused' }) })
    for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch']) await $.tool.call({ tool, file_path: 'a' } as any)
    expect(w.ops('tool-check')).toHaveLength(0)
    expect(w.ran).toHaveLength(4)
  })

  test('no loop folder: no bridge call, the tool runs', async ($, on) => {
    const w = world(on, { gate: false, answer: () => ({ ok: true, deny: 'no' }) })
    await $.tool.call({ tool: 'Write', file_path: 'a', content: 'x' } as any)
    expect(w.reqs).toHaveLength(0)
    expect(w.ran).toHaveLength(1)
  })

  test('the bridge fails: fail-open (the tool runs), journaled', async ($, on) => {
    const w = world(on, { answer: (q) => (q.op === 'tool-check' ? 'reject' : { ok: true, journaled: 1 }) })
    await $.tool.call({ tool: 'Write', file_path: 'a', content: 'x' } as any)
    expect(w.ran).toHaveLength(1)
    expect(w.ops('journal')[0].facts.lines[0]).toMatchObject({ type: 'mod-hook-skipped', hook: 'tool.call' })
  })
})

// The guard reads state.json itself ($.fs.read): a node process only when the loop is being
// reconciled (signals.interrupted), or when the state cannot say it is not (the bridge decides).
describe('tool.call: a node process only when the guard may refuse', () => {
  const STATE = (signals: any = {}) => JSON.stringify({ schemaVersion: 2, phase: 'implement', owner: { sessionId: 'S1' }, signals: { lastReport: 'none', claimedDone: false, paused: false, resumedAt: 0, interrupted: null, ...signals } })
  const INTERRUPTED = { at: '2026-10-07T06:00:00.000Z', silentMs: 900000, phase: 'implement', pending: [] }
  const REFUSE = (q: any) => (q.op === 'tool-check' ? { ok: true, deny: 'perseveranza: reconciling', outcome: 'refused' } : { ok: true, outcome: 'activity' })

  test('a loop not being reconciled: no process for any mutating tool, every tool runs', async ($, on) => {
    const w = world(on, { stateText: STATE(), answer: REFUSE })
    for (const tool of ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task']) await $.tool.call({ tool, command: 'x' } as any)
    expect(w.reqs).toHaveLength(0)
    expect(w.ran).toHaveLength(8)
    expect(w.reads.filter((p) => p.endsWith('/.perseveranza/state.json'))).toHaveLength(8)
  })

  test('a typical turn (40 Edit/Write/Bash calls in 2 minutes): only the debounced heartbeats start node', async ($, on) => {
    const w = world(on, { stateText: STATE(), answer: REFUSE })
    for (let i = 0; i < 40; i++) {
      await $.tool.call({ tool: ['Edit', 'Write', 'Bash', 'Read'][i % 4], command: 'x', file_path: 'a.js' } as any)
      await w.clock.advance(3000)
    }
    await w.clock.advance(31000)
    expect(w.ops('tool-check')).toHaveLength(0)
    // one heartbeat per ACTIVITY_HEARTBEAT_MS (30 s) at most: 120 s of calls + the tail
    expect(w.reqs.length).toBeLessThanOrEqual(5)
    expect(w.reqs.every((q) => q.op === 'activity-flush')).toBe(true)
    expect(w.ran).toHaveLength(40)
  })

  test('a loop being reconciled (signals.interrupted): the bridge is asked, and refuses', async ($, on) => {
    const w = world(on, { stateText: STATE({ interrupted: INTERRUPTED }), answer: REFUSE })
    const r: any = await $.tool.call({ tool: 'Write', file_path: 'a', content: 'x' } as any)
    expect(w.ops('tool-check')).toHaveLength(1)
    expect(w.ran).toHaveLength(0)
    expect(JSON.stringify(r)).toContain('reconciling')
  })

  // what the bridge's normalizeState reads as an interruption: any object, an array too
  for (const [name, interrupted] of [['an array', []], ['an empty object', {}]] as const) {
    test(`signals.interrupted as ${name}: asked`, async ($, on) => {
      const w = world(on, { stateText: STATE({ interrupted }), answer: REFUSE })
      await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
      expect(w.ops('tool-check')).toHaveLength(1)
    })
  }
  for (const [name, interrupted] of [['true', true], ['a string', 'yes'], ['0', 0], ['absent', undefined]] as const) {
    test(`signals.interrupted ${name} (no interruption to the bridge either): not asked`, async ($, on) => {
      const w = world(on, { stateText: STATE({ interrupted }), answer: REFUSE })
      await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
      expect(w.ops('tool-check')).toHaveLength(0)
      expect(w.ran).toHaveLength(1)
    })
  }

  // the state cannot say: the bridge decides, with its retries (the 3.0.1 behaviour)
  for (const [name, text] of [['truncated', STATE().slice(0, 40)], ['empty', ''], ['not a state (no phase)', JSON.stringify({ owner: { sessionId: 'S1' } })], ['an array', '[]'], ['null', 'null']] as const) {
    test(`state.json ${name}: asked`, async ($, on) => {
      const w = world(on, { stateText: text, answer: REFUSE })
      await $.tool.call({ tool: 'Edit', file_path: 'a', old_string: 'a', new_string: 'b' } as any)
      expect(w.ops('tool-check')).toHaveLength(1)
      expect(w.ran).toHaveLength(0)
    })
  }

  test('state.json unreadable, or only its pending copy there: asked', async ($, on) => {
    const w = world(on, { files: ['state.json.pending'], answer: REFUSE })
    await $.tool.call({ tool: 'Edit', file_path: 'a', old_string: 'a', new_string: 'b' } as any)
    expect(w.ops('tool-check')).toHaveLength(1)
    expect(w.ran).toHaveLength(0)
  })

  test('the reconciliation starts mid-session: the next call reads it (nothing is cached)', async ($, on) => {
    let text = STATE()
    const w = world(on, { stateText: () => text, answer: REFUSE })
    await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
    expect(w.ops('tool-check')).toHaveLength(0)
    text = STATE({ interrupted: INTERRUPTED })
    await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
    expect(w.ops('tool-check')).toHaveLength(1)
    expect(w.ran).toHaveLength(1)
  })
})

describe('what each hook does when the gate check itself fails', () => {
  test('tool.call: the guard still asks the bridge (it knows whether a loop is reconciling)', async ($, on) => {
    const w = world(on, { gate: 'throw', answer: (q) => (q.op === 'tool-check' ? { ok: true, deny: 'perseveranza: reconciling', outcome: 'refused' } : { ok: true }) })
    await $.tool.call({ tool: 'Write', file_path: 'a', content: 'x' } as any)
    expect(w.ops('tool-check')).toHaveLength(1)
    expect(w.ran).toHaveLength(0)
  })

  test('classic.SubagentStop: the judge is still checked', async ($, on) => {
    const w = world(on, { gate: 'throw', answer: () => ({ ok: true, decision: { block: 'Write review.json' } }) })
    const r: any = await $.classic.SubagentStop({ agent_id: 'r1', agent_type: 'perseveranza:pf-reviewer', stop_hook_active: false, cwd: CWD, agent_transcript_path: '' } as any)
    expect(w.ops('subagent-stop')).toHaveLength(1)
    expect(r.block).toBe('Write review.json')
  })

  test('classic.SessionStart: no notice, no node process (a session with no loop is never told of one)', async ($, on) => {
    const w = world(on, { gate: 'throw', answer: () => ({ ok: true, context: 'a loop' }) })
    const r: any = await $.classic.SessionStart({ source: 'startup', cwd: CWD, session_id: 'S2', transcript_path: '' } as any)
    expect(w.reqs).toHaveLength(0)
    expect(r.additionalContext).toBeUndefined()
  })
})

describe('tool.call: the tools the guard asks for', () => {
  for (const tool of ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task']) {
    test(`${tool} is checked`, async ($, on) => {
      const w = world(on, { answer: (q) => (q.op === 'tool-check' ? { ok: true, deny: 'perseveranza: reconciling', outcome: 'refused' } : { ok: true }) })
      await $.tool.call({ tool, command: 'x' } as any)
      expect(w.ops('tool-check').map((q) => q.event.tool)).toEqual([tool])
      expect(w.ran).toHaveLength(0)
    })
  }

  test('the tool input goes without the call\'s own fields (agentId, tool_use_id)', async ($, on) => {
    const w = world(on, { answer: () => ({ ok: true, deny: null, outcome: 'free' }) })
    await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'agent-7' } as any)
    expect(w.ops('tool-check')[0].event.input).toEqual({ command: 'ls' })
  })
})
