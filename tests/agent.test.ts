import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'

import { Agent, type AgentEvent, type AgentInput } from '../src/agent.js'
import { Context } from '../src/context.js'
import { calculatorTool } from '../src/tools/calculator.js'

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

async function collectEvents(agent: Agent, input: AgentInput): Promise<AgentEvent[]> {
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
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'calculator',
                input: '{"expression":"2 + 3 * 4"}',
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
              { type: 'text-delta', id: 'text-1', delta: 'It is 14.' },
              { type: 'text-end', id: 'text-1' },
              { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
            ],
          }),
        },
      ],
    })

    const agent = new Agent({ model, tools: { calculator: calculatorTool }, maxSteps: 4 })
    const events = await collectEvents(agent, 'calculate 2 + 3 * 4')

    expect(events.find((event) => event.type === 'tool-call')).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'calculator',
      input: { expression: '2 + 3 * 4' },
    })
    expect(events.find((event) => event.type === 'tool-result')).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'calculator',
      output: { result: 14 },
    })
    expect(textOf(events)).toBe('It is 14.')
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('runs tool calls to completion without streaming', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'calculator',
              input: '{"expression":"10 / 4"}',
            },
          ],
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage,
          warnings: [],
        },
        {
          content: [{ type: 'text', text: '10 divided by 4 is 2.5.' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage,
          warnings: [],
        },
      ],
    })

    const agent = new Agent({ model, tools: { calculator: calculatorTool } })
    const result = await agent.run('divide 10 by 4')

    expect(result.text).toBe('10 divided by 4 is 2.5.')
    expect(result.toolResults[0]).toMatchObject({
      toolName: 'calculator',
      output: { expression: '10 / 4', result: 2.5 },
    })
    expect(result.responseMessages.length).toBeGreaterThan(0)
    expect(model.doGenerateCalls).toHaveLength(2)
  })
})

describe('Agent with Context', () => {
  it('saves the conversation history across streamed runs', async () => {
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
                toolName: 'calculator',
                input: '{"expression":"2 + 3 * 4"}',
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
              { type: 'text-delta', id: 'text-1', delta: 'It is 14.' },
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

    const agent = new Agent({ model, tools: { calculator: calculatorTool } })
    const context = new Context().addUser('calculate 2 + 3 * 4')

    await collectEvents(agent, context)

    // user + assistant (tool call) + tool result + assistant (answer)
    expect(context.messageCount).toBe(4)
    expect(context.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])

    context.addUser('thanks')
    await collectEvents(agent, context)

    expect(context.messageCount).toBe(6)
    // the second turn was sent with the full conversation history (5 messages)
    expect(model.doStreamCalls[2]?.prompt.length).toBe(5)
  })

  it('run() also saves the history', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'text', text: 'Hello!' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      },
    })

    const agent = new Agent({ model })
    const context = new Context().addUser('hi')

    await agent.run(context)

    expect(context.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  })
})
