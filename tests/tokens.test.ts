import { describe, expect, it } from 'vitest'

import { Context } from '../src/context.js'
import { MESSAGE_OVERHEAD_TOKENS, countMessagesTokens, countTextTokens } from '../src/tokens.js'

describe('countTextTokens', () => {
  it('is zero for empty text and deterministic otherwise', () => {
    expect(countTextTokens('')).toBe(0)
    expect(countTextTokens('hello world')).toBe(countTextTokens('hello world'))
  })

  it('grows with the amount of text', () => {
    const short = countTextTokens('hello')
    const long = countTextTokens('hello, this is a considerably longer sentence')

    expect(long).toBeGreaterThan(short)
  })

  it('handles non-ASCII text', () => {
    expect(countTextTokens('안녕하세요')).toBeGreaterThan(0)
  })
})

describe('countMessagesTokens', () => {
  it('is zero for an empty history', () => {
    expect(countMessagesTokens([])).toBe(0)
  })

  it('includes per-message framing overhead', () => {
    const tokens = countMessagesTokens([{ role: 'user', content: '' }])

    expect(tokens).toBeGreaterThanOrEqual(MESSAGE_OVERHEAD_TOKENS)
  })

  it('counts tool calls and tool results', () => {
    const plain = countMessagesTokens([{ role: 'user', content: 'hi' }])
    const withTool = countMessagesTokens([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'calculator',
            input: { expression: '17 * 23' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'calculator',
            output: { type: 'json', value: { result: 391 } },
          },
        ],
      },
    ])

    expect(withTool).toBeGreaterThan(plain)
  })
})

describe('Context token counting', () => {
  it('tracks the size of the history', () => {
    const context = new Context()
    expect(context.tokenCount).toBe(0)

    context.addUser('hello')
    const afterFirst = context.tokenCount
    expect(afterFirst).toBeGreaterThan(0)

    context.addAssistant('hi there, how can I help you today?')
    expect(context.tokenCount).toBeGreaterThan(afterFirst)
  })

  it('reports usage against a configured context window', () => {
    const context = new Context([{ role: 'user', content: 'hello' }], {
      contextWindow: 1000,
    })

    expect(context.tokenCount).toBeGreaterThan(0)
    expect(context.remainingTokens).toBe(1000 - context.tokenCount)
    expect(context.usageRatio).toBeCloseTo(context.tokenCount / 1000)
  })

  it('has no window usage without a context window', () => {
    const context = new Context().addUser('hi')

    expect(context.remainingTokens).toBeUndefined()
    expect(context.usageRatio).toBeUndefined()
  })

  it('supports a custom token counter', () => {
    const context = new Context([], {
      tokenCounter: (messages) => messages.length * 100,
    })

    context.addUser('hello')
    expect(context.tokenCount).toBe(100)

    context.addUser('again')
    expect(context.tokenCount).toBe(200)
  })
})
