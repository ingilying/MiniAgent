import { mkdtemp, readdir, rm } from 'node:fs/promises'
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

  it('round-trips messages', async () => {
    const store = new FileContextStore(directory)
    const messages = [{ role: 'user' as const, content: 'hello' }]

    await store.save('session-1', messages)

    expect(await store.load('session-1')).toEqual(messages)
  })

  it('returns undefined for unknown ids', async () => {
    const store = new FileContextStore(directory)

    expect(await store.load('missing')).toBeUndefined()
  })

  it('deletes stored messages', async () => {
    const store = new FileContextStore(directory)
    await store.save('session-1', [{ role: 'user', content: 'hi' }])

    await store.delete('session-1')

    expect(await store.load('session-1')).toBeUndefined()
  })

  it('keeps unsafe ids inside the store directory', async () => {
    const store = new FileContextStore(directory)
    const id = '../escape/attempt'

    await store.save(id, [{ role: 'user', content: 'hi' }])

    const files = await readdir(directory)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/\.json$/)
    expect(await store.load(id)).toHaveLength(1)
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

  it('loads a stored history into a bound context', async () => {
    const store = new FileContextStore(directory)
    const original = new Context().addUser('hello').addAssistant('hi!')
    await store.save('session-1', original.messages)

    const restored = await Context.load(store, 'session-1')

    expect(restored.messages).toEqual(original.messages)
    expect(restored.id).toBe('session-1')

    restored.addUser('another turn')
    await restored.save()

    const reloaded = await Context.load(store, 'session-1')
    expect(reloaded.messageCount).toBe(3)
  })

  it('auto-saves the history after an agent run', async () => {
    const store = new FileContextStore(directory)
    const model = new MockLanguageModelV4({
      doStream: textStream('Hello there!'),
    })

    const context = await Context.load(store, 'session-1', { contextWindow: 1000 })
    context.addUser('hi')

    const events = await collectEvents(new Agent({ model }), context)
    expect(events.at(-1)?.type).toBe('finish')
    expect(context.messages.map((message) => message.role)).toEqual(['user', 'assistant'])

    // the history was persisted automatically — a restart sees it
    const restored = await Context.load(store, 'session-1')
    expect(restored.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(restored.tokenCount).toBe(context.tokenCount)
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
