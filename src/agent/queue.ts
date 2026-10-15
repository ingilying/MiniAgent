import { emptyResult } from './results.js'
import type { Turn } from './turn.js'
import type { AgentEvent, AgentMode, AgentSubmitResult } from './types.js'

/** One queued run: the input, how to execute it, and who waits on it. */
export interface QueueItem {
  readonly id: string
  readonly input: string
  readonly mode: AgentMode
  readonly abortSignal: AbortSignal | undefined
  readonly resolve: (result: AgentSubmitResult) => void
  /** Set when the run is abandoned: its async tail must touch nothing. */
  cancelled: boolean
  /** The run's conversation turn, set when execution starts. For rollback. */
  turn: Turn | undefined
}

/** Builds a queued run that has not started yet. */
export function queueItem(
  fields: Pick<QueueItem, 'id' | 'input' | 'mode' | 'abortSignal' | 'resolve'>,
): QueueItem {
  return { ...fields, cancelled: false, turn: undefined }
}

export interface RunQueueHooks {
  /** Executes one item. Failures reject; the queue reports them and moves on. */
  execute(item: QueueItem): Promise<void>
  /** Reports an event for a run the queue itself failed or cancelled. */
  emit(event: AgentEvent, runId: string): void
}

/**
 * Runs queued items one at a time, in order. Cancelling drops a queued
 * item or stops the active one, and frees the pump synchronously.
 */
export class RunQueue {
  private running = false
  private active: QueueItem | undefined
  private readonly pending: QueueItem[] = []

  constructor(private readonly hooks: RunQueueHooks) {}

  /** Whether the pump holds a run. Queued inputs wait while this is true. */
  get isRunning(): boolean {
    return this.running
  }

  /** Queues the item behind the running one and starts the pump when idle. */
  enqueue(item: QueueItem): void {
    this.pending.push(item)
    this.pump()
  }

  /**
   * Abandons one run at once: drops it from the queue or stops the active
   * one, rolls its conversation back, reports an error, and frees the pump
   * synchronously. The run's async tail sees `cancelled` and touches
   * nothing afterwards.
   */
  cancel(id: string, cause?: unknown): void {
    const queued = this.pending.findIndex((item) => item.id === id)
    if (queued !== -1) {
      const [item] = this.pending.splice(queued, 1)
      if (item === undefined) {
        return
      }
      item.cancelled = true
      const error =
        cause ?? item.abortSignal?.reason ?? new Error('Run cancelled before it started.')
      this.hooks.emit({ type: 'error', error }, id)
      item.resolve({ ...emptyResult(), error })
      return
    }
    if (this.active?.id !== id) {
      return
    }
    const item = this.active
    item.cancelled = true
    item.turn?.rollback()
    const error = cause ?? item.abortSignal?.reason ?? new Error('Run cancelled.')
    this.hooks.emit({ type: 'error', error }, id)
    item.resolve({ ...emptyResult(), error })
    this.active = undefined
    this.running = false
    this.pump()
  }

  /** Starts the pump when idle: one run at a time, in queue order. */
  private pump(): void {
    if (this.running) {
      return
    }
    const next = this.pending.shift()
    if (next === undefined) {
      return
    }
    this.running = true
    this.active = next
    void this.hooks.execute(next).then(
      () => this.finishActive(next),
      (error: unknown) => {
        // Never leave the pump or a waiter stuck: report and move on.
        this.hooks.emit({ type: 'error', error }, next.id)
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
}
