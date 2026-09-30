import { NoSuchProviderError } from 'ai'
import type { LanguageModel } from 'ai'

import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

/** Per-provider settings from config.json and the environment. */
export interface ProviderOptions {
  /** API key for this provider, when the caller resolved one. */
  readonly apiKey?: string
  /** Custom endpoint: an OpenAI-compatible server or a provider proxy. */
  readonly baseUrl?: string
}

/** A provider client: enough to ask it for a language model. */
type AiProvider = { languageModel(modelId: string): LanguageModel }

/** One built-in provider: its key env var and how to build its client. */
interface BuiltIn {
  /** Environment variable holding the API key when config.json does not. */
  readonly envVar: string
  /** Builds the AI SDK provider from the resolved options. */
  create(options: ProviderOptions): AiProvider
}

/**
 * Built-in providers, keyed by the id used in config.json and in the session
 * snapshot. Adding a provider is one entry here. An id with a `baseUrl` that
 * is not listed becomes an OpenAI-compatible provider instead.
 */
const BUILT_IN: Readonly<Record<string, BuiltIn>> = {
  openai: {
    envVar: 'OPENAI_API_KEY',
    create: ({ apiKey, baseUrl }) => createOpenAI({ apiKey, baseURL: baseUrl }),
  },
  anthropic: {
    envVar: 'ANTHROPIC_API_KEY',
    create: ({ apiKey, baseUrl }) => createAnthropic({ apiKey, baseURL: baseUrl }),
  },
  google: {
    envVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
    create: ({ apiKey, baseUrl }) => createGoogle({ apiKey, baseURL: baseUrl }),
  },
}

let providers = buildProviders({})

/**
 * Replaces the provider set with one built from the settings: the built-ins
 * with their resolved key and `baseUrl`, plus any configured OpenAI-compatible
 * endpoint.
 */
export function loadSettings(next: Readonly<Record<string, ProviderOptions>> = {}): void {
  providers = buildProviders(next)
}

/**
 * Builds the model for one provider id and model id. Throws
 * `NoSuchProviderError` for a provider id that is not loaded.
 */
export function createModel(providerId: string, modelId: string): LanguageModel {
  const provider = providers[providerId]
  if (provider === undefined) {
    throw new NoSuchProviderError({
      providerId,
      modelId,
      modelType: 'languageModel',
      availableProviders: providerList(),
    })
  }
  return provider.languageModel(modelId)
}

/** Provider ids currently loaded: the built-ins plus configured extras. */
export function providerList(): string[] {
  return Object.keys(providers)
}

/** Environment variable that can hold the API key for a built-in provider. */
export function providerEnvVar(providerId: string): string | undefined {
  return BUILT_IN[providerId]?.envVar
}

function buildProviders(
  settings: Readonly<Record<string, ProviderOptions>>,
): Record<string, AiProvider> {
  const all: Record<string, AiProvider> = {}
  for (const [id, definition] of Object.entries(BUILT_IN)) {
    all[id] = definition.create(settings[id] ?? {})
  }
  for (const [id, options] of Object.entries(settings)) {
    if (all[id] === undefined && options.baseUrl !== undefined) {
      all[id] = createOpenAICompatible({
        name: id,
        apiKey: options.apiKey,
        baseURL: options.baseUrl,
      })
    }
  }
  return all
}
