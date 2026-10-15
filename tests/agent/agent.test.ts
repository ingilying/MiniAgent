import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Agent, type AgentEvent, type AgentOutputEvent } from '../../src/agent/agent.js'
import { Context } from '../../src/session/context.js'
import pino from 'pino'
import { createBasicTools } from '../../src/plugins/builtin/basic-tools/tools.js'

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'miniagent-agent-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function collectEvents(agent: Agent, input: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of agent.stream(input)) {
    events.push(event)
  }
  return events
}

function textOf(events: AgentEvent[]): string {
  return events
    .filter((event) => event.type === 'text-delta')
    .map((event) => event.text)
    .join('')
}

describe('Agent', () => {
  it('streams text deltas until finish', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Hello, ' },
            { type: 'text-delta', id: 'text-1', delta: 'world!' },
            { type: 'text-end', id: 'text-1' },
            { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
          ],
        }),
      }),
    })

    const events = await collectEvents(new Agent({ model }), 'hi')

    expect(events[0]?.type).toBe('start')
    expect(textOf(events)).toBe('Hello, world!')
    expect(events.at(-1)?.type).toBe('finish')
  })

  it('executes tools between streamed steps', async () => {
    const file = join(directory, 'note.txt')
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'write',
                input: JSON.stringify({ path: file, content: 'hello' }),
              },
              { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: undefined } },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'Wrote it.' },
              { type: 'text-end', id: 'text-1' },
              { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
            ],
          }),
        },
      ],
    })

    const agent = new Agent({
      model,
      tools: { write: createBasicTools(directory).write! },
      maxSteps: 4,
    })
    const events = await collectEvents(agent, 'write hello to a note')

    expect(events.find((event) => event.type === 'tool-call')).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'write',
      input: { path: file, content: 'hello' },
    })
    expect(events.find((event) => event.type === 'tool-result')).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'write',
      output: { path: file, bytes: 5 },
    })
    expect(textOf(events)).toBe('Wrote it.')
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('runs tool calls to completion via run()', async () => {
    const file = join(directory, 'note.txt')
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'write',
                input: JSON.stringify({ path: file, content: 'hello' }),
              },
              { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: undefined } },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'Wrote it.' },
              { type: 'text-end', id: 'text-1' },
              { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
            ],
          }),
        },
      ],
    })

    const agent = new Agent({ model, tools: { write: createBasicTools(directory).write! } })
    const result = await agent.run('write hello to a note')

    expect(result.text).toBe('Wrote it.')
    expect(result.toolResults[0]).toMatchObject({
      toolName: 'write',
      output: { path: file, bytes: 5 },
    })
    // Ephemeral run, no context: messages are discarded.
    expect(result.responseMessages).toHaveLength(0)
    expect(model.doStreamCalls).toHaveLength(2)
  })
})

