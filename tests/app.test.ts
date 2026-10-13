import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Agent } from '../src/agent.js'
import { App, defaultDataDirectory, isReleaseBuild } from '../src/app.js'
import pino from 'pino'

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

const catalogWithGpt = {
  openai: { models: { 'gpt-6-astra': { limit: { context: 1_050_000, output: 128_000 } } } },
}

function textAgent(text: string): Agent {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: text },
          { type: 'text-end', id: 'text-1' },
          { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
        ],
      }),
    }),
  })
  return new Agent({ model })
}

function sink(): { stream: NodeJS.WritableStream; text: () => string } {
  let buffer = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += String(chunk)
      callback()
    },
  })
  return { stream, text: () => buffer }
}

function catalogResponse(body: unknown, status = 200): typeof globalThis.fetch {
  return async () => new Response(JSON.stringify(body), { status })
}

/** Logged texts: diagnostics now leave as JSON lines, so read the msg field. */
function messages(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { msg: string }).msg)
}

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'miniagent-app-'))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

describe('App', () => {
  it('lets the SDK handle a missing API key', async () => {
    const out = sink()
    const err = sink()

    const code = await new App({
      env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
      envFile: false,
      configFile: false,
      dataDirectory: directory,
      logger: pino({ level: 'info', base: undefined }, out.stream),
    }).run()

    expect(code).toBe(0)
    expect(err.text()).toBe('')
    const lines = messages(out.text())
    expect(lines[0]).toBe('loaded: deepseek, basic-tools')
    expect(lines[1]).toMatch(/^openai\/gpt-6-astra for session /)
  })

  it('builds the agent without an API key in the config file', async () => {
    const app = new App({
      env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
      envFile: false,
      configFile: false,
      dataDirectory: directory,
      logger: pino({ level: 'silent', base: undefined }, sink().stream),
    })

    const code = await app.run()

    expect(code).toBe(0)
    expect(app.agent).toBeDefined()
    expect(app.providerId).toBe('openai')
    expect(app.modelId).toBe('gpt-6-astra')
  })

  it('resolves configuration and uses the injected agent', async () => {
    const out = sink()
    const agent = textAgent('hi')
    const catalog = vi.fn(async () => {
      throw new Error('the override must not read the catalog')
    })
    vi.stubGlobal('fetch', catalog)
    const app = new App({
      prompt: 'what is 17 * 23?',
      env: { OPENAI_API_KEY: 'test', MINIAGENT_CONTEXT_WINDOW: '1000' },
      envFile: false,
      configFile: false,
      dataDirectory: directory,
      logger: pino({ level: 'info', base: undefined }, out.stream),
      agent,
    })

    const code = await app.run()

    expect(code).toBe(0)
    expect(app.agent).toBe(agent)
    expect(app.providerId).toBe('openai')
    expect(app.modelId).toBe('gpt-6-astra')
    expect(app.sessionId).toBeDefined()
    expect(app.sessionId).toBe(app.context?.id)
    expect(app.prompt).toBe('what is 17 * 23?')
    expect(app.context?.contextWindow).toBe(1000)
    expect(catalog).not.toHaveBeenCalled()
    expect(messages(out.text())).toEqual(['loaded: deepseek, basic-tools'])
  })

  it('honours OPENAI_MODEL and MINIAGENT_SESSION', async () => {
    const app = new App({
      env: {
        OPENAI_API_KEY: 'test',
        OPENAI_MODEL: 'gpt-5-nova',
        MINIAGENT_SESSION: 'work',
        MINIAGENT_CONTEXT_WINDOW: '1000',
      },
      envFile: false,
      configFile: false,
      dataDirectory: directory,
      logger: pino({ level: 'silent', base: undefined }, sink().stream),
      agent: textAgent('hi'),
    })

    const code = await app.run()

    expect(code).toBe(0)
    expect(app.modelId).toBe('gpt-5-nova')
    expect(app.sessionId).toBe('work')
    expect(app.context?.id).toBe('work')
    expect(app.prompt).toBeUndefined()
  })

  it('generates a session id when none is given', async () => {
    const app = new App({
      env: { OPENAI_API_KEY: 'test', MINIAGENT_CONTEXT_WINDOW: '1000' },
      envFile: false,
      configFile: false,
      dataDirectory: directory,
      logger: pino({ level: 'silent', base: undefined }, sink().stream),
      agent: textAgent('hi'),
    })

    const code = await app.run()

    expect(code).toBe(0)
    expect(app.sessionId).toBeDefined()
    expect(app.sessionId).toBe(app.context?.id)
    expect(app.sessionId).not.toHaveLength(0)
  })

  it('builds an agent from the provider when none is injected', async () => {
    const app = new App({
      prompt: 'hi',
      env: { OPENAI_API_KEY: 'test', MINIAGENT_CONTEXT_WINDOW: '1000' },
      envFile: false,
      configFile: false,
      dataDirectory: directory,
      logger: pino({ level: 'silent', base: undefined }, sink().stream),
    })

    const code = await app.run()

    expect(code).toBe(0)
    expect(app.agent).toBeInstanceOf(Agent)
    expect(app.prompt).toBe('hi')
  })

  it('reads the context window from the catalog when there is no override', async () => {
    const out = sink()
    vi.stubGlobal('fetch', catalogResponse(catalogWithGpt))
    const app = new App({
      env: { OPENAI_API_KEY: 'test' },
      envFile: false,
      configFile: false,
      logger: pino({ level: 'info', base: undefined }, out.stream),
      agent: textAgent('hi'),
      catalogUrl: 'https://example.test/app-one',
      dataDirectory: directory,
    })

    const code = await app.run()

    expect(code).toBe(0)
    expect(app.context?.contextWindow).toBe(1_050_000)
    expect(out.text()).toContain('openai/gpt-6-astra: 1,050,000 token context window')
  })

  it('resolves without a window when the catalog is unavailable', async () => {
    const out = sink()
    vi.stubGlobal('fetch', catalogResponse({ error: 'nope' }, 503))
    const app = new App({
      env: { OPENAI_API_KEY: 'test' },
      envFile: false,
      configFile: false,
      logger: pino({ level: 'info', base: undefined }, out.stream),
      agent: textAgent('hi'),
      catalogUrl: 'https://example.test/app-two',
      dataDirectory: directory,
    })

    const code = await app.run()

    expect(code).toBe(0)
    expect(app.context?.contextWindow).toBeUndefined()
    expect(out.text()).toContain('could not read model limits')
  })

  it('reports models the catalog does not list', async () => {
    const out = sink()
    vi.stubGlobal('fetch', catalogResponse({ openai: { models: {} } }))
    const app = new App({
      env: { OPENAI_API_KEY: 'test' },
      envFile: false,
      configFile: false,
      logger: pino({ level: 'info', base: undefined }, out.stream),
      agent: textAgent('hi'),
      catalogUrl: 'https://example.test/app-three',
      dataDirectory: directory,
    })

    const code = await app.run()

    expect(code).toBe(0)
    expect(app.context?.contextWindow).toBeUndefined()
    expect(messages(out.text()).join('\n')).toContain(
      'no context window in catalog for "gpt-6-astra"',
    )
  })

  it('ignores an invalid context window override and falls back to the catalog', async () => {
    const out = sink()
    vi.stubGlobal('fetch', catalogResponse(catalogWithGpt))
    const app = new App({
      env: { OPENAI_API_KEY: 'test', MINIAGENT_CONTEXT_WINDOW: 'nope' },
      envFile: false,
      configFile: false,
      logger: pino({ level: 'info', base: undefined }, out.stream),
      agent: textAgent('hi'),
      catalogUrl: 'https://example.test/app-four',
      dataDirectory: directory,
    })

    const code = await app.run()

    expect(code).toBe(0)
    expect(app.context?.contextWindow).toBe(1_050_000)
    expect(messages(out.text()).join('\n')).toContain(
      'ignoring invalid MINIAGENT_CONTEXT_WINDOW="nope"',
    )
  })
})

