import type { LanguageModelUsage, ModelMessage } from 'ai'
import type { Logger } from 'pino'

import type { Context } from '../session/context.js'

/**
 * One run's view of the conversation: the input is added to the context up
 * front, the model sees a snapshot of the history, and the run either
 * commits what it generated or rolls the input back.
 *
 * Without a context the run is ephemeral: the snapshot is just the input,
 * and commit and rollback do nothing.
 */
export class Turn {
  /** What the model is sent. Later turns queue behind this one and never leak into it. */
  readonly messages: ModelMessage[]
  private readonly preCount: number

  constructor(
    readonly context: Context | undefined,
    input: string,
    private readonly logger: Logger | undefined,
  ) {
    this.preCount = context?.messageCount ?? 0
    context?.addUser(input)
    this.messages =
      context === undefined ? [{ role: 'user', content: input }] : [...context.messages]
  }

  logStart(): void {
    if (this.context !== undefined) {
      this.logger?.debug(`${this.context.id} run started (${this.messages.length} in history)`)
    }
  }

  logFinish(steps: number): void {
    if (this.context !== undefined) {
      this.logger?.debug(`${this.context.id} run finished (${steps} steps)`)
    }
  }

  /** Drops everything this run added, restoring the history to its length before the run. */
  rollback(): void {
    this.context?.truncate(this.preCount)
  }

  /** Appends the generated messages, records usage, and saves when the context is bound to a store. */
  async commit(responseMessages: readonly ModelMessage[], usage: LanguageModelUsage | undefined) {
    const context = this.context
    if (context === undefined) {
      return
    }
    context.append(responseMessages)
    if (usage !== undefined) {
      context.recordUsage(usage)
    }
    if (context.autoSave && context.store !== undefined) {
      await context.save()
    }
  }
}
