import type { ModelMessage } from 'ai'
import { encode } from 'gpt-tokenizer'

/**
 * Approximate number of tokens chat models add per message for framing
 * (role markers, separators, etc.).
 */
export const MESSAGE_OVERHEAD_TOKENS = 4

/**
 * Approximate number of tokens added once per request to prime the reply.
 */
export const REPLY_OVERHEAD_TOKENS = 3

/**
 * Counts the tokens of a message history.
 */
export type TokenCounter = (messages: readonly ModelMessage[]) => number

type MessagePart = Exclude<ModelMessage['content'], string>[number]

function partText(part: MessagePart): string {
  switch (part.type) {
    case 'text':
      return part.text
    case 'reasoning':
      return part.text
    case 'tool-call':
      return `${part.toolName} ${JSON.stringify(part.input)}`
    case 'tool-result': {
      const { output } = part
      if (output.type === 'text') {
        return output.value
      }
      if (output.type === 'json') {
        return JSON.stringify(output.value)
      }
      return JSON.stringify(output)
    }
    default:
      // Media and other non-text parts are not tokenized.
      return ''
  }
}

/**
 * Flattens a message into the text that is sent to the model.
 */
function messageText(message: ModelMessage): string {
  if (typeof message.content === 'string') {
    return message.content
  }
  return message.content
    .map(partText)
    .filter((text) => text.length > 0)
    .join('\n')
}

/**
 * Number of tokens in a piece of text, using the `o200k_base` encoding
 * (the encoding used by OpenAI's GPT-4o/5/6-era models).
 */
export function countTextTokens(text: string): number {
  return text.length === 0 ? 0 : encode(text).length
}

/**
 * Number of tokens a single message takes in the context window,
 * including per-message framing overhead.
 */
export function countMessageTokens(message: ModelMessage): number {
  return countTextTokens(messageText(message)) + MESSAGE_OVERHEAD_TOKENS
}

/**
 * Number of tokens a message history takes in the context window.
 *
 * This is an estimate: it tokenizes all text, tool calls, and tool results,
 * and adds the per-message and reply-priming overhead of the OpenAI chat
 * format. Media parts (images, files) are not included.
 */
export function countMessagesTokens(messages: readonly ModelMessage[]): number {
  if (messages.length === 0) {
    return 0
  }
  return messages.reduce(
    (total, message) => total + countMessageTokens(message),
    REPLY_OVERHEAD_TOKENS,
  )
}
