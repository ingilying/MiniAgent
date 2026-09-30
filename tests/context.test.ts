import type { ModelMessage } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

function catalogResponse(body: unknown, status = 200): typeof globalThis.fetch {
  return async () => new Response(JSON.stringify(body), { status })
}

describe('Context.initRemote', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the context window from the catalog', async () => {
    const lines: string[] = []
    vi.stubGlobal(
      'fetch',
      catalogResponse({
        openai: { models: { 'gpt-6-astra': { limit: { context: 1_050_000 } } } },
      }),
    )
    const context = new Context([], {
      modelId: 'gpt-6-astra',
      env: {},
      catalogUrl: 'https://example.test/context-one',
      onModelLine: (line) => lines.push(line),
    })

    await context.initRemote()

    expect(context.contextWindow).toBe(1_050_000)
    expect(context.remainingTokens).toBe(1_050_000)
    expect(lines).toEqual(['[model] openai/gpt-6-astra: 1,050,000 token context window'])
  })

  it('returns nothing', async () => {
    const context = new Context([], { contextWindow: 1000 })

    await expect(context.initRemote()).resolves.toBeUndefined()
  })

  it('looks the model up under the configured provider', async () => {
    const lines: string[] = []
    vi.stubGlobal(
      'fetch',
      catalogResponse({ xai: { models: { 'grok-4.7': { limit: { context: 256_000 } } } } }),
    )
    const context = new Context([], {
      providerId: 'xai',
      modelId: 'grok-4.7',
      env: {},
      catalogUrl: 'https://example.test/context-provider',
      onModelLine: (line) => lines.push(line),
    })

    await context.initRemote()

    expect(context.contextWindow).toBe(256_000)
    expect(lines[0]).toBe('[model] xai/grok-4.7: 256,000 token context window')
  })

  it('does nothing without a model id', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const context = new Context()

    await context.initRemote()

    expect(context.contextWindow).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps an explicit window and skips the catalog', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const context = new Context([], { modelId: 'gpt-6-astra', contextWindow: 2048 })

    await context.initRemote()

    expect(context.contextWindow).toBe(2048)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('lets MINIAGENT_CONTEXT_WINDOW win over the catalog', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const context = new Context([], {
      modelId: 'gpt-6-astra',
      env: { MINIAGENT_CONTEXT_WINDOW: '4096' },
    })

    await context.initRemote()

    expect(context.contextWindow).toBe(4096)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports an invalid override and falls back to the catalog', async () => {
    const lines: string[] = []
    vi.stubGlobal(
      'fetch',
      catalogResponse({ openai: { models: { 'gpt-6-astra': { limit: { context: 512 } } } } }),
    )
    const context = new Context([], {
      modelId: 'gpt-6-astra',
      env: { MINIAGENT_CONTEXT_WINDOW: 'nope' },
      catalogUrl: 'https://example.test/context-two',
      onModelLine: (line) => lines.push(line),
    })

    await context.initRemote()

    expect(context.contextWindow).toBe(512)
    expect(lines[0]).toBe('[model] ignoring invalid MINIAGENT_CONTEXT_WINDOW="nope"')
  })

  it('stays without a window when the catalog is unavailable', async () => {
    const lines: string[] = []
    vi.stubGlobal('fetch', catalogResponse({ error: 'nope' }, 503))
    const context = new Context([], {
      modelId: 'gpt-6-astra',
      env: {},
      catalogUrl: 'https://example.test/context-three',
      onModelLine: (line) => lines.push(line),
    })

    await context.initRemote()

    expect(context.contextWindow).toBeUndefined()
    expect(lines[0]).toContain('[model] could not read model limits')
  })

  it('reports a model missing from the catalog', async () => {
    const lines: string[] = []
    vi.stubGlobal('fetch', catalogResponse({ openai: { models: {} } }))
    const context = new Context([], {
      modelId: 'gpt-6-astra',
      env: {},
      catalogUrl: 'https://example.test/context-four',
      onModelLine: (line) => lines.push(line),
    })

    await context.initRemote()

    expect(context.contextWindow).toBeUndefined()
    expect(lines[0]).toBe('[model] no context window in catalog for "gpt-6-astra"')
  })

  it('copies the lookup configuration in clone()', async () => {
    const lines: string[] = []
    vi.stubGlobal(
      'fetch',
      catalogResponse({ openai: { models: { 'gpt-6-astra': { limit: { context: 777 } } } } }),
    )
    const original = new Context([], {
      modelId: 'gpt-6-astra',
      env: {},
      catalogUrl: 'https://example.test/context-five',
      onModelLine: (line) => lines.push(line),
    })

    const copy = original.clone()
    await copy.initRemote()

    expect(copy.contextWindow).toBe(777)
    expect(lines).toHaveLength(1)
  })
})
