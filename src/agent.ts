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

import { randomUUID } from 'node:crypto'

import { Context } from './context.js'
import type { Logger as PinoLogger } from 'pino'

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

export const DEFAULT_MAX_STEPS = 10

/**
 * A minimal agent built directly on AI SDK Core primitives
 * (`streamText` / `generateText` + `tools` + `stopWhen`).
 *
 * The agent runs a tool loop: the model generates text and/or tool calls,
 * tools are executed, results are fed back, and the loop continues until the
 * model stops calling tools or `maxSteps` is reached.
 *
 * An agent handles one input at a time. `submit()` queues inputs behind
 * the running one and the pump works the queue in order; `subscribe()`
 * taps the single output stream carrying every run's events tagged with
 * its `runId`. `isRunning` reports whether the pump holds a run.
 */
export class Agent {
  readonly model: LanguageModel
  readonly system: string | undefined
  readonly tools: ToolSet | undefined
  readonly context: Context | undefined
  readonly maxSteps: number
  readonly temperature: number | undefined
  readonly maxOutputTokens: number | undefined
  readonly logger: PinoLogger | undefined

  private running = false
  private active: QueueItem | undefined
  private readonly queue: QueueItem[] = []
  private readonly listeners = new Set<AgentListener>()

  constructor(options: AgentOptions) {
    this.model = options.model
    this.system = options.system
    this.tools = options.tools
    this.context = options.context
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
    this.temperature = options.temperature
    this.maxOutputTokens = options.maxOutputTokens
    this.logger = options.logger
  }

  /**
   * Whether a run is currently executing. Queued inputs wait their turn
   * while this is true.
   */
  get isRunning(): boolean {
    return this.running
  }

