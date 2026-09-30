import { NoSuchProviderError } from 'ai'
import { describe, expect, it } from 'vitest'

import {
  createModel,
  loadSettings,
  providerEnvVar,
  providerList,
} from '../src/providers.js'

describe('provider registry', () => {
  it('lists the built-in providers', () => {
    loadSettings()

    expect(providerList()).toEqual(['openai', 'anthropic', 'google'])
  })

  it('adds configured endpoints to the registry', () => {
    loadSettings({ ollama: { baseUrl: 'http://localhost:11434/v1' } })

    expect(providerList()).toEqual(['openai', 'anthropic', 'google', 'ollama'])
  })

  it('does not add a configured id without a baseUrl', () => {
    loadSettings({ ollama: { apiKey: 'x' } })

    expect(providerList()).toEqual(['openai', 'anthropic', 'google'])
  })

  it('reports the API key environment variable', () => {
    expect(providerEnvVar('openai')).toBe('OPENAI_API_KEY')
    expect(providerEnvVar('anthropic')).toBe('ANTHROPIC_API_KEY')
    expect(providerEnvVar('google')).toBe('GOOGLE_GENERATIVE_AI_API_KEY')
    expect(providerEnvVar('who-knows')).toBeUndefined()
  })

  it('builds a model for a built-in provider', () => {
    loadSettings({ openai: { apiKey: 'test' } })

    const model = createModel('openai', 'gpt-6-astra')

    expect(typeof model).toBe('object')
    expect(model).not.toBeNull()
  })

  it('builds a model for an OpenAI-compatible endpoint', () => {
    loadSettings({ ollama: { baseUrl: 'http://localhost:11434/v1' } })

    const model = createModel('ollama', 'qwen3')

    expect(typeof model).toBe('object')
    expect(model).not.toBeNull()
  })

  it('throws for an unknown provider', () => {
    loadSettings()

    expect(() => createModel('who-knows', 'model')).toThrow(NoSuchProviderError)
  })
})