describe('Agent with Context', () => {
  it('saves the conversation history across streamed runs', async () => {
    const file = join(directory, 'note.txt')
    const model = new MockLanguageModelV4({
      doStream: [
        // turn 1, step 1: tool call
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'write',
                input: JSON.stringify({ path: file, content: 'hello' }),
              },
              { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: undefined } },
            ],
          }),
        },
        // turn 1, step 2: final answer
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'Wrote it.' },
              { type: 'text-end', id: 'text-1' },
              { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
            ],
          }),
        },
        // turn 2: plain answer
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'You are welcome!' },
              { type: 'text-end', id: 'text-1' },
              { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
            ],
          }),
        },
      ],
    })

    const context = new Context()
    const agent = new Agent({
      model,
      tools: { write: createBasicTools(directory).write! },
      context,
    })

    await collectEvents(agent, 'write hello to a note')

    // user + assistant (tool call) + tool result + assistant (answer)
    expect(context.messageCount).toBe(4)
    expect(context.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])

    await collectEvents(agent, 'thanks')

    expect(context.messageCount).toBe(6)
    // the second turn was sent with the full conversation history (5 messages)
    expect(model.doStreamCalls[2]?.prompt.length).toBe(5)
  })

  it('records the token usage reported by the model', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Hello!' },
            { type: 'text-end', id: 'text-1' },
            { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
          ],
        }),
      }),
    })

    const context = new Context().addUser('hi')

    await collectEvents(new Agent({ model, context }), 'hi')

    expect(context.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(context.tokenCount).toBe(15)
  })

  it('keeps the cache numbers the model reports', async () => {
    const cachedUsage = {
      inputTokens: { total: 130, noCache: 30, cacheRead: 100, cacheWrite: 4 },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    }

    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Hello!' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              usage: cachedUsage,
              finishReason: { unified: 'stop', raw: undefined },
            },
          ],
        }),
      }),
    })

    const context = new Context().addUser('hi')

    await collectEvents(new Agent({ model, context }), 'hi')

    expect(context.usage).toEqual({
      inputTokens: 130,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheWriteTokens: 4,
    })
    expect(context.tokenCount).toBe(135)
  })

  it('run() also saves the history', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Hello!' },
            { type: 'text-end', id: 'text-1' },
            { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
          ],
        }),
      }),
    })

    const context = new Context()
    const agent = new Agent({ model, context })

    await agent.run('hi')

    expect(context.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  })

  it('logs run boundaries at debug level', async () => {
    let buffer = ''
    const output = new Writable({
      write(chunk, _encoding, callback) {
        buffer += String(chunk)
        callback()
      },
    })
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Hello!' },
            { type: 'text-end', id: 'text-1' },
            { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
          ],
        }),
      }),
    })
    const context = new Context()
    const agent = new Agent({
      model,
      context,
      logger: pino({ level: 'debug', base: undefined }, output),
    })

    await agent.run('hi')

    expect(buffer).toContain(`${context.id} run started (1 in history)`)
    expect(buffer).toContain(`${context.id} run finished (1 steps)`)
  })

  it('streams on the member context with an explicit input', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Hello!' },
            { type: 'text-end', id: 'text-1' },
            { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
          ],
        }),
      }),
    })
    const context = new Context().addUser('hi')
    const agent = new Agent({ model, context })

    const events: AgentEvent[] = []
    for await (const event of agent.stream('next')) {
      events.push(event)
    }

    expect(agent.context).toBe(context)
    expect(textOf(events)).toBe('Hello!')
    expect(context.messages.map((message) => message.role)).toEqual(['user', 'user', 'assistant'])
  })

  it('adds a string input to the member context', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Hello!' },
            { type: 'text-end', id: 'text-1' },
            { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
          ],
        }),
      }),
    })
    const context = new Context().addUser('earlier')
    const agent = new Agent({ model, context })

    await agent.run('next question')

    expect(context.messages.map((message) => message.role)).toEqual(['user', 'user', 'assistant'])
    expect(context.messages.slice(0, 2).map((message) => message.content)).toEqual([
      'earlier',
      'next question',
    ])
  })
})

describe('Agent submit/subscribe', () => {
  function queuedModel(): { model: MockLanguageModelV4; order: string[] } {
    const order: string[] = []
    let calls = 0
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1
        const mine = calls
        order.push(`start-${mine}`)
        if (mine === 1) {
          await delay(20)
        }
        order.push(`end-${mine}`)
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: `answer-${mine}` },
              { type: 'text-end', id: 'text-1' },
              { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
            ],
          }),
        }
      },
    })
    return { model, order }
  }

  it('runs a submitted input at once when idle', async () => {
    const { model } = queuedModel()
    const agent = new Agent({ model })

    const handle = agent.submit('hi')

    expect(typeof handle.id).toBe('string')
    expect(handle.id).not.toHaveLength(0)
    expect(agent.isRunning).toBe(true)
    await expect(handle.done).resolves.toMatchObject({ text: 'answer-1' })
    expect(agent.isRunning).toBe(false)
  })

  it('queues inputs behind the running one in submit order', async () => {
    const { model, order } = queuedModel()
    const agent = new Agent({ model })

    const first = agent.submit('one')
    const second = agent.submit('two')

    expect(first.id).not.toBe(second.id)
    const [one, two] = await Promise.all([first.done, second.done])

    expect(one.text).toBe('answer-1')
    expect(two.text).toBe('answer-2')
    expect(one.error).toBeUndefined()
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2'])
  })

  it('fans every run out to one global listener tagged by run id', async () => {
    const { model } = queuedModel()
    const agent = new Agent({ model })
    const seen: AgentOutputEvent[] = []
    const unsubscribe = agent.subscribe((event) => {
      seen.push(event)
    })

    const first = agent.submit('one')
    const second = agent.submit('two')
    await Promise.all([first.done, second.done])
    unsubscribe()
    agent.submit('three')
    await new Promise((resolve) => setTimeout(resolve, 30))

    const ids = new Set(seen.map((event) => event.runId))
    expect(ids).toEqual(new Set([first.id, second.id]))
    for (const id of [first.id, second.id]) {
      const types = seen.filter((event) => event.runId === id).map((event) => event.type)
      expect(types[0]).toBe('start')
      expect(types.at(-1)).toBe('finish')
    }
  })

  it('isolates failures with an error event and a result-with-error', async () => {
    let calls = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1
        if (calls === 1) {
          throw new Error('model exploded')
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'recovered' },
              { type: 'text-end', id: 'text-1' },
              { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
            ],
          }),
        }
      },
    })
    const agent = new Agent({ model })
    const errors: AgentOutputEvent[] = []
    agent.subscribe((event) => {
      if (event.type === 'error') {
        errors.push(event)
      }
    })

    const broken = agent.submit('boom')
    const next = agent.submit('again')
    const [first, second] = await Promise.all([broken.done, next.done])

    expect(first.error).toBeInstanceOf(Error)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.runId).toBe(broken.id)
    expect(second.text).toBe('recovered')
    expect(second.error).toBeUndefined()
    expect(agent.isRunning).toBe(false)
  })
})

