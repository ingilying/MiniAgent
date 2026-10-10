import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'

import { Agent } from '../src/agent.js'
import { AgentsManager } from '../src/agents.js'
import { Context } from '../src/context.js'

function testAgent(session: Context): Agent {
  return new Agent({ model: new MockLanguageModelV4({}), context: session })
}

describe('AgentsManager', () => {
  it('stores and returns agents by session id', () => {
    const manager = new AgentsManager()
    const first = new Context().addUser('one')
    const second = new Context().addUser('two')
    const one = testAgent(first)
    const two = testAgent(second)

    expect(manager.get(first.id)).toBeUndefined()
    manager.set(first, one)
    manager.set(second, two)

    expect(manager.get(first.id)).toBe(one)
    expect(manager.get(second.id)).toBe(two)
    expect(manager.has(first.id)).toBe(true)
    expect(manager.ids()).toEqual(expect.arrayContaining([first.id, second.id]))
  })

  it('replaces the registration on set', () => {
    const manager = new AgentsManager()
    const session = new Context()

    manager.set(session, testAgent(session))
    const replacement = testAgent(session)
    manager.set(session, replacement)

    expect(manager.get(session.id)).toBe(replacement)
  })

  it('drops registrations on release', () => {
    const manager = new AgentsManager()
    const session = new Context()
    manager.set(session, testAgent(session))

    expect(manager.release(session.id)).toBe(true)
    expect(manager.has(session.id)).toBe(false)
    expect(manager.release(session.id)).toBe(false)

    manager.set(session, testAgent(session))
    manager.releaseAll()
    expect(manager.ids()).toEqual([])
  })
})
