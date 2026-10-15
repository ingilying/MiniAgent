import { isStepCount, type LanguageModel, type ToolSet } from 'ai'
import type { Logger } from 'pino'

import type { Context } from '../session/context.js'
import type { QueueItem } from './queue.js'
import { emptyResult } from './results.js'
import type { Turn } from './turn.js'
import type { AgentEvent, AgentRunResult } from './types.js'

/** What a run needs from its agent: model settings, the conversation, and where events go. */
export interface RunEnv {
  readonly model: LanguageModel
  readonly system: string | undefined
  readonly tools: ToolSet | undefined
  readonly maxSteps: number
  readonly temperature: number | undefined
  readonly maxOutputTokens: number | undefined
  readonly context: Context | undefined
  readonly logger: Logger | undefined
  emit(event: AgentEvent, runId: string): void
}

/** Settings shared by the `streamText` and `generateText` calls. */
export function callSettings(env: RunEnv) {
  return {
    model: env.model,
    system: env.system,
    tools: env.tools,
    stopWhen: isStepCount(env.maxSteps),
    temperature: env.temperature,
    maxOutputTokens: env.maxOutputTokens,
  }
}

/**
 * Builds the run's failure exit: rolls the turn back, reports one `error`
 * event, and settles the handle with `partial` on top of a blank result.
 * Calling it again does nothing, so every failure path can call it freely.
 */
export function createFail(
  env: RunEnv,
  item: QueueItem,
  turn: Turn,
  partial: () => Partial<AgentRunResult>,
): (error: unknown) => void {
  let failed = false
  return (error) => {
    if (failed) {
      return
    }
    failed = true
    turn.rollback()
    env.emit({ type: 'error', error }, item.id)
    item.resolve({ ...emptyResult(), ...partial(), error })
  }
}
