import { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import pino from 'pino'

import { resolveContextWindow } from '../../src/models/context-window.js'
import { Context } from '../../src/session/context.js'

function sink(): { stream: NodeJS.WritableStream; text: () => string } {
  let buffer = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += String(chunk)
      callback()
    },
  })
  return { stream, text: () => buffer }
}

/** Logged texts: diagnostics leave as JSON lines, so read the msg field. */
function messages(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { msg: string }).msg)
}

function catalogResponse(body: unknown, status = 200): typeof globalThis.fetch {
  return async () => new Response(JSON.stringify(body), { status })
}

describe('resolveContextWindow', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the context window from the catalog', async () => {
    const out = sink()
    vi.stubGlobal(
      'fetch',
      catalogResponse({
        openai: { models: { 'gpt-6-astra': { limit: { context: 1_050_000 } } } },
      }),
    )
    const context = new Context([], { modelId: 'gpt-6-astra' })

    await resolveContextWindow(context, {
      env: {},
      catalogUrl: 'https://example.test/context-one',
      logger: pino({ level: 'info', base: undefined }, out.stream),
    })

    expect(context.contextWindow).toBe(1_050_000)
    expect(context.remainingTokens).toBe(1_050_000)
    expect(messages(out.text())).toEqual(['openai/gpt-6-astra: 1,050,000 token context window'])
  })

  it('returns nothing', async () => {
    const context = new Context([], { contextWindow: 1000 })

    await expect(resolveContextWindow(context)).resolves.toBeUndefined()
  })

  it('looks the model up under the configured provider', async () => {
    const out = sink()
    vi.stubGlobal(
      'fetch',
      catalogResponse({ xai: { models: { 'grok-4.7': { limit: { context: 256_000 } } } } }),
    )
    const context = new Context([], { providerId: 'xai', modelId: 'grok-4.7' })

    await resolveContextWindow(context, {
      env: {},
      catalogUrl: 'https://example.test/context-provider',
      logger: pino({ level: 'info', base: undefined }, out.stream),
    })

    expect(context.contextWindow).toBe(256_000)
    expect(messages(out.text())[0]).toBe('xai/grok-4.7: 256,000 token context window')
  })

  it('does nothing without a model id', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const context = new Context()

    await resolveContextWindow(context)

    expect(context.contextWindow).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps an explicit window and skips the catalog', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const context = new Context([], { modelId: 'gpt-6-astra', contextWindow: 2048 })

    await resolveContextWindow(context)

    expect(context.contextWindow).toBe(2048)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('lets MINIAGENT_CONTEXT_WINDOW win over the catalog', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const context = new Context([], { modelId: 'gpt-6-astra' })

    await resolveContextWindow(context, { env: { MINIAGENT_CONTEXT_WINDOW: '4096' } })

    expect(context.contextWindow).toBe(4096)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports an invalid override and falls back to the catalog', async () => {
    const out = sink()
    vi.stubGlobal(
      'fetch',
      catalogResponse({ openai: { models: { 'gpt-6-astra': { limit: { context: 512 } } } } }),
    )
    const context = new Context([], { modelId: 'gpt-6-astra' })

    await resolveContextWindow(context, {
      env: { MINIAGENT_CONTEXT_WINDOW: 'nope' },
      catalogUrl: 'https://example.test/context-two',
      logger: pino({ level: 'info', base: undefined }, out.stream),
    })

    expect(context.contextWindow).toBe(512)
    expect(messages(out.text())[0]).toBe('ignoring invalid MINIAGENT_CONTEXT_WINDOW="nope"')
  })

  it('stays without a window when the catalog is unavailable', async () => {
    const out = sink()
    vi.stubGlobal('fetch', catalogResponse({ error: 'nope' }, 503))
    const context = new Context([], { modelId: 'gpt-6-astra' })

    await resolveContextWindow(context, {
      env: {},
      catalogUrl: 'https://example.test/context-three',
      logger: pino({ level: 'info', base: undefined }, out.stream),
    })

    expect(context.contextWindow).toBeUndefined()
    expect(messages(out.text())[0]).toContain('could not read model limits')
  })

  it('reports a model missing from the catalog', async () => {
    const out = sink()
    vi.stubGlobal('fetch', catalogResponse({ openai: { models: {} } }))
    const context = new Context([], { modelId: 'gpt-6-astra' })

    await resolveContextWindow(context, {
      env: {},
      catalogUrl: 'https://example.test/context-four',
      logger: pino({ level: 'info', base: undefined }, out.stream),
    })

    expect(context.contextWindow).toBeUndefined()
    expect(messages(out.text())[0]).toBe('no context window in catalog for "gpt-6-astra"')
  })

  it('resolves the window on a clone with explicit options', async () => {
    const out = sink()
    vi.stubGlobal(
      'fetch',
      catalogResponse({ openai: { models: { 'gpt-6-astra': { limit: { context: 777 } } } } }),
    )
    const original = new Context([], { modelId: 'gpt-6-astra' })

    const copy = original.clone()
    await resolveContextWindow(copy, {
      env: {},
      catalogUrl: 'https://example.test/context-five',
      logger: pino({ level: 'info', base: undefined }, out.stream),
    })

    expect(copy.contextWindow).toBe(777)
    expect(messages(out.text())).toHaveLength(1)
  })
})
