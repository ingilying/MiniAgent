import { createInterface } from 'node:readline/promises'

import { openai } from '@ai-sdk/openai'

import { Agent, type AgentEvent } from './agent.js'
import { Context } from './context.js'
import { FileContextStore } from './store.js'
import { calculatorTool } from './tools/calculator.js'
import { getCurrentTimeTool } from './tools/current-time.js'

const SUGGESTED_PROMPT = 'What is 17 * 23? Also, what time is it in Seoul right now?'

const STORE_DIRECTORY = '.miniagent/contexts'
const DEFAULT_SESSION = 'default'
const DEFAULT_CONTEXT_WINDOW = 128_000

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

function contextWindowFromEnv(): number {
  const value = Number(process.env.MINIAGENT_CONTEXT_WINDOW ?? DEFAULT_CONTEXT_WINDOW)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CONTEXT_WINDOW
}

function describeTokens(context: Context): string {
  const used = context.tokenCount.toLocaleString('en-US')
  if (context.contextWindow === undefined) {
    return `[tokens] ${used}`
  }
  const ratio = ((context.usageRatio ?? 0) * 100).toFixed(1)
  return `[tokens] ${used} / ${context.contextWindow.toLocaleString('en-US')} (${ratio}%)`
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

  console.log(`\n${describeTokens(context)}\n`)
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
  const contextWindow = contextWindowFromEnv()

  // Single-shot mode: pnpm dev "your prompt" (ephemeral context)
  const prompt = process.argv[2]
  if (prompt !== undefined) {
    const context = new Context([], { contextWindow })
    console.log(`You: ${prompt}`)
    await respond(agent, context, prompt)
    return
  }

  // Interactive mode: pnpm dev (persisted per session, restored on start)
  const store = new FileContextStore(STORE_DIRECTORY)
  const session = process.env.MINIAGENT_SESSION ?? DEFAULT_SESSION
  const context = await Context.load(store, session, { contextWindow })

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  console.log('MiniAgent REPL — ask anything. Type "exit" or press Ctrl-D to quit.')
  console.log(`Try: "${SUGGESTED_PROMPT}"`)
  if (context.messageCount > 0) {
    console.log(
      `Restored session "${session}": ${context.messageCount} messages, ${describeTokens(context)}.`,
    )
  } else {
    console.log(`New session "${session}" — history is saved to ${STORE_DIRECTORY}.`)
  }
  console.log()

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