describe('Agent single-flight', () => {
  function textModel(text: string): MockLanguageModelV4 {
    return new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: text },
            { type: 'text-end', id: 'text-1' },
            { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
          ],
        }),
      }),
    })
  }

  it('reports running status while a run executes', async () => {
    const agent = new Agent({ model: textModel('hi') })

    expect(agent.isRunning).toBe(false)
    const pending = agent.run('hi')
    expect(agent.isRunning).toBe(true)
    await pending
    expect(agent.isRunning).toBe(false)
  })

  it('serializes concurrent runs instead of interleaving them', async () => {
    const order: string[] = []
    let calls = 0
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1
        const mine = calls
        order.push(`start-${mine}`)
        if (mine === 1) {
          await delay(20)
        }
        order.push(`end-${mine}`)
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: `answer-${mine}` },
              { type: 'text-end', id: 'text-1' },
              { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
            ],
          }),
        }
      },
    })
    const agent = new Agent({ model })

    const [first, second] = await Promise.all([agent.run('one'), agent.run('two')])

    expect(first.text).toBe('answer-1')
    expect(second.text).toBe('answer-2')
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2'])
  })

  it('drops the pre-added user message when run() fails', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('model exploded')
      },
    })
    const context = new Context()
    const agent = new Agent({ model, context })

    await expect(agent.run('boom')).rejects.toThrow('model exploded')

    expect(context.messageCount).toBe(0)
    expect(agent.isRunning).toBe(false)
  })

  it('cancels the run and leaves no orphan when the consumer breaks out of stream()', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Hello!' },
            { type: 'text-end', id: 'text-1' },
            { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
          ],
        }),
      }),
    })
    const context = new Context().addUser('earlier')
    const agent = new Agent({ model, context })

    // Breaking cancels the run. Either nothing lands (the common case) or a
    // complete run lands; what must never happen is a stuck lock or a
    // half-added turn.
    for await (const event of agent.stream('next')) {
      expect(event.type).toBe('start')
      break
    }

    expect(agent.isRunning).toBe(false)
    expect(context.messages[0]).toMatchObject({ role: 'user', content: 'earlier' })
    const added = context.messages.filter(
      (message) => message.role === 'user' && message.content === 'next',
    )
    expect(added.length).toBeLessThanOrEqual(1)
    // No assistant reply without its user message, and no user message
    // without either a reply or a rollback.
    expect(context.messageCount).toBeLessThanOrEqual(3)
  })
})

