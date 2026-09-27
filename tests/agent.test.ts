import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'

import { Agent, type AgentEvent } from '../src/agent.js'
import { calculatorTool } from '../src/tools/calculator.js'

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

async function collectEvents(agent: Agent, prompt: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of agent.stream(prompt)) {
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
