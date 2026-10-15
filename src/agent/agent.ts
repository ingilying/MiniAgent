import { randomUUID } from 'node:crypto'

import type { LanguageModel, ToolSet } from 'ai'
import type { Logger as PinoLogger } from 'pino'

import type { Context } from '../session/context.js'
import { generateRun } from './generate-run.js'
import { RunQueue, queueItem, type QueueItem } from './queue.js'
import type { RunEnv } from './run-env.js'
import { streamRun } from './stream-run.js'
import { Turn } from './turn.js'
import type {
  AgentCallOptions,
  AgentEvent,
  AgentListener,
  AgentMode,
  AgentOptions,
  AgentOutputEvent,
  AgentRunResult,
  AgentSubmitResult,
  SubmitHandle,
} from './types.js'

export type {
  AgentCallOptions,
  AgentEvent,
  AgentListener,
  AgentMode,
  AgentOptions,
  AgentOutputEvent,
  AgentRunResult,
  AgentSubmitResult,
  SubmitHandle,
} from './types.js'

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
 * the running one and the queue works through them in order; `subscribe()`
 * taps the single output stream carrying every run's events tagged with
 * its `runId`. `isRunning` reports whether a run is active.
 */
export class Agent {
  readonly model: LanguageModel
  readonly system: string | undefined
  readonly tools: ToolSet | undefined
  readonly context: Context | undefined
  /**
   * How queued runs execute. Set from options, defaulting to `'stream'`.
   * `stream()` always streams regardless of this.
   */
  readonly mode: AgentMode
  readonly maxSteps: number
  readonly temperature: number | undefined
  readonly maxOutputTokens: number | undefined
  readonly logger: PinoLogger | undefined

  private readonly runs: RunQueue
  private readonly env: RunEnv
  private readonly listeners = new Set<AgentListener>()

  constructor(options: AgentOptions) {
    this.model = options.model
    this.system = options.system
    this.tools = options.tools
    this.context = options.context
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
    this.mode = options.mode ?? 'stream'
    this.temperature = options.temperature
    this.maxOutputTokens = options.maxOutputTokens
    this.logger = options.logger
    this.env = {
      model: this.model,
      system: this.system,
      tools: this.tools,
      maxSteps: this.maxSteps,
      temperature: this.temperature,
      maxOutputTokens: this.maxOutputTokens,
      context: this.context,
      logger: this.logger,
      emit: (event, runId) => this.emit(event, runId),
    }
    this.runs = new RunQueue({
      execute: (item) => this.execute(item),
      emit: (event, runId) => this.emit(event, runId),
    })
  }

  /**
   * Whether a run is currently executing. Queued inputs wait their turn
   * while this is true.
   */
  get isRunning(): boolean {
    return this.runs.isRunning
  }

  /**
   * Taps the global output stream. The listener sees every run's events;
   * filter by `runId` for one run. Returns an unsubscribe function. A
   * throwing listener never breaks the queue.
   */
  subscribe(listener: AgentListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Queues an input behind the running one and returns its handle at
   * once. Queued inputs run in order; `done` resolves with the run's
   * result, or the partial result plus `error` when it failed. The input
   * is read when the run starts, not when submitted.
   */
  submit(input: string, options: AgentCallOptions = {}): SubmitHandle {
    const id = randomUUID()
    const done = new Promise<AgentSubmitResult>((resolve) => {
      this.runs.enqueue(
        queueItem({ id, input, mode: this.mode, abortSignal: options.abortSignal, resolve }),
      )
    })
    return { id, done }
  }

  /**
   * Run the agent and stream typed events as they happen:
   * text and reasoning deltas, tool calls and results, step boundaries,
   * and the final finish event.
   *
   * Adapter over the run queue and `subscribe()`: the input queues behind
   * the running one, and only this run's events (without `runId`) are
   * re-yielded. Breaking out aborts the run so the queue moves on.
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
    let notify = () => {}
    let terminated = false
    let settled = false
    let settle!: (result: AgentSubmitResult) => void
    const done = new Promise<AgentSubmitResult>((resolve) => {
      settle = resolve
    })
    void done.then(() => {
      settled = true
      notify()
    })
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
      // stream()'s contract is live events, so it always takes the
      // streaming path regardless of this.mode.
      this.runs.enqueue(
        queueItem({
          id,
          input,
          mode: 'stream',
          abortSignal: controller.signal,
          resolve: settle,
        }),
      )
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
        yield omitRunId(next)
        if (next.type === 'finish' || next.type === 'error') {
          // The run still finalizes the context after the terminal
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
        // queue synchronously instead of waiting out its stream.
        this.runs.cancel(id)
        controller.abort()
      }
    }
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

  /** Starts one queued item in its own mode. Failures reject; the queue handles them. */
  private execute(item: QueueItem): Promise<void> {
    let turn: Turn
    try {
      turn = new Turn(this.context, item.input, this.logger)
    } catch (error) {
      return Promise.reject(error)
    }
    item.turn = turn
    return item.mode === 'run' ? generateRun(this.env, item, turn) : streamRun(this.env, item, turn)
  }

  /** Fans one output event out to every subscriber. */
  private emit(event: AgentEvent, runId: string): void {
    const tagged: AgentOutputEvent = { ...event, runId }
    for (const listener of [...this.listeners]) {
      try {
        listener(tagged)
      } catch {
        // A subscriber must never break the queue or other subscribers.
      }
    }
  }
}

/** Strips the run tag, leaving the plain event a single-run consumer expects. */
function omitRunId(tagged: AgentOutputEvent): AgentEvent {
  const event: Record<string, unknown> = { ...tagged }
  delete event.runId
  return event as AgentEvent
}
