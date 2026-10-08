import { customProvider, NoSuchModelError, NoSuchProviderError } from 'ai'
import type { Provider } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { deepseekProvider } from '../src/deepseek.js'
import { loadProviders } from '../src/providers.js'

const BUILT_IN_IDS = ['openai', 'anthropic', 'google']

function stubProvider(): Provider {
  const model = new MockLanguageModelV4({})
  return customProvider({ languageModels: { 'stub-model': model } })
}

describe('provider registry', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads the built-in providers at AI SDK defaults', () => {
    expect(Object.keys(loadProviders().registry.providers)).toEqual(BUILT_IN_IDS)
  })

  it('adds configured endpoints from the config', () => {
    const providers = loadProviders()

    providers.loadConfig({ ollama: { baseURL: 'http://localhost:11434/v1' } })

    expect(Object.keys(providers.registry.providers)).toEqual([...BUILT_IN_IDS, 'ollama'])
  })

  it('initialises a built-in with its config', () => {
    const providers = loadProviders()

    providers.loadConfig({ openai: { apiKey: 'test', baseURL: 'http://x/v1' } })

    expect(() => providers.createModel('openai', 'gpt-6-astra')).not.toThrow()
  })

  it('initialises a custom provider with its config through its create function', () => {
    const create = vi.fn(() => stubProvider())
    const providers = loadProviders()
    providers.add('mylab', create)

    providers.loadConfig({ mylab: { apiKey: 'from-config' } })

    expect(create).toHaveBeenCalledWith({ apiKey: 'from-config' })
    expect(() => providers.createModel('mylab', 'stub-model')).not.toThrow()
  })

  it('builds an OpenAI-compatible provider for an unknown id without a baseURL', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const providers = loadProviders()

    providers.loadConfig({ mylab: { apiKey: 'x' } })

    expect(Object.keys(providers.registry.providers)).toEqual([...BUILT_IN_IDS, 'mylab'])
    expect(() => providers.createModel('mylab', 'qwen3')).not.toThrow()
    expect(warn).not.toHaveBeenCalled()
  })

  it('rejects a reserved provider id', () => {
    const providers = loadProviders()
    const fromJson = JSON.parse('{"__proto__": {"baseURL": "http://x/v1"}}')

    expect(() => providers.loadConfig(fromJson)).toThrow(/Invalid provider id/)
    expect(() => providers.loadConfig({ constructor: { baseURL: 'http://x/v1' } })).toThrow(
      /Invalid provider id/,
    )
    expect(() => providers.add('__proto__', () => stubProvider())).toThrow(/Invalid provider id/)
  })

  it('rejects an unparseable baseURL', () => {
    const providers = loadProviders()

    expect(() => providers.loadConfig({ ollama: { baseURL: 'not a url' } })).toThrow(
      /Invalid baseURL for provider "ollama"/,
    )
  })

  it('builds a model for a built-in provider', () => {
    const model = loadProviders().createModel('openai', 'gpt-6-astra')

    expect(typeof model).toBe('object')
    expect(model).not.toBeNull()
  })

  it('lets a custom module take over its config id', () => {
    const providers = loadProviders()
    providers.add('deepseek', deepseekProvider)

    providers.loadConfig({ deepseek: { apiKey: 'x' } })
    const model = providers.createModel('deepseek', 'deepseek-v4-flash')

    expect(typeof model).toBe('object')
    expect(model).not.toBeNull()
  })

  it('registers a custom provider module', () => {
    const providers = loadProviders()

    providers.add('mylab', () => stubProvider())

    expect(() => providers.createModel('mylab', 'stub-model')).not.toThrow()
    expect(() => providers.createModel('mylab', 'other-model')).toThrow(NoSuchModelError)
  })

  it('lets add win over a registered provider', () => {
    const providers = loadProviders()

    providers.add('openai', () => stubProvider())

    expect(() => providers.createModel('openai', 'stub-model')).not.toThrow()
    expect(() => providers.createModel('openai', 'gpt-6-astra')).toThrow(NoSuchModelError)
  })

  it('throws NoSuchProviderError for an unknown provider', () => {
    expect(() => loadProviders().createModel('who-knows', 'model')).toThrow(NoSuchProviderError)
  })

  it('throws NoSuchProviderError for an inherited object key', () => {
    const providers = loadProviders()

    expect(() => providers.createModel('toString', 'model')).toThrow(NoSuchProviderError)
    expect(() => providers.createModel('constructor', 'model')).toThrow(NoSuchProviderError)
  })
})
