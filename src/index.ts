import { createInterface } from 'node:readline/promises'

import { openai } from '@ai-sdk/openai'

import { Agent, type AgentEvent } from './agent.js'
import { Context } from './context.js'
import { fetchModelLimits } from './model-info.js'
import { FileContextStore } from './store.js'
import { calculatorTool } from './tools/calculator.js'
import { getCurrentTimeTool } from './tools/current-time.js'

const SUGGESTED_PROMPT = 'What is 17 * 23? Also, what time is it in Seoul right now?'

const STORE_DIRECTORY = '.miniagent/contexts'
const MODEL_CACHE_FILE = '.miniagent/models.json'
const DEFAULT_SESSION = 'default'
const DEFAULT_MODEL = 'gpt-6-astra'

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

/**
 * Context window for the model: an explicit override wins, otherwise the
 * limit is read from the models.dev catalog. `undefined` when neither is
 * available.
 */
async function resolveContextWindow(modelId: string): Promise<number | undefined> {
  const override = process.env.MINIAGENT_CONTEXT_WINDOW
  if (override !== undefined) {
    const value = Number(override)
    if (Number.isFinite(value) && value > 0) {
      return value
    }
    console.log(`[model] ignoring invalid MINIAGENT_CONTEXT_WINDOW="${override}"`)
  }

  try {
    const limits = await fetchModelLimits(modelId, { cacheFile: MODEL_CACHE_FILE })
    if (limits?.contextWindow === undefined) {
      console.log(`[model] no context window in catalog for "${modelId}"`)
      return undefined
    }
    console.log(
      `[model] ${limits.id}: ${limits.contextWindow.toLocaleString('en-US')} token context window`,
    )
    return limits.contextWindow
  } catch (error) {
    console.log(`[model] could not read model limits: ${String(error)}`)
    return undefined
  }
}

function describeTokens(context: Context): string {
  const used = context.tokenCount.toLocaleString('en-US')
  const usage = context.usage

  const lines: string[] = []
  if (context.contextWindow === undefined) {
    lines.push(used)
  } else {
    const ratio = ((context.tokenCount / context.contextWindow) * 100).toFixed(1)
    lines.push(`${used} / ${context.contextWindow.toLocaleString('en-US')} (${ratio}%)`)
  }

  if (usage !== undefined && (usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0)) {
    const read = usage.cacheReadTokens.toLocaleString('en-US')
    const write = usage.cacheWriteTokens.toLocaleString('en-US')
    lines.push(`cache ${read} read, ${write} write`)
  }

  return `[tokens] ${lines.join(' · ')}`
}

function createAgent(modelId: string): Agent {
  return new Agent({
    model: openai(modelId),
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

  const modelId = process.env.OPENAI_MODEL ?? DEFAULT_MODEL
  const agent = createAgent(modelId)
  const contextWindow = await resolveContextWindow(modelId)

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
