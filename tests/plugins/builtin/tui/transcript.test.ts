import { describe, expect, it } from 'vitest'

import type { AgentEvent } from '../../../../src/agent/agent.js'
import {
  applyEvent,
  applyNotice,
  applyUser,
  emptyTranscript,
  initialTranscript,
} from '../../../../src/plugins/builtin/tui/transcript.js'

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

  it('appends command output as system rows', () => {
    const makeId = ids()
    let state = emptyTranscript()
    state = applyUser(state, makeId(), '/help')
    state = applyNotice(state, makeId(), 'Available commands:')

    expect(state.lines.map((line) => line.kind)).toEqual(['user', 'system'])
    expect(state.lines[1]?.text).toBe('Available commands:')
  })
})
