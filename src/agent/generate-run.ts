import { generateText } from 'ai'

import type { QueueItem } from './queue.js'
import { callSettings, createFail, type RunEnv } from './run-env.js'
import type { Turn } from './turn.js'

/**
 * Runs one queued item to completion with `generateText`, then fans its
 * events out: step boundaries, tool traffic, and the finish line are
 * replayed from the finished result.
 */
export async function generateRun(env: RunEnv, item: QueueItem, turn: Turn): Promise<void> {
  const { id, abortSignal, resolve } = item
  const fail = createFail(env, item, turn, () => ({}))

  turn.logStart()
  let result: Awaited<ReturnType<typeof generateText>>
  try {
    if (abortSignal?.aborted === true) {
      throw abortSignal.reason ?? new Error('Run aborted before it started.')
    }
    result = await generateText({ ...callSettings(env), messages: turn.messages, abortSignal })
  } catch (error) {
    // Cancellation already reported and rolled back: touch nothing.
    if (!item.cancelled) {
      fail(error)
    }
    return
  }
  if (item.cancelled) {
    return
  }

  if (turn.context !== undefined) {
    await turn.commit(result.responseMessages, result.usage)
    if (item.cancelled) {
      return
    }
    turn.logFinish(result.steps.length)
  }

  env.emit({ type: 'start' }, id)
  result.steps.forEach((step, stepNumber) => {
    env.emit({ type: 'step-start', stepNumber }, id)
    for (const call of step.toolCalls) {
      env.emit(
        {
          type: 'tool-call',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
        },
        id,
      )
    }
    for (const outcome of step.toolResults) {
      env.emit(
        {
          type: 'tool-result',
          toolCallId: outcome.toolCallId,
          toolName: outcome.toolName,
          output: outcome.output,
        },
        id,
      )
    }
    if (step.text.length > 0) {
      env.emit({ type: 'text-delta', text: step.text }, id)
    }
    env.emit(
      { type: 'step-finish', stepNumber, finishReason: step.finishReason, usage: step.usage },
      id,
    )
  })
  env.emit({ type: 'finish', finishReason: result.finishReason, usage: result.usage }, id)

  resolve({
    text: result.text,
    finishReason: result.finishReason,
    usage: result.usage,
    steps: result.steps,
    toolCalls: result.toolCalls,
    toolResults: result.toolResults,
    responseMessages: result.responseMessages,
  })
}