describe('App config file', () => {
  async function writeConfig(config: unknown): Promise<string> {
    const path = join(directory, 'config.json')
    await writeFile(path, JSON.stringify(config), 'utf8')
    return path
  }

  function app(options: Partial<ConstructorParameters<typeof App>[0]>, out = sink()): App {
    return new App({
      envFile: false,
      dataDirectory: directory,
      logger: pino({ level: 'info', base: undefined }, out.stream),
      agent: textAgent('hi'),
      ...options,
    })
  }

  it('takes the provider and model defaults from the file', async () => {
    const configFile = await writeConfig({ provider: 'openai', model: 'from-config' })

    const instance = app({
      configFile,
      env: { OPENAI_API_KEY: 'test', MINIAGENT_CONTEXT_WINDOW: '1000' },
    })
    const code = await instance.run()

    expect(code).toBe(0)
    expect(instance.providerId).toBe('openai')
    expect(instance.modelId).toBe('from-config')
  })

  it('lets the config model win over OPENAI_MODEL', async () => {
    const configFile = await writeConfig({ model: 'from-config' })

    const instance = app({
      configFile,
      env: { OPENAI_API_KEY: 'test', OPENAI_MODEL: 'from-env', MINIAGENT_CONTEXT_WINDOW: '1000' },
    })
    await instance.run()

    expect(instance.modelId).toBe('from-config')
  })

  it('uses an API key from the file when the environment has none', async () => {
    const configFile = await writeConfig({
      model: 'gpt-6-astra',
      providers: { openai: { apiKey: 'from-config' } },
    })

    const instance = app({ configFile, env: { MINIAGENT_CONTEXT_WINDOW: '1000' } })
    const code = await instance.run()

    expect(code).toBe(0)
    expect(instance.agent).toBeDefined()
  })

  it('boots without a configured API key and leaves the environment to the SDK', async () => {
    const configFile = await writeConfig({ model: 'gpt-6-astra' })

    const instance = app({
      configFile,
      env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
    })

    expect(await instance.run()).toBe(0)
  })

  it('reports an unreadable config file and keeps going', async () => {
    const configFile = join(directory, 'config.json')
    await writeFile(configFile, '{ not json', 'utf8')
    const out = sink()

    const instance = app(
      { configFile, env: { OPENAI_API_KEY: 'test', MINIAGENT_CONTEXT_WINDOW: '1000' } },
      out,
    )
    const code = await instance.run()

    expect(code).toBe(0)
    expect(out.text()).toContain(`could not read ${configFile}`)
  })

  it('rejects a provider it does not know when creating the client', async () => {
    const configFile = await writeConfig({ provider: 'who-knows' })
    const err = sink()

    const code = await new App({
      env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
      envFile: false,
      dataDirectory: directory,
      configFile,
      logger: pino({ level: 'info', base: undefined }, err.stream),
    }).run()

    expect(code).toBe(1)
    expect(messages(err.text()).join('\n')).toContain('Unknown provider "who-knows"')
    expect(messages(err.text()).join('\n')).toContain('openai, anthropic, google')
  })

  it('skips provider validation when the agent is injected', async () => {
    const configFile = await writeConfig({ provider: 'who-knows' })

    const code = await new App({
      env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
      envFile: false,
      dataDirectory: directory,
      configFile,
      logger: pino({ level: 'silent', base: undefined }, sink().stream),
      agent: textAgent('hi'),
    }).run()

    // No real model client is created, so there is nothing to validate.
    expect(code).toBe(0)
  })

  it('boots a configured id without a baseURL as OpenAI-compatible', async () => {
    const configFile = await writeConfig({
      provider: 'ollama',
      model: 'qwen3',
      providers: { ollama: { apiKey: 'x' } },
    })

    const code = await new App({
      env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
      envFile: false,
      dataDirectory: directory,
      configFile,
      logger: pino({ level: 'silent', base: undefined }, sink().stream),
      agent: textAgent('hi'),
    }).run()

    expect(code).toBe(0)
  })

  it('boots an OpenAI-compatible endpoint without an API key', async () => {
    const configFile = await writeConfig({
      provider: 'ollama',
      model: 'qwen3',
      providers: { ollama: { baseURL: 'http://localhost:11434/v1' } },
    })

    const code = await new App({
      env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
      envFile: false,
      dataDirectory: directory,
      configFile,
      logger: pino({ level: 'silent', base: undefined }, sink().stream),
    }).run()

    expect(code).toBe(0)
  })

  it('boots DeepSeek from the custom provider module', async () => {
    const configFile = await writeConfig({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      providers: { deepseek: { apiKey: 'x' } },
    })

    const code = await new App({
      env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
      envFile: false,
      dataDirectory: directory,
      configFile,
      logger: pino({ level: 'silent', base: undefined }, sink().stream),
      agent: textAgent('hi'),
    }).run()

    expect(code).toBe(0)
  })

  it('takes the API key from providers.<id>.apiKey', async () => {
    const configFile = await writeConfig({
      model: 'gpt-6-astra',
      providers: { openai: { apiKey: 'from-providers' } },
    })

    const instance = app({
      configFile,
      env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
    })

    expect(await instance.run()).toBe(0)
  })

  it('keeps the provider and model stored in the session', async () => {
    await mkdir(join(directory, 'contexts'), { recursive: true })
    await writeFile(
      join(directory, 'contexts', 'default.json'),
      JSON.stringify({ messages: [], providerId: 'openai', modelId: 'stored-model' }),
      'utf8',
    )
    const configFile = await writeConfig({ model: 'from-config' })

    const instance = app({
      configFile,
      env: {
        OPENAI_API_KEY: 'test',
        MINIAGENT_CONTEXT_WINDOW: '1000',
        MINIAGENT_SESSION: 'default',
      },
    })
    await instance.run()

    expect(instance.providerId).toBe('openai')
    expect(instance.modelId).toBe('stored-model')
  })
})

