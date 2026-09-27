import type { ModelMessage } from 'ai'

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
 */
export class Context {
  private readonly history: ModelMessage[]

  constructor(initialMessages: readonly ModelMessage[] = []) {
    this.history = [...initialMessages]
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
   * Create an independent copy of this context.
   */
  clone(): Context {
    return new Context(this.history)
  }
}
