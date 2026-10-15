import type { LanguageModelUsage } from 'ai'

import type { AgentRunResult } from './types.js'

/** Zero usage for runs that never reached the model. */
export function emptyUsage(): LanguageModelUsage {
  return {
    inputTokens: 0,
    inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens: 0,
    outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
    totalTokens: 0,
  }
}

/** Blank result for runs that never reached the model. */
export function emptyResult(): AgentRunResult {
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
