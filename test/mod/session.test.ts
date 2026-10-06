// session.start (the Claude Code version) and classic.SessionStart (the notice of a loop this
// session does not own).
import { expect, test, describe } from 'claude-code/testing'
import { world, CWD } from './world.ts'

describe('session.start', () => {
  test('a supported version: a mod-start line in the journal of an armed loop, nothing under the prompt', async ($, on) => {
    const w = world(on, { answer: () => ({ ok: true, journaled: 1 }) })
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false } as any)
    const [q] = w.ops('journal')
    expect(q.facts.lines).toEqual([{ type: 'mod-start', claudeCode: '2.1.289', ok: true, min: '2.1.287', problem: '' }])
    expect(w.statuses).toHaveLength(0)
    // once per process: a stop of the same loop does not send it again
    await $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
    expect(w.ops('journal')).toHaveLength(1)
  })

  for (const [what, version, claudeCode] of [
    ['an older version', { version: '2.1.200', base: '2.1.200' }, '2.1.200'],
    ['an unreadable version', { version: 'nightly' }, 'nightly'],
    ['no version at all', null, 'unknown'],
  ] as const) {
    test(`${what}: said under the prompt and in the journal, the session goes on`, async ($, on) => {
      const w = world(on, { version, answer: () => ({ ok: true, journaled: 1 }) })
      const r: any = await $.session.start({ cwd: CWD, surface: null, isInteractive: false } as any)
      expect(r.cwd).toBe(CWD)
      const line = w.ops('journal')[0].facts.lines[0]
      expect(line).toMatchObject({ type: 'mod-start', claudeCode, ok: false, min: '2.1.287' })
      expect(line.problem.length).toBeGreaterThan(0)
      expect(w.statuses[0]).toContain(`Claude Code ${claudeCode}`)
    })
  }

  test('a newer version is supported', async ($, on) => {
    const w = world(on, { version: { version: '2.2.0-dev.20261101', base: '2.2.0-dev' }, answer: () => ({ ok: true, journaled: 1 }) })
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false } as any)
    expect(w.ops('journal')[0].facts.lines[0]).toMatchObject({ claudeCode: '2.2.0-dev', ok: true })
  })

  test('no loop folder: no bridge call; the first stop of a loop armed later sends the line', async ($, on) => {
    let gate = false
    const w = world(on, { gate: () => gate, answer: (q) => (q.op === 'stop' ? { ok: true, decision: { block: 'PHASE: plan' }, outcome: 'no-plan' } : { ok: true, journaled: 1 }) })
    await $.session.start({ cwd: CWD, surface: null, isInteractive: false } as any)
    expect(w.reqs).toHaveLength(0)
    gate = true
    await $.classic.Stop({ stop_hook_active: false, cwd: CWD } as any)
    expect(w.reqs.map((q) => q.op)).toEqual(['stop', 'journal'])
    expect(w.ops('journal')[0].facts.lines[0].type).toBe('mod-start')
  })
})

describe('classic.SessionStart', () => {
  const START = { source: 'startup', cwd: CWD, session_id: 'S2', transcript_path: 'C:/t.jsonl' }

  test('a loop this session does not own: the notice as additional context', async ($, on) => {
    const w = world(on, { answer: () => ({ ok: true, context: 'perseveranza: a loop in this project is driven by another session' }) })
    const r: any = await $.classic.SessionStart(START as any)
    expect(r.additionalContext).toEqual(['perseveranza: a loop in this project is driven by another session'])
    expect(w.ops('session-start')[0].event).toMatchObject({ source: 'startup', session_id: 'S2' })
  })

  test('the settings hooks beneath keep their context', async ($, on) => {
    world(on, { sessionStartBottom: { additionalContext: ['from a settings hook'] }, answer: () => ({ ok: true, context: 'loop notice' }) })
    const r: any = await $.classic.SessionStart(START as any)
    expect(r.additionalContext).toEqual(['from a settings hook', 'loop notice'])
  })

  test('nothing to say: no additional context', async ($, on) => {
    world(on, { answer: () => ({ ok: true, context: null }) })
    const r: any = await $.classic.SessionStart(START as any)
    expect(r.additionalContext).toBeUndefined()
  })

  test('no loop folder: no bridge call', async ($, on) => {
    const w = world(on, { gate: false, answer: () => ({ ok: true, context: 'x' }) })
    const r: any = await $.classic.SessionStart(START as any)
    expect(w.reqs).toHaveLength(0)
    expect(r.additionalContext).toBeUndefined()
  })

  test('the bridge fails: fail-open (no notice), journaled', async ($, on) => {
    const w = world(on, { answer: (q) => (q.op === 'session-start' ? 'reject' : { ok: true, journaled: 1 }) })
    const r: any = await $.classic.SessionStart(START as any)
    expect(r.additionalContext).toBeUndefined()
    expect(w.ops('journal')[0].facts.lines[0]).toMatchObject({ type: 'mod-hook-skipped', hook: 'classic.SessionStart' })
  })

  test('the transcript of the session goes with the heartbeat', async ($, on) => {
    const w = world(on, { answer: (q) => (q.op === 'session-start' ? { ok: true, context: null } : { ok: true, outcome: 'activity' }) })
    await $.classic.SessionStart(START as any)
    await $.tool.call({ tool: 'Read', file_path: 'a' } as any)
    await w.clock.advance(2000)
    expect(w.ops('activity-flush')[0].facts.activity.transcript).toBe('C:/t.jsonl')
  })
})
