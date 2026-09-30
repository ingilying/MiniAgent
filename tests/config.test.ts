import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.js'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'miniagent-config-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function configPath(): string {
  return join(directory, 'config.json')
}

describe('loadConfig', () => {
  it('returns an empty config when the file is missing', async () => {
    expect(await loadConfig(configPath())).toEqual({})
  })

  it('reads provider, model and api keys', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({
        provider: 'openai',
        model: 'gpt-6-astra',
        apiKeys: { openai: 'sk-test' },
      }),
      'utf8',
    )

    expect(await loadConfig(configPath())).toEqual({
      provider: 'openai',
      model: 'gpt-6-astra',
      apiKeys: { openai: 'sk-test' },
    })
  })

  it('keeps a partial file partial', async () => {
    await writeFile(configPath(), JSON.stringify({ model: 'gpt-6-astra' }), 'utf8')

    expect(await loadConfig(configPath())).toEqual({ provider: undefined, model: 'gpt-6-astra' })
  })

  it('drops fields of the wrong type', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({ provider: 7, model: '', apiKeys: { openai: 3, xai: 'x' } }),
      'utf8',
    )

    expect(await loadConfig(configPath())).toEqual({
      provider: undefined,
      model: undefined,
      apiKeys: { xai: 'x' },
    })
  })

  it('reads provider endpoints and inline keys', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({
        providers: {
          ollama: { baseUrl: 'http://localhost:11434/v1' },
          openai: { apiKey: 'sk-inline' },
        },
      }),
      'utf8',
    )

    expect(await loadConfig(configPath())).toEqual({
      providers: {
        ollama: { baseUrl: 'http://localhost:11434/v1' },
        openai: { apiKey: 'sk-inline' },
      },
    })
  })

  it('drops provider entries that configure nothing', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({ providers: { ollama: 7, empty: {}, good: { baseUrl: 'http://x/v1' } } }),
      'utf8',
    )

    expect(await loadConfig(configPath())).toEqual({
      providers: { good: { baseUrl: 'http://x/v1' } },
    })
  })

  it('ignores a non-object document', async () => {
    await writeFile(configPath(), JSON.stringify(['nope']), 'utf8')

    expect(await loadConfig(configPath())).toEqual({})
  })

  it('throws on invalid JSON', async () => {
    await writeFile(configPath(), '{ not json', 'utf8')

    await expect(loadConfig(configPath())).rejects.toThrow(/invalid JSON/)
  })
})
