import { NoSuchProviderError, createProviderRegistry } from 'ai'
import type { LanguageModel, Provider } from 'ai'

import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

/** Per-provider settings from the config file. */
export interface ProviderOptions {
  /** API key for this provider, when the config file has one. */
  readonly apiKey?: string
  /** Custom endpoint: an OpenAI-compatible server or a provider proxy. */
  readonly baseURL?: string
}

/** What a caller knows about a provider beyond the models.dev catalog. */
export interface ProviderExtras {
  /**
   * Model ids this provider serves. The catalog only lists the providers it
   * ships entries for, so a custom provider declares its models here to
   * reach model completion and `/models`.
   */
  readonly models?: readonly string[]
}

/**
 * The app's view of the AI SDK provider registry: the store of loaded
 * providers. `providers` and `registerProvider` are untyped but public at
 * runtime: `createProviderRegistry` builds on exactly this surface
 * (ai/dist/index.js).
 */
export interface ProviderRegistry {
  /** Registered providers by id. The registry's own store. */
  readonly providers: Record<string, Provider>
  registerProvider(args: { id: string; provider: Provider }): void
  getProvider(id: string, modelType: string): Provider
  languageModel(id: string): LanguageModel
}

/**
 * A loaded provider set. The AI SDK provider registry stores the providers;
 * a table of provider id and create function keeps each provider's module, so
 * the config can initialise a provider with settings.
 */
export class Providers {
  /** The AI SDK provider registry holding the loaded providers. */
  readonly registry: ProviderRegistry

  /** The provider id and its create function for every loaded provider. */
  private readonly creators = new Map<string, (options: ProviderOptions) => Provider>()

  /** The model ids each provider declared through `add`. */
  private readonly declared = new Map<string, readonly string[]>()

  constructor() {
    this.registry = makeRegistry()
    this.add('openai', ({ apiKey, baseURL }) => createOpenAI({ apiKey, baseURL }))
    this.add('anthropic', ({ apiKey, baseURL }) => createAnthropic({ apiKey, baseURL }))
    this.add('google', ({ apiKey, baseURL }) => createGoogle({ apiKey, baseURL }))
  }

  /** Adds one provider under the given id: its create function and a first provider at default settings. Wins over a provider already loaded under the id. */
  add(
    id: string,
    create: (options: ProviderOptions) => Provider,
    extras: ProviderExtras = {},
  ): void {
    validateId(id)
    this.creators.set(id, create)
    if (extras.models !== undefined) {
      this.declared.set(id, [...extras.models])
    }
    this.insert(id, create({}))
  }

  /**
   * Applies the config file's provider settings. For each entry, finds the
   * provider under the same id, removes it, initialises it with the settings,
   * and inserts it back into the registry. An id without a create function
   * becomes an OpenAI-compatible provider from its settings.
   */
  loadConfig(settings: Readonly<Record<string, ProviderOptions>> = {}): void {
    for (const [id, options] of Object.entries(settings)) {
      validateId(id)
      validateBaseURL(id, options)
      const create = this.creators.get(id)
      this.insert(
        id,
        create !== undefined
          ? create(options)
          : createOpenAICompatible({
              name: id,
              apiKey: options.apiKey,
              // The SDK requires a URL; an absent baseURL stays empty and
              // fails at request time like any other missing setting.
              baseURL: options.baseURL ?? '',
            }),
      )
    }
  }

  /** Ids of the loaded providers, sorted. The set a model may be switched to. */
  ids(): string[] {
    return Object.keys(this.registry.providers).sort()
  }

  /**
   * Provider-qualified model ids the callers declared through `add`, sorted.
   * They supplement the catalog, which cannot list a custom provider.
   */
  declaredModels(): string[] {
    return [...this.declared]
      .flatMap(([id, models]) => models.map((model) => `${id}/${model}`))
      .sort()
  }

  /** Builds the model for one provider id and model id. Throws `NoSuchProviderError` for a provider id that is not loaded. */
  createModel(providerId: string, modelId: string): LanguageModel {
    if (!Object.hasOwn(this.registry.providers, providerId)) {
      throw new NoSuchProviderError({
        providerId,
        modelId,
        modelType: 'languageModel',
        availableProviders: Object.keys(this.registry.providers),
      })
    }
    return this.registry.languageModel(`${providerId}:${modelId}`)
  }

  /** Replaces the provider under one id in the registry: remove, then insert. */
  private insert(id: string, provider: Provider): void {
    const previous = this.registry.providers[id]
    delete this.registry.providers[id]
    try {
      this.registry.registerProvider({ id, provider })
    } catch (error) {
      // Never leave the id empty: put the previous provider back, if any.
      if (previous !== undefined) {
        this.registry.registerProvider({ id, provider: previous })
      }
      throw error
    }
  }
}

/** Loads the provider set: the built-in providers at AI SDK defaults. */
export function loadProviders(): Providers {
  return new Providers()
}

/**
 * Creates the AI SDK provider registry that stores the loaded providers, so
 * model creation and its errors come from the SDK.
 */
function makeRegistry(): ProviderRegistry {
  return createProviderRegistry({}) as unknown as ProviderRegistry
}

function validateId(id: string): void {
  if (id === '' || RESERVED_IDS.has(id)) {
    throw new Error(`Invalid provider id "${id}" in the config file.`)
  }
}

function validateBaseURL(id: string, options: ProviderOptions): void {
  if (options.baseURL === undefined) {
    return
  }
  try {
    new URL(options.baseURL)
  } catch {
    throw new Error(`Invalid baseURL for provider "${id}": "${options.baseURL}".`)
  }
}

/** Provider ids a config entry may not use: they would shadow object internals. */
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype'])