describe('Agent run mode', () => {
  function textGenerate(text: string): MockLanguageModelV4 {
    return new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      }),
    })
  }

  it('completes a submitted run via generateText', async () => {
    const agent = new Agent({ model: textGenerate('Hello!'), mode: 'run' })

    const result = await agent.submit('hi').done

    expect(result.error).toBeUndefined()
    expect(result.text).toBe('Hello!')
    expect(result.finishReason).toBe('stop')
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(5)
  })

  it('executes tools between generate steps', async () => {
    const file = join(directory, 'note.txt')
    let calls = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls += 1
        if (calls === 1) {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'write',
                input: JSON.stringify({ path: file, content: 'hello' }),
              },
            ],
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage,
            warnings: [],
          }
        }
        return {
          content: [{ type: 'text', text: 'Wrote it.' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage,
          warnings: [],
        }
      },
    })

    const agent = new Agent({
      model,
      mode: 'run',
      tools: { write: createBasicTools(directory).write! },
    })
    const result = await agent.run('write hello to a note')

    expect(result.text).toBe('Wrote it.')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolResults).toHaveLength(1)
    expect(result.toolResults[0]).toMatchObject({
      toolName: 'write',
      output: { path: file, bytes: 5 },
    })
  })

  it('throws the failure out of run()', async () => {
    const agent = new Agent({
      model: new MockLanguageModelV4({
        doGenerate: async () => {
          throw new Error('model exploded')
        },
      }),
      mode: 'run',
    })

    await expect(agent.run('boom')).rejects.toThrow('model exploded')
    expect(agent.isRunning).toBe(false)
  })

  it('rolls a failed run back and keeps the queue moving', async () => {
    let calls = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls += 1
        if (calls === 1) {
          throw new Error('model exploded')
        }
        return {
          content: [{ type: 'text', text: 'recovered' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage,
          warnings: [],
        }
      },
    })
    const context = new Context()
    const agent = new Agent({ model, mode: 'run', context })

    const broken = agent.submit('boom')
    const next = agent.submit('again')
    const [first, second] = await Promise.all([broken.done, next.done])

    expect(first.error).toBeInstanceOf(Error)
    expect(second.error).toBeUndefined()
    expect(second.text).toBe('recovered')
    // The failed run's user message was rolled back: only the second
    // run's user message plus its reply remain.
    expect(context.messageCount).toBe(2)
    expect(agent.isRunning).toBe(false)
  })

  it('rolls the context back when a run is cancelled mid-flight', async () => {
    const context = new Context().addUser('earlier')
    const model = new MockLanguageModelV4({
      doGenerate: (options) =>
        new Promise<never>((_resolve, reject) => {
          const signal = options.abortSignal
          if (signal?.aborted === true) {
            reject(signal.reason ?? new Error('Run aborted before it started.'))
            return
          }
          signal?.addEventListener(
            'abort',
            () => {
              reject(signal.reason ?? new Error('Run aborted.'))
            },
            { once: true },
          )
        }),
    })
    const agent = new Agent({ model, mode: 'run', context })
    const controller = new AbortController()

    const handle = agent.submit('next', { abortSignal: controller.signal })
    setTimeout(() => controller.abort(new Error('stop it')), 10)
    const result = await handle.done
    // Let the pump finalize the run: done resolves before finishActive.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result.error).toBeDefined()
    expect(context.messageCount).toBe(1)
    expect(context.messages[0]).toMatchObject({ role: 'user', content: 'earlier' })
    expect(agent.isRunning).toBe(false)
  })

  it('replays events to subscribers', async () => {
    const agent = new Agent({ model: textGenerate('Hello!'), mode: 'run' })
    const seen: AgentOutputEvent[] = []
    const unsubscribe = agent.subscribe((event) => {
      seen.push(event)
    })

    const handle = agent.submit('hi')
    const result = await handle.done
    unsubscribe()

    expect(result.error).toBeUndefined()
    const types = seen.filter((event) => event.runId === handle.id).map((event) => event.type)
    expect(types[0]).toBe('start')
    expect(types.at(-1)).toBe('finish')
    expect(types).toContain('text-delta')
  })

  it('defaults to streaming when no mode is given', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Hello!' },
            { type: 'text-end', id: 'text-1' },
            { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
          ],
        }),
      }),
      doGenerate: async () => {
        throw new Error('must not take the run path')
      },
    })
    const agent = new Agent({ model })

    expect(agent.mode).toBe('stream')
    const result = await agent.submit('hi').done

    expect(result.text).toBe('Hello!')
    expect(model.doGenerateCalls).toHaveLength(0)
  })

  it('stream() still yields live text deltas in run mode', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Hello, ' },
            { type: 'text-delta', id: 'text-1', delta: 'world!' },
            { type: 'text-end', id: 'text-1' },
            { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
          ],
        }),
      }),
    })
    const agent = new Agent({ model, mode: 'run' })

    const events: AgentEvent[] = []
    for await (const event of agent.stream('hi')) {
      events.push(event)
    }

    const deltas = events.filter(
      (event): event is Extract<AgentEvent, { type: 'text-delta' }> => event.type === 'text-delta',
    )
    // Two live deltas, not one replayed blob: the stream path was taken.
    expect(deltas.map((event) => event.text)).toEqual(['Hello, ', 'world!'])
    expect(model.doGenerateCalls).toHaveLength(0)
    expect(model.doStreamCalls).toHaveLength(1)
  })
})
