import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../../src/app/config.js'

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

  it('reads provider, model and provider settings', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({
        provider: 'openai',
        model: 'gpt-6-astra',
        providers: { openai: { apiKey: 'sk-test' } },
      }),
      'utf8',
    )

    expect(await loadConfig(configPath())).toEqual({
      provider: 'openai',
      model: 'gpt-6-astra',
      providers: { openai: { apiKey: 'sk-test' } },
    })
  })

  it('keeps a partial file partial', async () => {
    await writeFile(configPath(), JSON.stringify({ model: 'gpt-6-astra' }), 'utf8')

    expect(await loadConfig(configPath())).toEqual({ provider: undefined, model: 'gpt-6-astra' })
  })

  it('drops fields of the wrong type', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({
        provider: 7,
        model: '',
        providers: { openai: 3, xai: { apiKey: 'x' } },
      }),
      'utf8',
    )

    expect(await loadConfig(configPath())).toEqual({
      provider: undefined,
      model: undefined,
      providers: { xai: { apiKey: 'x' } },
    })
  })

  it('reads provider endpoints and inline keys', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({
        providers: {
          ollama: { baseURL: 'http://localhost:11434/v1' },
          openai: { apiKey: 'sk-inline' },
        },
      }),
      'utf8',
    )

    expect(await loadConfig(configPath())).toEqual({
      providers: {
        ollama: { baseURL: 'http://localhost:11434/v1' },
        openai: { apiKey: 'sk-inline' },
      },
    })
  })

  it('drops provider entries that configure nothing', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({ providers: { ollama: 7, empty: {}, good: { baseURL: 'http://x/v1' } } }),
      'utf8',
    )

    expect(await loadConfig(configPath())).toEqual({
      providers: { good: { baseURL: 'http://x/v1' } },
    })
  })

  it('reads plugins, tools, and pluginConfig', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({
        plugins: ['./plugins/my-tools.js', 'miniagent-plugin-foo', '', 7],
        tools: { read: { enabled: false }, other: { enabled: true }, bad: 7 },
        pluginConfig: { 'my-tools': { verbose: true } },
      }),
      'utf8',
    )

    expect(await loadConfig(configPath())).toEqual({
      plugins: ['./plugins/my-tools.js', 'miniagent-plugin-foo'],
      tools: { read: { enabled: false }, other: { enabled: true } },
      pluginConfig: { 'my-tools': { verbose: true } },
    })
  })

  it('drops empty plugin, tool, and pluginConfig blocks', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({ plugins: [], tools: {}, pluginConfig: {} }),
      'utf8',
    )

    expect(await loadConfig(configPath())).toEqual({})
  })

  it('throws on a non-object document', async () => {
    await writeFile(configPath(), JSON.stringify(['nope']), 'utf8')

    await expect(loadConfig(configPath())).rejects.toThrow(/expected object/i)
  })

  it('throws on invalid JSON', async () => {
    await writeFile(configPath(), '{ not json', 'utf8')

    await expect(loadConfig(configPath())).rejects.toThrow(/invalid JSON/)
  })

  it('keeps a tool entry without an explicit flag as enabled', async () => {
    await writeFile(configPath(), JSON.stringify({ tools: { read: {} } }), 'utf8')

    expect(await loadConfig(configPath())).toEqual({ tools: { read: {} } })
  })
})
