import {
  generateText,
  isStepCount,
  streamText,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type StepResult,
  type ToolSet,
  type TypedToolCall,
  type TypedToolResult,
} from 'ai'

/**
 * Input for an agent run: either a single user prompt or a full message history.
 */
export type AgentInput = string | ModelMessage[]

export interface AgentOptions {
  /**
   * Any AI SDK language model, e.g. `openai('gpt-6-astra')`.
   */
  readonly model: LanguageModel
  /**
   * System prompt describing the agent's behavior.
   */
  readonly system?: string
  /**
   * Tools the agent is allowed to call.
   */
  readonly tools?: ToolSet
  /**
   * Maximum number of steps (model calls) before the tool loop is stopped.
   *
   * @default 10
   */
  readonly maxSteps?: number
  readonly temperature?: number
  readonly maxOutputTokens?: number
}

export interface AgentCallOptions {
  /**
   * Aborts the run, including any in-flight tool executions.
   */
  readonly abortSignal?: AbortSignal
}

/**
 * Typed events emitted while an agent run streams.
 */
export type AgentEvent =
  | { readonly type: 'start' }
  | { readonly type: 'step-start'; readonly stepNumber: number }
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | {
      readonly type: 'tool-call'
      readonly toolCallId: string
      readonly toolName: string
      readonly input: unknown
    }
  | {
      readonly type: 'tool-result'
      readonly toolCallId: string
      readonly toolName: string
      readonly output: unknown
    }
  | {
      readonly type: 'step-finish'
      readonly stepNumber: number
      readonly finishReason: FinishReason
      readonly usage: LanguageModelUsage
    }
  | {
      readonly type: 'finish'
      readonly finishReason: FinishReason
      readonly usage: LanguageModelUsage
    }
  | { readonly type: 'error'; readonly error: unknown }

export interface AgentRunResult {
  /**
   * The generated text from the final step.
   */
  readonly text: string
  readonly finishReason: FinishReason
  readonly usage: LanguageModelUsage
  readonly steps: StepResult<ToolSet>[]
  readonly toolCalls: TypedToolCall<ToolSet>[]
  readonly toolResults: TypedToolResult<ToolSet>[]
  /**
   * Messages produced during the run. Append them to your conversation
   * history to continue the conversation in a follow-up run.
   */
  readonly responseMessages: ModelMessage[]
}

export const DEFAULT_MAX_STEPS = 10

/**
 * A minimal agent built directly on AI SDK Core primitives
 * (`streamText` / `generateText` + `tools` + `stopWhen`).
 *
 * The agent runs a tool loop: the model generates text and/or tool calls,
 * tools are executed, results are fed back, and the loop continues until the
 * model stops calling tools or `maxSteps` is reached.
 */
export class Agent {
  readonly model: LanguageModel
  readonly system: string | undefined
  readonly tools: ToolSet | undefined
  readonly maxSteps: number
  readonly temperature: number | undefined
  readonly maxOutputTokens: number | undefined

  constructor(options: AgentOptions) {
    this.model = options.model
    this.system = options.system
    this.tools = options.tools
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
    this.temperature = options.temperature
    this.maxOutputTokens = options.maxOutputTokens
  }

  /**
   * Run the agent and stream typed events as they happen:
   * text and reasoning deltas, tool calls and results, step boundaries,
   * and the final finish event.
   *
   * Errors are not thrown; they are yielded as `{ type: 'error' }` events
   * (matching `streamText` behavior of keeping the stream alive).
   */
  async *stream(input: AgentInput, options: AgentCallOptions = {}): AsyncGenerator<AgentEvent> {
    const result = streamText({
      model: this.model,
      system: this.system,
      tools: this.tools,
      stopWhen: isStepCount(this.maxSteps),
      temperature: this.temperature,
      maxOutputTokens: this.maxOutputTokens,
      messages: toMessages(input),
      abortSignal: options.abortSignal,
    })

    let stepNumber = 0

    for await (const part of result.stream) {
      switch (part.type) {
        case 'start':
          yield { type: 'start' }
          break
        case 'start-step':
          yield { type: 'step-start', stepNumber }
          break
        case 'text-delta':
          yield { type: 'text-delta', text: part.text }
          break
        case 'reasoning-delta':
          yield { type: 'reasoning-delta', text: part.text }
          break
        case 'tool-call':
          yield {
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          }
          break
        case 'tool-result':
          yield {
            type: 'tool-result',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: part.output,
          }
          break
        case 'finish-step':
          yield {
            type: 'step-finish',
            stepNumber: stepNumber++,
            finishReason: part.finishReason,
            usage: part.usage,
          }
          break
        case 'finish':
          yield {
            type: 'finish',
            finishReason: part.finishReason,
            usage: part.totalUsage,
          }
          break
        case 'error':
          yield { type: 'error', error: part.error }
          break
      }
    }
  }

  /**
   * Run the agent to completion without streaming and return the final
   * result, including all steps, tool calls, and usage.
   */
  async run(input: AgentInput, options: AgentCallOptions = {}): Promise<AgentRunResult> {
    const result = await generateText({
      model: this.model,
      system: this.system,
      tools: this.tools,
      stopWhen: isStepCount(this.maxSteps),
      temperature: this.temperature,
      maxOutputTokens: this.maxOutputTokens,
      messages: toMessages(input),
      abortSignal: options.abortSignal,
    })

    return {
      text: result.text,
      finishReason: result.finishReason,
      usage: result.usage,
      steps: result.steps,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
      responseMessages: result.responseMessages,
    }
  }
}

function toMessages(input: AgentInput): ModelMessage[] {
  return typeof input === 'string' ? [{ role: 'user', content: input }] : input
}
