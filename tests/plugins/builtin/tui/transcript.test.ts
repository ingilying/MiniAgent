import { describe, expect, it } from 'vitest'

import type { ModelMessage } from 'ai'

import type { AgentEvent } from '../../../../src/agent/agent.js'
import {
  appendHistory,
  applyEvent,
  applyNotice,
  applyUser,
  emptyTranscript,
  initialTranscript,
  type TranscriptLine,
  type TranscriptState,
} from '../../../../src/plugins/builtin/tui/transcript.js'

function ids(): () => string {
  let count = 0
  return () => `id-${(count += 1)}`
}

function event(type: AgentEvent['type'], extra = {}): AgentEvent {
  return { type, ...extra } as AgentEvent
}

function kinds(state: TranscriptState): Array<TranscriptLine['kind']> {
  return state.lines.map((line) => line.kind)
}

/** Text of a row, or the output of a tool row, for readable assertions. */
function textOf(line: TranscriptLine | undefined): unknown {
  if (line === undefined) {
    return undefined
  }
  return line.kind === 'tool' ? line.output : 'text' in line ? line.text : undefined
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
    expect(kinds(state)).toEqual(['assistant'])
    expect(textOf(state.lines[0])).toBe('Hello world')
  })

  it('keeps reasoning live until the answer starts, then flushes it first', () => {
    const makeId = ids()
    let state = emptyTranscript()
    state = applyEvent(state, event('reasoning-delta', { text: 'weigh ' }), makeId)
    state = applyEvent(state, event('reasoning-delta', { text: 'options' }), makeId)

    expect(state.liveReasoning).toBe('weigh options')
    expect(state.lines).toEqual([])

    state = applyEvent(state, event('text-delta', { text: 'Answer' }), makeId)
    state = applyEvent(state, event('finish', { finishReason: 'stop', usage: undefined }), makeId)

    expect(kinds(state)).toEqual(['reasoning', 'assistant'])
    expect(textOf(state.lines[0])).toBe('weigh options')
    expect(textOf(state.lines[1])).toBe('Answer')
    expect(state.liveReasoning).toBe('')
  })

  it('shows a tool call as pending until its result pairs it into one row', () => {
    const makeId = ids()
    let state = emptyTranscript()
    state = applyEvent(
      state,
      event('tool-call', { toolCallId: 'c1', toolName: 'read', input: { path: 'a.txt' } }),
      makeId,
    )

    expect(state.liveTools).toEqual([
      { toolCallId: 'c1', toolName: 'read', input: { path: 'a.txt' } },
    ])
    expect(state.lines).toEqual([])

    state = applyEvent(
      state,
      event('tool-result', { toolCallId: 'c1', toolName: 'read', output: 'contents' }),
      makeId,
    )

    expect(state.liveTools).toEqual([])
    expect(kinds(state)).toEqual(['tool'])
    expect(state.lines[0]).toMatchObject({
      toolName: 'read',
      input: { path: 'a.txt' },
      output: 'contents',
      isError: false,
    })
  })

  it('marks a failed tool call', () => {
    const makeId = ids()
    let state = emptyTranscript()
    state = applyEvent(
      state,
      event('tool-call', { toolCallId: 'c1', toolName: 'shell', input: { command: 'false' } }),
      makeId,
    )
    state = applyEvent(
      state,
      event('tool-result', {
        toolCallId: 'c1',
        toolName: 'shell',
        output: new Error('exit 1'),
        isError: true,
      }),
      makeId,
    )

    expect(state.lines[0]).toMatchObject({ kind: 'tool', isError: true })
  })

  it('keeps a result whose call was never seen', () => {
    const makeId = ids()
    const state = applyEvent(
      emptyTranscript(),
      event('tool-result', { toolCallId: 'c9', toolName: 'read', output: 'late' }),
      makeId,
    )

    expect(kinds(state)).toEqual(['tool'])
    expect(state.lines[0]).toMatchObject({ input: undefined, output: 'late' })
  })

  it('flushes live text before a tool row', () => {
    const makeId = ids()
    let state = emptyTranscript()
    state = applyEvent(state, event('text-delta', { text: 'Working' }), makeId)
    state = applyEvent(
      state,
      event('tool-call', { toolCallId: 'c1', toolName: 'read', input: { path: 'a' } }),
      makeId,
    )
    state = applyEvent(
      state,
      event('tool-result', { toolCallId: 'c1', toolName: 'read', output: 'ok' }),
      makeId,
    )

    expect(kinds(state)).toEqual(['assistant', 'tool'])
    expect(textOf(state.lines[0])).toBe('Working')
  })

  it('flushes live phases and drops pending tools on error', () => {
    const makeId = ids()
    let state = emptyTranscript()
    state = applyEvent(state, event('reasoning-delta', { text: 'thinking' }), makeId)
    state = applyEvent(state, event('text-delta', { text: 'Working' }), makeId)
    state = applyEvent(
      state,
      event('tool-call', { toolCallId: 'c1', toolName: 'read', input: {} }),
      makeId,
    )
    state = applyEvent(state, event('error', { error: new Error('boom') }), makeId)

    expect(kinds(state)).toEqual(['reasoning', 'assistant', 'error'])
    expect(textOf(state.lines[2])).toBe('boom')
    expect(state.liveText).toBe('')
    expect(state.liveReasoning).toBe('')
    expect(state.liveTools).toEqual([])
  })

  it('never leaves a pending tool call after finish', () => {
    const makeId = ids()
    let state = applyEvent(
      emptyTranscript(),
      event('tool-call', { toolCallId: 'c1', toolName: 'read', input: {} }),
      makeId,
    )
    state = applyEvent(
      state,
      event('finish', { finishReason: 'tool-calls', usage: undefined }),
      makeId,
    )

    expect(state.liveTools).toEqual([])
    expect(state.lines).toEqual([])
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

  it('adds user turns and flushes a running answer above them', () => {
    const makeId = ids()
    let state = applyEvent(emptyTranscript(), event('text-delta', { text: 'partial' }), makeId)
    state = applyUser(state, makeId, 'What is 6 * 7?')

    expect(state.liveText).toBe('')
    expect(kinds(state)).toEqual(['assistant', 'user'])
    expect(textOf(state.lines[1])).toBe('What is 6 * 7?')
  })

  it('pins the banner rows above later turns', () => {
    const makeId = ids()
    let state = initialTranscript(makeId, 'ART', 'openai/model · /tmp')

    expect(kinds(state)).toEqual(['art', 'welcome'])
    expect(textOf(state.lines[1])).toBe('openai/model · /tmp')

    state = applyUser(state, makeId, 'hello')
    state = applyEvent(state, event('error', { error: new Error('boom') }), makeId)

    expect(kinds(state)).toEqual(['art', 'welcome', 'user', 'error'])
  })

  it('replays stored messages, pairing tool calls with results', () => {
    const makeId = ids()
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: { path: 'a' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'read',
            output: { type: 'json', value: { lines: 2 } },
          },
        ],
      },
      { role: 'assistant', content: 'done' },
    ]

    const state = appendHistory(emptyTranscript(), messages, makeId)

    expect(kinds(state)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(state.lines[2]).toMatchObject({
      kind: 'tool',
      toolName: 'read',
      input: { path: 'a' },
      output: { lines: 2 },
      isError: false,
      spaced: true,
    })
  })

  it('appends command output as system rows', () => {
    const makeId = ids()
    let state = applyUser(emptyTranscript(), makeId, '/help')
    state = applyNotice(state, makeId, 'Available commands:')

    expect(kinds(state)).toEqual(['user', 'system'])
    expect(textOf(state.lines[1])).toBe('Available commands:')
  })
})