describe('App data directory', () => {
  it('treats a run from the sources as a development checkout', () => {
    expect(isReleaseBuild()).toBe(false)
    expect(defaultDataDirectory()).toBe('.miniagent')
  })

  it('stamps the package version into the build', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

    const app = new App({
      env: {},
      envFile: false,
      configFile: false,
      dataDirectory: directory,
      logger: pino({ level: 'silent', base: undefined }, sink().stream),
    })

    expect(app.version).toBe(pkg.version)
  })

  it('defaults the data directory to the checkout directory', () => {
    const app = new App({
      env: {},
      envFile: false,
      configFile: false,
      logger: pino({ level: 'silent', base: undefined }, sink().stream),
    })

    expect(app.dataDirectory).toBe('.miniagent')
  })

  it('takes an explicit data directory over the default', () => {
    const app = new App({
      env: {},
      envFile: false,
      configFile: false,
      dataDirectory: directory,
      logger: pino({ level: 'silent', base: undefined }, sink().stream),
    })

    expect(app.dataDirectory).toBe(directory)
  })
})

describe('App environment file', () => {
  const envKeys = ['OPENAI_API_KEY', 'OPENAI_MODEL', 'MINIAGENT_CONTEXT_WINDOW']

  async function withEnv(
    values: Partial<Record<string, string>>,
    body: () => Promise<void>,
  ): Promise<void> {
    const saved = new Map(envKeys.map((key) => [key, process.env[key]]))
    for (const key of envKeys) {
      const value = values[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    try {
      await body()
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  }

  it('merges .env from the configured path into the environment', async () => {
    const envFile = join(directory, '.env')
    await writeFile(envFile, 'OPENAI_API_KEY=from-dotenv\nOPENAI_MODEL=dotenv-model\n')

    await withEnv({ MINIAGENT_CONTEXT_WINDOW: '1000' }, async () => {
      const app = new App({
        envFile,
        configFile: false,
        dataDirectory: directory,
        logger: pino({ level: 'silent', base: undefined }, sink().stream),
        agent: textAgent('hi'),
      })

      const code = await app.run()

      expect(code).toBe(0)
      expect(app.modelId).toBe('dotenv-model')
      expect(process.env.OPENAI_MODEL).toBe('dotenv-model')
    })
  })

  it('keeps the values already present in the environment', async () => {
    const envFile = join(directory, '.env')
    await writeFile(envFile, 'OPENAI_MODEL=from-file\nOPENAI_API_KEY=from-file\n')

    await withEnv(
      { OPENAI_API_KEY: 'test', OPENAI_MODEL: 'from-env', MINIAGENT_CONTEXT_WINDOW: '1000' },
      async () => {
        const app = new App({
          envFile,
          configFile: false,
          dataDirectory: directory,
          logger: pino({ level: 'silent', base: undefined }, sink().stream),
          agent: textAgent('hi'),
        })

        const code = await app.run()

        expect(code).toBe(0)
        expect(app.modelId).toBe('from-env')
      },
    )
  })

  it('stays quiet when the environment file does not exist', async () => {
    const out = sink()
    const app = new App({
      env: { OPENAI_API_KEY: 'test', MINIAGENT_CONTEXT_WINDOW: '1000' },
      envFile: join(directory, 'missing.env'),
      configFile: false,
      dataDirectory: directory,
      logger: pino({ level: 'info', base: undefined }, out.stream),
      agent: textAgent('hi'),
    })

    const code = await app.run()

    expect(code).toBe(0)
    expect(out.text()).not.toContain('could not read')
  })

  it('reports an environment file it cannot read', async () => {
    const out = sink()
    const app = new App({
      env: { OPENAI_API_KEY: 'test', MINIAGENT_CONTEXT_WINDOW: '1000' },
      envFile: directory,
      configFile: false,
      dataDirectory: directory,
      logger: pino({ level: 'info', base: undefined }, out.stream),
      agent: textAgent('hi'),
    })

    const code = await app.run()

    expect(code).toBe(0)
    expect(out.text()).toContain(`could not read ${directory}`)
  })
})
