import { createInterface } from 'node:readline/promises'

import { openai } from '@ai-sdk/openai'

import { Agent, type AgentEvent } from './agent.js'
import { Context } from './context.js'
import { calculatorTool } from './tools/calculator.js'
import { getCurrentTimeTool } from './tools/current-time.js'

const SUGGESTED_PROMPT = 'What is 17 * 23? Also, what time is it in Seoul right now?'

function describeEvent(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'tool-call':
      return `[tool] ${event.toolName} ${JSON.stringify(event.input)}`
    case 'tool-result':
      return `[tool] ${event.toolName} -> ${JSON.stringify(event.output)}`
    case 'step-finish':
      return `[step ${event.stepNumber + 1}] ${event.finishReason}`
    case 'finish':
      return `[done] ${event.finishReason}`
    case 'error':
      return `[error] ${String(event.error)}`
    default:
      return undefined
  }
}

function createAgent(): Agent {
  return new Agent({
    model: openai(process.env.OPENAI_MODEL ?? 'gpt-6-astra'),
    system:
      'You are a precise, helpful assistant. ' +
      'Use the available tools for facts you cannot know, such as math and the current time.',
    tools: { calculator: calculatorTool, getCurrentTime: getCurrentTimeTool },
    maxSteps: 8,
  })
}

async function respond(agent: Agent, context: Context, prompt: string): Promise<void> {
  context.addUser(prompt)
  process.stdout.write('Agent: ')

  for await (const event of agent.stream(context)) {
    if (event.type === 'text-delta') {
      process.stdout.write(event.text)
      continue
    }
    const line = describeEvent(event)
    if (line !== undefined) {
      console.log(`\n${line}`)
    }
  }

  process.stdout.write('\n\n')
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile()
  } catch {
    // .env is optional
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error(
      'Missing OPENAI_API_KEY. Set it in the environment or in a .env file,\n' +
        'then run: pnpm dev "your prompt"',
    )
    process.exitCode = 1
    return
  }

  const agent = createAgent()
  const context = new Context()

  // Single-shot mode: pnpm dev "your prompt"
  const prompt = process.argv[2]
  if (prompt !== undefined) {
    console.log(`You: ${prompt}`)
    await respond(agent, context, prompt)
    return
  }

  // Interactive mode: pnpm dev
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  console.log('MiniAgent REPL — ask anything. Type "exit" or press Ctrl-D to quit.')
  console.log(`Try: "${SUGGESTED_PROMPT}"\n`)

  try {
    process.stdout.write('You: ')
    for await (const line of rl) {
      const input = line.trim()

      if (input === 'exit' || input === 'quit') {
        break
      }

      if (input.length > 0) {
        await respond(agent, context, input)
      }

      process.stdout.write('You: ')
    }
  } finally {
    rl.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
