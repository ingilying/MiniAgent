import { openai } from '@ai-sdk/openai'

import { Agent, type AgentEvent } from './agent.js'
import { calculatorTool } from './tools/calculator.js'
import { getCurrentTimeTool } from './tools/current-time.js'

const DEFAULT_PROMPT = 'What is 17 * 23? Also, what time is it in Seoul right now?'

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

  const prompt = process.argv[2] ?? DEFAULT_PROMPT

  const agent = new Agent({
    model: openai(process.env.OPENAI_MODEL ?? 'gpt-6-astra'),
    system:
      'You are a precise, helpful assistant. ' +
      'Use the available tools for facts you cannot know, such as math and the current time.',
    tools: { calculator: calculatorTool, getCurrentTime: getCurrentTimeTool },
    maxSteps: 8,
  })

  console.log(`You: ${prompt}\n`)

  for await (const event of agent.stream(prompt)) {
    if (event.type === 'text-delta') {
      process.stdout.write(event.text)
      continue
    }
    const line = describeEvent(event)
    if (line !== undefined) {
      console.log(line)
    }
  }

  console.log()
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