  /**
   * Taps the global output stream. The listener sees every run's events;
   * filter by `runId` for one run. Returns an unsubscribe function. A
   * throwing listener never breaks the pump.
   */
  subscribe(listener: AgentListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Queues an input behind the running one and returns its handle at
   * once. The pump picks queued inputs up in order; `done` resolves with
   * the run's result, or the partial result plus `error` when it failed.
   * The input is read when the run starts, not when submitted.
   */
  submit(input: string, options: AgentCallOptions = {}): SubmitHandle {
    const id = randomUUID()
    const done = new Promise<AgentSubmitResult>((resolve) => {
      this.queue.push({
        id,
        input,
        mode: 'run',
        abortSignal: options.abortSignal,
        resolve,
        cancelled: false,
        context: undefined,
        preCount: 0,
      })
    })
    this.pump()
    return { id, done }
  }

  /** Starts the pump when idle: one run at a time, in queue order. */
  private pump(): void {
    if (this.running) {
      return
    }
    const next = this.queue.shift()
    if (next === undefined) {
      return
    }
    this.running = true
    this.active = next
    void this.execute(next).then(
      () => this.finishActive(next),
      (error: unknown) => {
        // Never leave the pump or a waiter stuck: report and move on.
        this.emit({ type: 'error', error }, next.id)
        next.resolve({ ...emptyResult(), error })
        this.finishActive(next)
      },
    )
  }

  /** Advances past a completed run, unless cancellation got there first. */
  private finishActive(item: QueueItem): void {
    if (this.active !== item) {
      return
    }
    this.active = undefined
    this.running = false
    this.pump()
  }

  /**
   * Abandons one run at once: drops it from the queue or stops the active
   * one, rolls its conversation back, reports an error, and frees the pump
   * synchronously. The run's async tail sees `cancelled` and touches
   * nothing afterwards.
   */
  private cancelRun(id: string, cause?: unknown): void {
    const queued = this.queue.findIndex((item) => item.id === id)
    if (queued !== -1) {
      const [item] = this.queue.splice(queued, 1)
      if (item === undefined) {
        return
      }
      item.cancelled = true
      const error =
        cause ?? item.abortSignal?.reason ?? new Error('Run cancelled before it started.')
      this.emit({ type: 'error', error }, id)
      item.resolve({ ...emptyResult(), error })
      return
    }
    if (this.active?.id !== id) {
      return
    }
    const item = this.active
    item.cancelled = true
    item.context?.truncate(item.preCount)
    const error = cause ?? item.abortSignal?.reason ?? new Error('Run cancelled.')
    this.emit({ type: 'error', error }, id)
    item.resolve({ ...emptyResult(), error })
    this.active = undefined
    this.running = false
    this.pump()
  }

  /** Runs one queued item in its own mode. Never throws: pump handles it. */
  private execute(item: QueueItem): Promise<void> {
    return item.mode === 'run' ? this.executeRun(item) : this.executeStream(item)
  }

  /** Fans one output event out to every subscriber. */
  private emit(event: AgentEvent, runId: string): void {
    const tagged: AgentOutputEvent = { ...event, runId }
    for (const listener of [...this.listeners]) {
      try {
        listener(tagged)
      } catch {
        // A subscriber must never break the pump or other subscribers.
      }
    }
  }

  /**
   * Run the agent and stream typed events as they happen:
   * text and reasoning deltas, tool calls and results, step boundaries,
   * and the final finish event.
   *
   * Adapter over `submit()` + `subscribe()`: the input queues behind the
   * running one, and only this run's events (without `runId`) are
   * re-yielded. Breaking out aborts the run so the pump moves on.
   *
   * The input is added to the member context as a user message when the
   * run starts; the messages generated during the run are appended to it
   * once the stream has finished.
   *
   * Errors are not thrown; they are yielded as `{ type: 'error' }` events
   * (matching `streamText` behavior of keeping the stream alive).
   */
  async *stream(input: string, options: AgentCallOptions = {}): AsyncGenerator<AgentEvent> {
    const controller = new AbortController()
    const forward = (): void => controller.abort()
    options.abortSignal?.addEventListener('abort', forward, { once: true })
    const id = randomUUID()
    const buffered: AgentOutputEvent[] = []
    let notify: () => void = () => {}
    let terminated = false
    let settled = false
    let settle!: (result: AgentSubmitResult) => void
    const done = new Promise<AgentSubmitResult>((resolve) => {
      settle = resolve
    })
    void done.then(
      () => {
        settled = true
        notify()
      },
      () => {
        settled = true
        notify()
      },
    )
    const unsubscribe = this.subscribe((event) => {
      if (event.runId !== id) {
        return
      }
      buffered.push(event)
      if (event.type === 'finish' || event.type === 'error') {
        terminated = true
      }
      notify()
    })
    try {
      this.queue.push({
        id,
        input,
        mode: 'stream',
        abortSignal: controller.signal,
        resolve: settle,
        cancelled: false,
        context: undefined,
        preCount: 0,
      })
      this.pump()
      for (;;) {
        while (buffered.length === 0 && !terminated && !settled && !controller.signal.aborted) {
          await new Promise<void>((resolve) => {
            notify = resolve
          })
        }
        const next = buffered.shift()
        if (next === undefined) {
          return
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { runId: _runId, ...event } = next
        yield event
        if (next.type === 'finish' || next.type === 'error') {
          // The pump still finalizes the context after the terminal
          // event: wait for it, and never abort a finished run.
          terminated = true
          await done
          return
        }
      }
    } finally {
      options.abortSignal?.removeEventListener('abort', forward)
      unsubscribe()
      if (!terminated) {
        // Breaking out abandons the run now: roll it back and free the
        // pump synchronously instead of waiting out its stream.
        this.cancelRun(id)
        controller.abort()
      }
    }
  }

  /**
   * Streams one queued run to the global output stream, live. Resolves
   * the handle so `done` settles; the adapter consumes the outcome.
   */
  private async executeStream(item: QueueItem): Promise<void> {
    const { id, input, abortSignal, resolve } = item
    const context = this.context
    const preCount = context?.messageCount ?? 0
    if (context !== undefined) {
      context.addUser(input)
    }
    // Snapshot: later turns queue behind this one and must not leak into it.
    const messages: ModelMessage[] =
      context === undefined ? [{ role: 'user', content: input }] : [...context.messages]
    item.context = context
    item.preCount = preCount

    let stepNumber = 0
    let text = ''
    let finishReason: FinishReason = 'stop'
    let usage: LanguageModelUsage | undefined
    const toolCalls: TypedToolCall<ToolSet>[] = []
    const toolResults: TypedToolResult<ToolSet>[] = []
    const responseMessages: ModelMessage[] = []
    let streamError: unknown
    let failed = false
    const fail = (error: unknown): void => {
      if (failed) {
        return
      }
      failed = true
      context?.truncate(preCount)
      this.emit({ type: 'error', error }, id)
      resolve({
        text,
        finishReason,
        usage: usage ?? emptyUsage(),
        steps: [],
        toolCalls,
        toolResults,
        responseMessages,
        error,
      })
    }
    if (context !== undefined) {
      this.logger?.debug(`${context.id} run started (${messages.length} in history)`)
    }
    if (abortSignal?.aborted === true) {
      fail(abortSignal.reason ?? new Error('Run aborted before it started.'))
      return
    }
    const result = streamText({
      model: this.model,
      system: this.system,
      tools: this.tools,
      stopWhen: isStepCount(this.maxSteps),
      temperature: this.temperature,
      maxOutputTokens: this.maxOutputTokens,
      messages,
      abortSignal,
    })

    // Reads lose to aborts on purpose: a consumer that breaks out (or an
    // aborted signal) must settle the run at once instead of hanging on a
    // stream that never ends.
    const ABORTED = Symbol('aborted')
    let rejectOnAbort!: () => void
    const abortPromise = new Promise<typeof ABORTED>((resolve) => {
      rejectOnAbort = () => resolve(ABORTED)
    })
    let abortedFlag = Boolean(abortSignal?.aborted)
    const noteAborted = (): void => {
      abortedFlag = true
      rejectOnAbort()
    }
    abortSignal?.addEventListener('abort', noteAborted, { once: true })
    const gate = async <T>(work: Promise<T>): Promise<T | typeof ABORTED> => {
      if (abortedFlag) {
        return ABORTED
      }
      if (abortSignal === undefined) {
        return work
      }
      return Promise.race([work, abortPromise])
    }
    const abortError = (): unknown =>
      abortSignal?.reason ?? new Error('Run aborted before it finished.')

    const reader = result.stream.getReader()
    let reading = true
    while (reading) {
      const next = await gate(reader.read())
      if (next === ABORTED) {
        break
      }
      if (next.done) {
        break
      }
      const part = next.value
      switch (part.type) {
        case 'start':
          this.emit({ type: 'start' }, id)
          break
        case 'start-step':
          this.emit({ type: 'step-start', stepNumber }, id)
          break
        case 'text-delta':
          text += part.text
          this.emit({ type: 'text-delta', text: part.text }, id)
          break
        case 'reasoning-delta':
          this.emit({ type: 'reasoning-delta', text: part.text }, id)
          break
        case 'tool-call':
          toolCalls.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          } as TypedToolCall<ToolSet>)
          this.emit(
            {
              type: 'tool-call',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            },
            id,
          )
          break
        case 'tool-result':
          toolResults.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output: part.output,
          } as TypedToolResult<ToolSet>)
          this.emit(
            {
              type: 'tool-result',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: part.output,
            },
            id,
          )
          break
        case 'finish-step':
          this.emit(
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
          this.emit({ type: 'finish', finishReason: part.finishReason, usage: part.totalUsage }, id)
          reading = false
          break
        case 'error':
          // Recorded, not emitted: one exit below reports every failure once.
          streamError = part.error
          reading = false
          break
      }
    }
    try {
      reader.releaseLock()
    } catch {
      // The stream is already gone; abandoning it is the point.
    }
    if (item.cancelled) {
      // Abandoned while reading: cancellation already reported and rolled
      // back, so touch nothing.
      return
    }

