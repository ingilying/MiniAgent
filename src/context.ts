import { randomUUID } from 'node:crypto'

import type { LanguageModelUsage, ModelMessage } from 'ai'

import type { ContextSnapshot, ContextStore, ContextUsage } from './store.js'

export interface ContextOptions {
  /**
   * Store used by `save()` and by the agent's auto-save.
   */
  store?: ContextStore
  /**
   * Identifier of this conversation within the store.
   *
   * @default a generated UUID
   */
  id?: string
  /**
   * Size of the model's context window in tokens, used for
   * `remainingTokens`.
   */
  contextWindow?: number
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
 * // context.messages now also contains the assistant (and tool) messages,
 * // and context.tokenCount is the usage the model reported for that call
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
 *
 * Token counts come from the provider: after every run the agent records the
 * token usage the model reported, and `tokenCount` reports it. Messages that
 * have not been sent to the model yet are not part of that number.
 */
export class Context {
  private readonly history: ModelMessage[]
  private lastUsage: ContextUsage | undefined

  /**
   * Store this context is bound to, if any.
   */
  readonly store: ContextStore | undefined
  /**
   * Id of this conversation within the store. Generated when none is given.
   */
  readonly id: string
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
    this.id = options.id ?? randomUUID()
    this.autoSave = options.autoSave ?? true
    this.contextWindow = options.contextWindow
  }

  /**
   * Snapshot of the current history. Returning the copy of the array does not
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
   * Tokens the conversation took, as reported by the provider for the last
   * model response: input + output tokens. Cached input tokens are part of
   * the input total, so they are not added again. `0` until a response has
   * been recorded.
   */
  get tokenCount(): number {
    return this.lastUsage === undefined
      ? 0
      : this.lastUsage.inputTokens + this.lastUsage.outputTokens
  }

  /**
   * Usage of the last model response, if any.
   */
  get usage(): ContextUsage | undefined {
    return this.lastUsage === undefined ? undefined : { ...this.lastUsage }
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
   * Record the token usage the provider reported for a model response.
   *
   * Called by the agent after every run. Cache numbers come from the input
   * token details and default to `0` when the provider omits them. Usage
   * without an input token count is ignored, so the count never silently
   * becomes wrong.
   */
  recordUsage(
    usage: Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens'> & {
      inputTokenDetails?: LanguageModelUsage['inputTokenDetails']
    },
  ): void {
    if (usage.inputTokens === undefined) {
      return
    }
    this.lastUsage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
    }
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
    const copy = new Context(this.history, {
      store: this.store,
      id: this.id,
      contextWindow: this.contextWindow,
      autoSave: this.autoSave,
    })
    if (this.lastUsage !== undefined) {
      copy.lastUsage = { ...this.lastUsage }
    }
    return copy
  }

  /**
   * Persist the history and the last usage to the bound store.
   */
  async save(): Promise<void> {
    if (this.store === undefined) {
      throw new Error(
        'Context is not bound to a store. Pass { store } to the constructor or use Context.load().',
      )
    }
    await this.store.save(this.id, this.snapshot())
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
    const snapshot = await store.load(id)
    const context = new Context(snapshot?.messages ?? [], { ...options, store, id })
    if (snapshot?.usage !== undefined) {
      context.lastUsage = { ...snapshot.usage }
    }
    return context
  }

  private snapshot(): ContextSnapshot {
    // return shadow copy of the messages
    return { messages: this.messages, usage: this.usage }
  }
}
