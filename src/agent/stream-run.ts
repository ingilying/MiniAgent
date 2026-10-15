import {
  streamText,
  type FinishReason,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
  type TypedToolCall,
  type TypedToolResult,
} from 'ai'

import { ABORTED, AbortGate } from './abort.js'
import type { QueueItem } from './queue.js'
import { emptyUsage } from './results.js'
import { callSettings, createFail, type RunEnv } from './run-env.js'
import type { Turn } from './turn.js'

/**
 * Streams one queued run to the output stream, live, and settles its
 * handle. Failures never throw: they are reported once through `fail`.
 */
export async function streamRun(env: RunEnv, item: QueueItem, turn: Turn): Promise<void> {
  const { id, abortSignal, resolve } = item

  let stepNumber = 0
  let text = ''
  let finishReason: FinishReason = 'stop'
  let usage: LanguageModelUsage | undefined
  const toolCalls: TypedToolCall<ToolSet>[] = []
  const toolResults: TypedToolResult<ToolSet>[] = []
  const responseMessages: ModelMessage[] = []
  let streamError: unknown

  const fail = createFail(env, item, turn, () => ({
    text,
    finishReason,
    usage: usage ?? emptyUsage(),
    toolCalls,
    toolResults,
    responseMessages,
  }))

  turn.logStart()
  if (abortSignal?.aborted === true) {
    fail(abortSignal.reason ?? new Error('Run aborted before it started.'))
    return
  }

  const result = streamText({ ...callSettings(env), messages: turn.messages, abortSignal })
  const gate = new AbortGate(abortSignal)
  const reader = result.stream.getReader()

  try {
    let reading = true
    while (reading) {
      let next
      try {
        next = await gate.guard(reader.read())
      } catch (error) {
        // The stream itself failed: roll the pre-added input back and report
        // once, mirroring the generate path. Cancellation already reported.
        gate.dispose()
        if (!item.cancelled) {
          fail(error)
        }
        return
      }
      if (next === ABORTED || next.done) {
        break
      }
      const part = next.value
      switch (part.type) {
        case 'start':
          env.emit({ type: 'start' }, id)
          break
        case 'start-step':
          env.emit({ type: 'step-start', stepNumber }, id)
          break
        case 'text-delta':
          text += part.text
          env.emit({ type: 'text-delta', text: part.text }, id)
          break
        case 'reasoning-delta':
          env.emit({ type: 'reasoning-delta', text: part.text }, id)
          break
        case 'tool-call': {
          const call = { toolCallId: part.toolCallId, toolName: part.toolName, input: part.input }
          toolCalls.push(call as TypedToolCall<ToolSet>)
          env.emit({ type: 'tool-call', ...call }, id)
          break
        }
        case 'tool-result': {
          const outcome = {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: part.output,
          }
          toolResults.push(outcome as TypedToolResult<ToolSet>)
          env.emit({ type: 'tool-result', ...outcome }, id)
          break
        }
        case 'finish-step':
          env.emit(
            {
              type: 'step-finish',
              stepNumber: stepNumber++,
              finishReason: part.finishReason,
              usage: part.usage,
            },
            id,
          )
          break
        case 'finish':
          finishReason = part.finishReason
          usage = part.totalUsage
          env.emit({ type: 'finish', finishReason, usage: part.totalUsage }, id)
          reading = false
          break
        case 'error':
          // Recorded, not emitted: one exit below reports every failure once.
          streamError = part.error
          reading = false
          break
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // The stream is already gone; abandoning it is the point.
    }
  }

  try {
    // Abandoned while reading: cancellation already reported and rolled
    // back, so touch nothing.
    if (item.cancelled) {
      return
    }
    if (gate.aborted && usage === undefined && streamError === undefined) {
      fail(gate.error())
      return
    }

    if (turn.context === undefined) {
      // Ephemeral run, no context: messages have nowhere to live, discard
      // them. Usage already arrived on the `finish` part when present.
      if (streamError !== undefined || gate.aborted) {
        fail(streamError ?? gate.error())
        return
      }
    } else {
      let outcome
      try {
        outcome = await gate.guard(
          Promise.all([result.responseMessages, result.usage]).then(([messagesOut, usageOut]) => ({
            messagesOut,
            usageOut,
          })),
        )
      } catch (error) {
        // Settling replays the stream failure (e.g. a throwing model):
        // roll the pre-added input back and report once.
        if (!item.cancelled) {
          fail(streamError ?? error)
        }
        return
      }
      if (item.cancelled) {
        return
      }
      if (outcome === ABORTED) {
        fail(streamError ?? gate.error())
        return
      }
      responseMessages.push(...outcome.messagesOut)
      usage = outcome.usageOut
      await turn.commit(responseMessages, usage)
      if (item.cancelled) {
        return
      }
      turn.logFinish(stepNumber)
      if (streamError !== undefined) {
        env.emit({ type: 'error', error: streamError }, id)
      }
    }

    resolve({
      text,
      finishReason,
      usage: usage ?? emptyUsage(),
      steps: [],
      toolCalls,
      toolResults,
      responseMessages,
    })
  } finally {
    gate.dispose()
  }
}
