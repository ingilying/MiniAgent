import type {
  FinishReason,
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  StepResult,
  ToolSet,
  TypedToolCall,
  TypedToolResult,
} from 'ai'
import type { Logger as PinoLogger } from 'pino'

import type { Context } from '../session/context.js'

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
   * Conversation this agent works on. `submit()` adds each input to it as
   * a user message; without one, every run is ephemeral.
   */
  readonly context?: Context
  /**
   * How queued runs execute: live events (`'stream'`) or run-to-completion
   * then replay (`'run'`). `stream()` always streams regardless of this.
   *
   * @default 'stream'
   */
  readonly mode?: AgentMode
  /**
   * Maximum number of steps (model calls) before the tool loop is stopped.
   *
   * @default 10
   */
  readonly maxSteps?: number
  readonly temperature?: number
  readonly maxOutputTokens?: number
  /**
   * Receives run boundary lines (started, finished) at debug level.
   */
  readonly logger?: PinoLogger
}

export interface AgentCallOptions {
  /**
   * Aborts the run, including any in-flight tool executions.
   */
  readonly abortSignal?: AbortSignal
}

/**
 * How queued runs execute. `'stream'` produces events live via `streamText`;
 * `'run'` completes via `generateText` and replays the events afterwards.
 */
export type AgentMode = 'stream' | 'run'

/** An event on the global output stream: the run it belongs to rides along. */
export type AgentOutputEvent = AgentEvent & { readonly runId: string }

/** Receives every output event from every run. Filter by `runId`. */
export type AgentListener = (event: AgentOutputEvent) => void

/**
 * A submitted run's outcome. `error` is set when the run failed instead
 * of finishing: the pump emits an `error` event and moves on, and `done`
 * resolves with the partial result plus the cause.
 */
export type AgentSubmitResult = AgentRunResult & { readonly error?: unknown }

/** Handle for a queued run: its id plus the outcome, for callers that wait. */
export interface SubmitHandle {
  readonly id: string
  readonly done: Promise<AgentSubmitResult>
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
