import { describe, expect, it } from 'vitest'

import type { AgentEvent } from '../src/agent.js'
import type { Context } from '../src/context.js'
import {
  applyEvent,
  applyUser,
  contextUsage,
  emptyTranscript,
  initialTranscript,
} from '../src/plugins/tui/driver.js'

function ids(): () => string {
  let count = 0
  return () => `id-${(count += 1)}`
}

function event(type: AgentEvent['type'], extra = {}): AgentEvent {
  return { type, ...extra } as AgentEvent
}

describe('TUI transcript', () => {
  it('accumulates streaming text as live text until finish', () => {
    const makeId = ids()
    let state = emptyTranscript()
    state = applyEvent(state, event('text-delta', { text: 'Hello' }), makeId)
    state = applyEvent(state, event('text-delta', { text: ' world' }), makeId)

    expect(state.liveText).toBe('Hello world')
    expect(state.lines).toEqual([])

    state = applyEvent(state, event('finish', { finishReason: 'stop', usage: undefined }), makeId)

    expect(state.liveText).toBe('')
    expect(state.lines).toEqual([{ id: 'id-1', kind: 'assistant', text: 'Hello world' }])
  })

  it('flushes live text before tool and error rows', () => {
    const makeId = ids()
    let state = emptyTranscript()
    state = applyEvent(state, event('text-delta', { text: 'Working' }), makeId)
    state = applyEvent(
      state,
      event('tool-call', { toolCallId: 'c1', toolName: 'read', input: { path: 'a.txt' } }),
      makeId,
    )
    state = applyEvent(
      state,
      event('tool-result', { toolCallId: 'c1', toolName: 'read', output: 'contents' }),
      makeId,
    )
    state = applyEvent(state, event('error', { error: new Error('boom') }), makeId)

    expect(state.liveText).toBe('')
    expect(state.lines.map((line) => line.kind)).toEqual(['assistant', 'tool', 'tool', 'error'])
    expect(state.lines[0]?.text).toBe('Working')
    expect(state.lines[1]?.text).toContain('read')
    expect(state.lines[3]?.text).toBe('boom')
  })

  it('ignores step boundary events', () => {
    const makeId = ids()
    let state = emptyTranscript()
    state = applyEvent(state, event('start'), makeId)
    state = applyEvent(state, event('step-start', { stepNumber: 0 }), makeId)
    state = applyEvent(
      state,
      event('step-finish', { stepNumber: 0, finishReason: 'stop', usage: undefined }),
      makeId,
    )

    expect(state).toEqual(emptyTranscript())
  })

  it('adds user turns and drops empty live text', () => {
    const makeId = ids()
    const state = applyUser(emptyTranscript(), makeId(), 'What is 6 * 7?')

    expect(state.liveText).toBe('')
    expect(state.lines).toEqual([{ id: 'id-1', kind: 'user', text: 'What is 6 * 7?' }])
  })

  it('pins the banner rows above later turns', () => {
    const makeId = ids()
    let state = initialTranscript(makeId, 'ART', 'openai/model · /tmp')

    expect(state.lines.map((line) => line.kind)).toEqual(['art', 'welcome'])
    expect(state.lines[1]?.text).toBe('openai/model · /tmp')

    state = applyUser(state, makeId(), 'hello')
    state = applyEvent(state, event('error', { error: new Error('boom') }), makeId)

    expect(state.lines.map((line) => line.kind)).toEqual(['art', 'welcome', 'user', 'error'])
  })

  it('summarizes context usage', () => {
    const context = (tokenCount: number, contextWindow?: number): Context =>
      ({ tokenCount, contextWindow }) as Context

    expect(contextUsage(context(0))).toBe('context —')
    expect(contextUsage(context(950))).toBe('context 950')
    expect(contextUsage(context(1500, 128000))).toBe('context 1.5k / 128.0k (1%)')
    expect(contextUsage(context(64000, 128000))).toBe('context 64.0k / 128.0k (50%)')
  })
})
