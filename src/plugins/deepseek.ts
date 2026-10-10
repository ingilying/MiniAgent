import { createDeepSeek } from '@ai-sdk/deepseek'
import type { Provider } from 'ai'

import type { ProviderOptions } from '../providers.js'

import type { Plugin } from './types.js'

/**
 * DeepSeek provider: the official AI SDK DeepSeek provider over the
 * DeepSeek API. Models: `deepseek-v4-flash` and `deepseek-v4-pro`. A missing
 * API key falls back to the `DEEPSEEK_API_KEY` environment variable inside
 * the SDK; `baseURL` overrides the DeepSeek endpoint.
 */
export function deepseekProvider(options: ProviderOptions): Provider {
  return createDeepSeek({ apiKey: options.apiKey, baseURL: options.baseURL })
}

/** DeepSeek provider plugin: registers `deepseek` before config applies. */
export const deepseekPlugin: Plugin = {
  name: 'deepseek',
  onProvidersCreating: (providers) => {
    providers.add('deepseek', deepseekProvider)
  },
}