    if (abortedFlag && usage === undefined && streamError === undefined) {
      abortSignal?.removeEventListener('abort', noteAborted)
      fail(abortError())
      return
    }

    if (context !== undefined) {
      let settled = false
      const outcome = await gate(
        Promise.all([result.responseMessages, result.totalUsage]).then(
          ([messagesOut, usageOut]): {
            messagesOut: ModelMessage[]
            usageOut: LanguageModelUsage
          } => ({
            messagesOut,
            usageOut,
          }),
        ),
      )
      if (outcome !== ABORTED) {
        responseMessages.push(...outcome.messagesOut)
        usage = outcome.usageOut
        settled = true
      }
      if (item.cancelled) {
        // Abandoned while settling: cancellation already reported and
        // rolled back, so touch nothing.
        return
      }
      abortSignal?.removeEventListener('abort', noteAborted)
      if (settled) {
        context.append(responseMessages)
        if (usage !== undefined) {
          context.recordUsage(usage)
        }
        await saveIfBound(context)
        if (item.cancelled) {
          return
        }
        this.logger?.debug(`${context.id} run finished (${stepNumber} steps)`)
        if (streamError !== undefined) {
          this.emit({ type: 'error', error: streamError }, id)
        }
      } else {
        fail(streamError ?? abortError())
        return
      }
    } else {
      abortSignal?.removeEventListener('abort', noteAborted)
      if (streamError !== undefined || abortedFlag) {
        fail(streamError ?? abortError())
        return
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
  }

  /**
   * Run the agent to completion without streaming and return the final
   * result, including all steps, tool calls, and usage.
   *
   * Adapter over `submit()`: the input queues behind the running one.
   * A failed run still throws, matching the old direct call.
   *
   * The input is added to the member context as a user message when the
   * run starts; the messages generated during the run are appended to it.
   */
  async run(input: string, options: AgentCallOptions = {}): Promise<AgentRunResult> {
    const handle = this.submit(input, options)
    const outcome = await handle.done
    if (outcome.error !== undefined) {
      throw outcome.error
    }
    return outcome
  }

  /**
   * Runs one queued input to completion, fanning its events out to the
   * global stream. Step boundaries, tool traffic, and the finish line are
   * replayed from the finished result.
   */
  private async executeRun(item: QueueItem): Promise<void> {
    const { id, input, abortSignal, resolve } = item
    const context = this.context
    const preCount = context?.messageCount ?? 0
    if (context !== undefined) {
      context.addUser(input)
    }
    // Snapshot: later turns queue behind this one and must not leak into it.
    const messages: ModelMessage[] =
      context === undefined ? [{ role: 'user', content: input }] : [...context.messages]
    item.context = context
    item.preCount = preCount
    let failed = false
    const fail = (error: unknown): void => {
      if (failed) {
        return
      }
      failed = true
      context?.truncate(preCount)
      this.emit({ type: 'error', error }, id)
      resolve({ ...emptyResult(), error })
    }
    if (context !== undefined) {
      this.logger?.debug(`${context.id} run started (${messages.length} in history)`)
    }
    let result: Awaited<ReturnType<typeof generateText>>
    try {
      if (abortSignal?.aborted === true) {
        throw abortSignal.reason ?? new Error('Run aborted before it started.')
      }
      result = await generateText({
        model: this.model,
        system: this.system,
        tools: this.tools,
        stopWhen: isStepCount(this.maxSteps),
        temperature: this.temperature,
        maxOutputTokens: this.maxOutputTokens,
        messages,
        abortSignal,
      })
    } catch (error) {
      fail(error)
      return
    }

    if (context !== undefined) {
      context.append(result.responseMessages)
      context.recordUsage(result.usage)
      await saveIfBound(context)
      this.logger?.debug(`${context.id} run finished (${result.steps.length} steps)`)
    }

    this.emit({ type: 'start' }, id)
    result.steps.forEach((step, stepNumber) => {
      this.emit({ type: 'step-start', stepNumber }, id)
      for (const call of step.toolCalls) {
        this.emit(
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
        this.emit(
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
        this.emit({ type: 'text-delta', text: step.text }, id)
      }
      this.emit(
        { type: 'step-finish', stepNumber, finishReason: step.finishReason, usage: step.usage },
        id,
      )
    })
    this.emit({ type: 'finish', finishReason: result.finishReason, usage: result.usage }, id)

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
}

/** One queued run: the input, how to execute it, and who waits on it. */
interface QueueItem {
  readonly id: string
  readonly input: string
  readonly mode: 'run' | 'stream'
  readonly abortSignal: AbortSignal | undefined
  readonly resolve: (result: AgentSubmitResult) => void
  /** Set when the run is abandoned: its async tail must touch nothing. */
  cancelled: boolean
  /** Bound conversation, fixed when execution starts. For rollback. */
  context: Context | undefined
  /** History length before this run added anything. For rollback. */
  preCount: number
}

/** Zero usage for runs that never reached the model. */
function emptyUsage(): LanguageModelUsage {
  return {
    inputTokens: 0,
    inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens: 0,
    outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
    totalTokens: 0,
  }
}

/** Blank result for runs that never reached the model. */
function emptyResult(): AgentRunResult {
  return {
    text: '',
    finishReason: 'error',
    usage: emptyUsage(),
    steps: [],
    toolCalls: [],
    toolResults: [],
    responseMessages: [],
  }
}

/**
 * Persists the context after a run when it is bound to a store.
 */
async function saveIfBound(context: Context): Promise<void> {
  if (context.autoSave && context.store !== undefined) {
    await context.save()
  }
}
