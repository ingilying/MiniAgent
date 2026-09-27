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
})
