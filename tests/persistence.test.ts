import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Agent, type AgentEvent } from '../src/agent.js'
import { Context } from '../src/context.js'
import { FileContextStore } from '../src/store.js'

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

type MockOptions = NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>
type MockStreamResult = Extract<NonNullable<MockOptions['doStream']>, { stream: unknown }>
type StreamPart = MockStreamResult['stream'] extends ReadableStream<infer Part> ? Part : never

function textStream(text: string): MockStreamResult {
  return {
    stream: simulateReadableStream<StreamPart>({
      chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: text },
        { type: 'text-end', id: 'text-1' },
        { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
      ],
    }),
  }
}

async function collectEvents(agent: Agent, context: Context): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of agent.stream(context)) {
    events.push(event)
  }
  return events
}

describe('FileContextStore', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'miniagent-context-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('round-trips a snapshot', async () => {
    const store = new FileContextStore(directory)
    const snapshot = {
      messages: [{ role: 'user' as const, content: 'hello' }],
      usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 8, cacheWriteTokens: 2 },
    }

    await store.save('session-1', snapshot)

    expect(await store.load('session-1')).toEqual(snapshot)
  })

  it('reads legacy files that hold a bare message array', async () => {
    const store = new FileContextStore(directory)
    const messages = [{ role: 'user' as const, content: 'hello' }]
    await writeFile(join(directory, 'legacy.json'), JSON.stringify(messages), 'utf8')

    expect(await store.load('legacy')).toEqual({ messages })
  })

  it('returns undefined for unknown ids', async () => {
    const store = new FileContextStore(directory)

    expect(await store.load('missing')).toBeUndefined()
  })

  it('deletes stored snapshots', async () => {
    const store = new FileContextStore(directory)
    await store.save('session-1', { messages: [{ role: 'user', content: 'hi' }] })

    await store.delete('session-1')

    expect(await store.load('session-1')).toBeUndefined()
  })

  it('keeps unsafe ids inside the store directory', async () => {
    const store = new FileContextStore(directory)
    const id = '../escape/attempt'

    await store.save(id, { messages: [{ role: 'user', content: 'hi' }] })

    const files = await readdir(directory)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/\.json$/)
    expect((await store.load(id))?.messages).toHaveLength(1)
  })
})

describe('Context persistence', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'miniagent-context-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('throws when saving an unbound context', async () => {
    const context = new Context().addUser('hello')

    await expect(context.save()).rejects.toThrow(/not bound/)
  })

  it('saves and reloads under a generated id', async () => {
    const store = new FileContextStore(directory)
    const context = new Context([], { store }).addUser('hello')

    await context.save()

    const restored = await Context.load(store, context.id)
    expect(restored.messages).toEqual(context.messages)
  })

  it('loads a stored history into a bound context', async () => {
    const store = new FileContextStore(directory)
    const original = new Context([], { store, id: 'session-1' })
      .addUser('hello')
      .addAssistant('hi!')
    await original.save()

    const restored = await Context.load(store, 'session-1')

    expect(restored.messages).toEqual(original.messages)
    expect(restored.id).toBe('session-1')

    restored.addUser('another turn')
    await restored.save()

    const reloaded = await Context.load(store, 'session-1')
    expect(reloaded.messageCount).toBe(3)
  })

  it('persists the usage reported by the provider', async () => {
    const store = new FileContextStore(directory)
    const context = new Context([], { store, id: 'session-1' }).addUser('hello')
    context.recordUsage({
      inputTokens: 123,
      outputTokens: 45,
      inputTokenDetails: {
        noCacheTokens: 23,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
      },
    })

    await context.save()

    const restored = await Context.load(store, 'session-1')
    expect(restored.usage).toEqual({
      inputTokens: 123,
      outputTokens: 45,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    })
    expect(restored.tokenCount).toBe(168)
  })

  it('loads older usage without cache numbers', async () => {
    const store = new FileContextStore(directory)
    const snapshot = {
      messages: [{ role: 'user' as const, content: 'hello' }],
      usage: { inputTokens: 40, outputTokens: 4 },
    }
    await writeFile(join(directory, 'old.json'), JSON.stringify(snapshot), 'utf8')

    const restored = await Context.load(store, 'old')

    expect(restored.usage).toEqual({
      inputTokens: 40,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(restored.tokenCount).toBe(44)
  })

  it('persists the provider and model of the session', async () => {
    const store = new FileContextStore(directory)
    const context = new Context([], {
      store,
      id: 'session-1',
      providerId: 'openai',
      modelId: 'gpt-6-astra',
    }).addUser('hello')

    await context.save()

    expect(await store.load('session-1')).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-6-astra',
    })

    // the stored pair wins over what the caller passes
    const restored = await Context.load(store, 'session-1', {
      providerId: 'other',
      modelId: 'other-model',
    })
    expect(restored.providerId).toBe('openai')
    expect(restored.modelId).toBe('gpt-6-astra')
  })

  it('falls back to the passed provider and model for legacy files', async () => {
    const store = new FileContextStore(directory)
    await writeFile(
      join(directory, 'legacy.json'),
      JSON.stringify([{ role: 'user', content: 'hello' }]),
      'utf8',
    )

    const restored = await Context.load(store, 'legacy', {
      providerId: 'openai',
      modelId: 'gpt-6-astra',
    })

    expect(restored.providerId).toBe('openai')
    expect(restored.modelId).toBe('gpt-6-astra')
  })

  it('defaults the provider to openai', () => {
    expect(new Context().providerId).toBe('openai')
  })

  it('auto-saves the history and usage after an agent run', async () => {
    const store = new FileContextStore(directory)
    const model = new MockLanguageModelV4({
      doStream: textStream('Hello there!'),
    })

    const context = await Context.load(store, 'session-1', { contextWindow: 1000 })
    context.addUser('hi')

    const events = await collectEvents(new Agent({ model }), context)
    expect(events.at(-1)?.type).toBe('finish')
    expect(context.messages.map((message) => message.role)).toEqual(['user', 'assistant'])

    // the history and the reported usage were persisted automatically
    const restored = await Context.load(store, 'session-1')
    expect(restored.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(restored.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(restored.tokenCount).toBe(15)
  })

  it('does not auto-save when autoSave is disabled', async () => {
    const store = new FileContextStore(directory)
    const model = new MockLanguageModelV4({
      doStream: textStream('Hello there!'),
    })

    const context = await Context.load(store, 'session-1', { autoSave: false })
    context.addUser('hi')

    await collectEvents(new Agent({ model }), context)

    expect(context.messageCount).toBe(2)
    expect(await store.load('session-1')).toBeUndefined()
  })
})
