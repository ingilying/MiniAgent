import type { ModelMessage } from 'ai'
import { describe, expect, it } from 'vitest'

import { Context } from '../src/context.js'

describe('Context', () => {
  it('starts empty or with initial messages', () => {
    expect(new Context().messageCount).toBe(0)

    const context = new Context([{ role: 'user', content: 'hi' }])

    expect(context.messageCount).toBe(1)
    expect(context.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('adds user and assistant messages fluently', () => {
    const context = new Context().addUser('hi').addAssistant('hello')

    expect(context.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('appends message arrays', () => {
    const context = new Context().addUser('hi')

    context.append([{ role: 'assistant', content: 'hello' }])

    expect(context.messageCount).toBe(2)
  })

  it('returns snapshots that cannot mutate the history', () => {
    const context = new Context().addUser('hi')

    const snapshot = context.messages as ModelMessage[]
    snapshot.push({ role: 'user', content: 'extra' })

    expect(context.messageCount).toBe(1)
  })

  it('clears the history', () => {
    const context = new Context().addUser('hi').addAssistant('hello')

    context.clear()

    expect(context.messageCount).toBe(0)
    expect(context.messages).toEqual([])
  })

  it('clones independently', () => {
    const original = new Context().addUser('hi')

    const copy = original.clone()
    copy.addUser('more')

    expect(original.messageCount).toBe(1)
    expect(copy.messageCount).toBe(2)
  })

  it('generates an id when none is given', () => {
    const first = new Context()
    const second = new Context()

    expect(first.id).not.toHaveLength(0)
    expect(first.id).not.toBe(second.id)
  })

  it('keeps an explicit id', () => {
    expect(new Context([], { id: 'session-1' }).id).toBe('session-1')
  })
})

describe('Context token counting', () => {
  it('is zero until a response is recorded', () => {
    const context = new Context().addUser('hello')

    expect(context.tokenCount).toBe(0)
    expect(context.usage).toBeUndefined()
  })

  it('uses the provider-reported usage of the last response', () => {
    const context = new Context().addUser('hello')

    context.recordUsage({ inputTokens: 500, outputTokens: 40 })

    expect(context.usage).toEqual({
      inputTokens: 500,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(context.tokenCount).toBe(540)
  })

  it('keeps the cache numbers reported by the provider', () => {
    const context = new Context().addUser('hello')

    context.recordUsage({
      inputTokens: 130,
      outputTokens: 5,
      inputTokenDetails: {
        noCacheTokens: 30,
        cacheReadTokens: 100,
        cacheWriteTokens: 7,
      },
    })

    expect(context.usage).toEqual({
      inputTokens: 130,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheWriteTokens: 7,
    })
    // cached tokens are already inside inputTokens, so not added again
    expect(context.tokenCount).toBe(135)
  })

  it('replaces the count with the next reported usage', () => {
    const context = new Context().addUser('hello')
    context.recordUsage({ inputTokens: 100, outputTokens: 10 })
    context.addUser('another question')
    context.addAssistant('another answer')

    context.recordUsage({ inputTokens: 250, outputTokens: 30 })

    expect(context.tokenCount).toBe(280)
  })

  it('does not count messages that have not been sent yet', () => {
    const context = new Context().addUser('hello')
    context.recordUsage({ inputTokens: 100, outputTokens: 10 })

    context.addUser('a question that has not been sent yet')

    expect(context.tokenCount).toBe(110)
  })

  it('ignores usage without an input token count', () => {
    const context = new Context().addUser('hello')

    context.recordUsage({ inputTokens: undefined, outputTokens: 10 })

    expect(context.tokenCount).toBe(0)
    expect(context.usage).toBeUndefined()
  })

  it('reports remaining tokens against a configured context window', () => {
    const context = new Context([], { contextWindow: 1000 })

    expect(context.remainingTokens).toBe(1000)

    context.recordUsage({ inputTokens: 400, outputTokens: 100 })

    expect(context.remainingTokens).toBe(500)
  })

  it('has no remaining tokens without a context window', () => {
    const context = new Context().addUser('hi')

    expect(context.remainingTokens).toBeUndefined()
  })

  it('copies usage in clone()', () => {
    const context = new Context().addUser('hello')
    context.recordUsage({ inputTokens: 100, outputTokens: 10 })

    const copy = context.clone()

    expect(copy.tokenCount).toBe(110)
    expect(copy.usage).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('has usage without input token details', () => {
    const context = new Context().addUser('hello')

    context.recordUsage({ inputTokens: 20, outputTokens: 4, inputTokenDetails: undefined })

    expect(context.usage).toEqual({
      inputTokens: 20,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })
})
