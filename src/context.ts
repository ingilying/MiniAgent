import type { ModelMessage } from 'ai'

import type { ContextStore } from './store.js'
import { countMessagesTokens, type TokenCounter } from './tokens.js'

export interface ContextOptions {
  /**
   * Store used by `save()` and by the agent's auto-save.
   */
  store?: ContextStore
  /**
   * Identifier of this conversation within the store.
   */
  id?: string
  /**
   * Size of the model's context window in tokens, used for
   * `remainingTokens` and `usageRatio`.
   */
  contextWindow?: number
  /**
   * Custom token counter (defaults to the `o200k_base` counter in `tokens.ts`).
   */
  tokenCounter?: TokenCounter
  /**
   * Save automatically after an agent run, when a store and id are bound.
   *
   * @default true
   */
  autoSave?: boolean
}

/**
 * Conversation history for an agent.
 *
 * A `Context` is the single source of truth for a conversation's messages.
 * Pass it to `Agent.stream()` / `Agent.run()` as the input: the agent sends
 * the current history to the model and, once the run finishes, appends the
 * messages it generated (including tool calls and tool results) back into
 * the context.
 *
 * ```ts
 * const context = new Context()
 * context.addUser('What is 6 * 7?')
 *
 * for await (const event of agent.stream(context)) {
 *   if (event.type === 'text-delta') process.stdout.write(event.text)
 * }
 *
 * // context.messages now also contains the assistant (and tool) messages
 * ```
 *
 * With a store bound, the history is persisted automatically after each
 * agent run and can be restored later:
 *
 * ```ts
 * const store = new FileContextStore('.miniagent/contexts')
 * const context = await Context.load(store, 'user-123')
 * context.addUser('hi')
 * // ... agent.stream(context) — saved by the agent
 * await context.save() // or save explicitly
 * ```
 */
export class Context {
  private readonly history: ModelMessage[]
  private readonly tokenCounter: TokenCounter

  /**
   * Store this context is bound to, if any.
   */
  readonly store: ContextStore | undefined
  /**
   * Id of this conversation within the store, if bound.
   */
  readonly id: string | undefined
  /**
   * Whether the agent saves this context automatically after each run.
   */
  readonly autoSave: boolean
  /**
   * Size of the model's context window in tokens, if known.
   */
  contextWindow: number | undefined

  constructor(initialMessages: readonly ModelMessage[] = [], options: ContextOptions = {}) {
    this.history = [...initialMessages]
    this.store = options.store
    this.id = options.id
    this.autoSave = options.autoSave ?? true
    this.contextWindow = options.contextWindow
    this.tokenCounter = options.tokenCounter ?? countMessagesTokens
  }

  /**
   * Snapshot of the current history. Mutating the returned array does not
   * affect the context.
   */
  get messages(): readonly ModelMessage[] {
    return [...this.history]
  }

  /**
   * Number of messages in the history.
   */
  get messageCount(): number {
    return this.history.length
  }

  /**
   * Estimated number of tokens the history occupies in the context window.
   */
  get tokenCount(): number {
    return this.tokenCounter(this.history)
  }

  /**
   * Tokens still available in the context window, when one is configured.
   */
  get remainingTokens(): number | undefined {
    if (this.contextWindow === undefined) {
      return undefined
    }
    return this.contextWindow - this.tokenCount
  }

  /**
   * Fraction of the context window in use (0..1), when one is configured.
   */
  get usageRatio(): number | undefined {
    if (this.contextWindow === undefined) {
      return undefined
    }
    return this.tokenCount / this.contextWindow
  }

  /**
   * Append a single message.
   */
  add(message: ModelMessage): this {
    this.history.push(message)
    return this
  }

  /**
   * Append a user text message.
   */
  addUser(text: string): this {
    return this.add({ role: 'user', content: text })
  }

  /**
   * Append an assistant text message.
   */
  addAssistant(text: string): this {
    return this.add({ role: 'assistant', content: text })
  }

  /**
   * Append multiple messages, e.g. `result.responseMessages`.
   */
  append(messages: readonly ModelMessage[]): this {
    this.history.push(...messages)
    return this
  }

  /**
   * Remove all messages.
   */
  clear(): void {
    this.history.length = 0
  }

  /**
   * Create an independent copy of this context (bound to the same store).
   */
  clone(): Context {
    return new Context(this.history, {
      store: this.store,
      id: this.id,
      contextWindow: this.contextWindow,
      tokenCounter: this.tokenCounter,
      autoSave: this.autoSave,
    })
  }

  /**
   * Persist the history to the bound store.
   */
  async save(): Promise<void> {
    if (this.store === undefined || this.id === undefined) {
      throw new Error(
        'Context is not bound to a store. Pass { store, id } to the constructor or use Context.load().',
      )
    }
    await this.store.save(this.id, this.messages)
  }

  /**
   * Load a context from a store. Returns an empty, store-bound context when
   * nothing has been stored for the id yet.
   */
  static async load(
    store: ContextStore,
    id: string,
    options: Omit<ContextOptions, 'store' | 'id'> = {},
  ): Promise<Context> {
    const messages = await store.load(id)
    return new Context(messages ?? [], { ...options, store, id })
  }
}
