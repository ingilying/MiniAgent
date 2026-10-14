import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Agent } from '../src/agent.js'
import { App } from '../src/app.js'
import { loadPlugins } from '../src/plugins/loader.js'
import { readTool } from '../src/plugins/basic-tools/read.js'
import pino from 'pino'

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

/** Logged texts: diagnostics now leave as JSON lines, so read the msg field. */
function messages(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { msg: string }).msg)
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
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
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

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'miniagent-plugins-'))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

function appWithConfig(config: unknown, err = sink()): App {
  return new App({
    env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
    envFile: false,
    configFile: false,
    dataDirectory: directory,
    logger: pino({ level: 'info', base: undefined }, err.stream),
    agent: textAgent('hi'),
  })
}

async function writeConfigFile(config: unknown): Promise<string> {
  const path = join(directory, 'config.json')
  await writeFile(path, JSON.stringify(config), 'utf8')
  return path
}

function appFromFile(configFile: string, err = sink()): App {
  return new App({
    env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
    envFile: false,
    configFile,
    dataDirectory: directory,
    logger: pino({ level: 'info', base: undefined }, err.stream),
  })
}

describe('loadPlugins', () => {
  it('loads plugins in order and keeps later overrides', async () => {
    await writeFile(
      join(directory, 'first.mjs'),
      `export default { name: 'first', setup(host) { host.tools.marker = 'first'; } };`,
      'utf8',
    )
    await writeFile(
      join(directory, 'second.mjs'),
      `export default { name: 'second', setup(host) { host.tools.marker = 'second'; } };`,
      'utf8',
    )

    const [a, b] = await loadPlugins(['./first.mjs', './second.mjs'], directory)

    expect(a?.name).toBe('first')
    expect(b?.name).toBe('second')
  })

  it('rejects a module with no methods', async () => {
    await writeFile(join(directory, 'empty.mjs'), `export default { name: 'empty' };`, 'utf8')

    await expect(loadPlugins(['./empty.mjs'], directory)).rejects.toThrow(
      /Plugin ".\/empty.mjs" failed to load: plugin "empty" implements no methods/,
    )
  })

  it('accepts a plugin with only a run method', async () => {
    await writeFile(
      join(directory, 'ui-only.mjs'),
      `export default { name: 'ui-only', async run() {} };`,
      'utf8',
    )

    const [plugin] = await loadPlugins(['./ui-only.mjs'], directory)

    expect(plugin?.name).toBe('ui-only')
  })

  it('rejects a module with no name', async () => {
    await writeFile(join(directory, 'nameless.mjs'), `export default { setup() {} };`, 'utf8')

    await expect(loadPlugins(['./nameless.mjs'], directory)).rejects.toThrow(
      /non-empty string "name"/,
    )
  })

  it('reports a missing file with the specifier', async () => {
    await expect(loadPlugins(['./missing.mjs'], directory)).rejects.toThrow(
      /Plugin ".\/missing.mjs" failed to load/,
    )
  })

  it('loads a project directory plugin by asking it for a Plugin instance', async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(directory, 'proj'), { recursive: true })
    await writeFile(
      join(directory, 'proj', 'package.json'),
      JSON.stringify({ type: 'module', main: './index.mjs' }),
      'utf8',
    )
    await writeFile(
      join(directory, 'proj', 'index.mjs'),
      `export default class MyPlugin {
        name = 'proj-plugin';
        setup(host) { host.tools.fromProject = 'yes'; }
      };`,
      'utf8',
    )

    const [plugin] = await loadPlugins(['./proj'], directory)

    expect(plugin?.name).toBe('proj-plugin')
  })

  it('loads a local file: package specifier', async () => {
    await writeFile(
      join(directory, 'local.mjs'),
      `export const plugin = { name: 'local', setup() {} };`,
      'utf8',
    )

    const [plugin] = await loadPlugins(['file:./local.mjs'], directory)

    expect(plugin?.name).toBe('local')
  })

  it('calls a factory export to get the Plugin instance', async () => {
    await writeFile(
      join(directory, 'factory.mjs'),
      `export default () => ({ name: 'factory', setup() {} });`,
      'utf8',
    )

    const [plugin] = await loadPlugins(['./factory.mjs'], directory)

    expect(plugin?.name).toBe('factory')
  })
})

describe('App plugins', () => {
  it('merges tool and prompt from a plugin', async () => {
    await writeFile(
      join(directory, 'greeter.mjs'),
      `export default {
        name: 'greeter',
        setup(host) { host.tools.read = undefined; host.tools.added = { kind: 'stub' }; host.systemPromptParts.push('Be brief.'); },
      };`,
      'utf8',
    )
    const configFile = await writeConfigFile({ plugins: ['./greeter.mjs'] })

    const app = appFromFile(configFile)
    const code = await app.run()

    expect(code).toBe(0)
    expect(app.tools.added).toBeDefined()
    expect(app.tools.read).toBeUndefined()
    expect(app.systemPromptParts).toContain('Be brief.')
    expect(app.plugins.map((plugin) => plugin.name)).toContain('greeter')
  })

  it('lets the config disable a basic tool', async () => {
    const configFile = await writeConfigFile({ tools: { read: { enabled: false } } })

    const app = appFromFile(configFile)
    const code = await app.run()

    expect(code).toBe(0)
    expect(app.tools.read).toBeUndefined()
    expect(app.tools.write).toBeDefined()
  })

  it('calls onProvidersCreating before settings apply', async () => {
    await writeFile(
      join(directory, 'mine.mjs'),
      `import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
       export default {
        name: 'mine',
        seen: undefined,
        onProvidersCreating(providers, config) {
          globalThis.__mineTag = config?.tag;
          providers.add('mine', (options) =>
            createOpenAICompatible({
              name: 'mine',
              apiKey: options.apiKey ?? 'x',
              baseURL: options.baseURL ?? 'http://localhost:11434/v1',
            }),
          );
        },
      };`,
      'utf8',
    )
    const configFile = await writeConfigFile({
      provider: 'mine',
      model: 'qwen3',
      plugins: ['./mine.mjs'],
      pluginConfig: { mine: { tag: 'hello' } },
    })

    const app = appFromFile(configFile)
    const code = await app.run()

    expect(code).toBe(0)
    expect(Object.keys(app.providers?.registry.providers ?? {})).toContain('mine')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).__mineTag).toBe('hello')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__mineTag
  })

  it('passes pluginConfig to setup', async () => {
    await writeFile(
      join(directory, 'cfg.mjs'),
      `export default {
        name: 'cfg',
        setup(host, config) { host.systemPromptParts.push('tag:' + config.tag); },
      };`,
      'utf8',
    )
    const configFile = await writeConfigFile({
      plugins: ['./cfg.mjs'],
      pluginConfig: { cfg: { tag: 'v1' } },
    })

    const app = appFromFile(configFile)
    await app.run()

    expect(app.systemPromptParts).toContain('tag:v1')
  })

  it('fails fast when a plugin file is missing', async () => {
    const err = sink()
    const configFile = await writeConfigFile({ plugins: ['./missing.mjs'] })

    const code = await appFromFile(configFile, err).run()

    expect(code).toBe(1)
    expect(messages(err.text()).join('\n')).toContain('Plugin "./missing.mjs" failed')
  })

  it('fails fast when setup throws, naming the plugin', async () => {
    await writeFile(
      join(directory, 'boom.mjs'),
      `export default { name: 'boom', setup() { throw new Error('kaput'); } };`,
      'utf8',
    )
    const err = sink()
    const configFile = await writeConfigFile({ plugins: ['./boom.mjs'] })

    const code = await appFromFile(configFile, err).run()

    expect(code).toBe(1)
    expect(messages(err.text()).join('\n')).toContain('Plugin "boom" failed: kaput')
  })

  it('keeps built-in tools and prompt with no plugins', async () => {
    const configFile = await writeConfigFile({})

    const app = appFromFile(configFile)
    const code = await app.run()

    expect(code).toBe(0)
    expect(app.tools.read).toBe(readTool)
    expect(app.tools.write).toBeDefined()
    expect(app.tools.edit).toBeDefined()
    expect(app.tools.shell).toBeDefined()
    expect(app.systemPromptParts[0]).toContain('precise, helpful assistant')
    expect(app.agent?.system).toContain('precise, helpful assistant')
  })
})

describe('App plugin run', () => {
  it('starts all run methods concurrently with the built agent', async () => {
    await writeFile(
      join(directory, 'ui-a.mjs'),
      `export default {
        name: 'ui-a',
        async run(host) {
          globalThis.__runOrder.push('a:start');
          await new Promise((resolve) => setTimeout(resolve, 10));
          globalThis.__runOrder.push('a:end');
          globalThis.__runSawAgent = host.agent !== undefined && host.context !== undefined;
        },
      };`,
      'utf8',
    )
    await writeFile(
      join(directory, 'ui-b.mjs'),
      `export default {
        name: 'ui-b',
        async run() {
          globalThis.__runOrder.push('b:start');
          await new Promise((resolve) => setTimeout(resolve, 10));
          globalThis.__runOrder.push('b:end');
        },
      };`,
      'utf8',
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).__runOrder = []
    const configFile = await writeConfigFile({ plugins: ['./ui-a.mjs', './ui-b.mjs'] })

    const code = await appFromFile(configFile).run()

    expect(code).toBe(0)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const order = (globalThis as any).__runOrder as string[]
    expect(order.slice(0, 2).sort()).toEqual(['a:start', 'b:start'])
    expect(order.slice(2).sort()).toEqual(['a:end', 'b:end'])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).__runSawAgent).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__runOrder
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__runSawAgent
  })

  it('passes identity and tools to run', async () => {
    await writeFile(
      join(directory, 'spy.mjs'),
      `export default {
        name: 'spy',
        async run(host, config) {
          globalThis.__runHost = {
            sessionId: host.sessionId,
            providerId: host.providerId,
            modelId: host.modelId,
            hasRead: host.tools.read !== undefined,
            tag: config?.tag,
          };
        },
      };`,
      'utf8',
    )
    const configFile = await writeConfigFile({
      plugins: ['./spy.mjs'],
      pluginConfig: { spy: { tag: 'v1' } },
    })
    const app = new App({
      env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
      envFile: false,
      configFile,
      dataDirectory: directory,
      logger: pino({ level: 'info', base: undefined }, sink().stream),
      agent: textAgent('hi'),
    })

    expect(await app.run()).toBe(0)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seen = (globalThis as any).__runHost
    expect(seen).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-6-astra',
      hasRead: true,
      tag: 'v1',
    })
    expect(typeof seen.sessionId).toBe('string')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__runHost
  })

  it('switchModel swaps the session agent and persists the model', async () => {
    await writeFile(
      join(directory, 'switcher.mjs'),
      `export default {
        name: 'switcher',
        async run(host) {
          const before = host.agent;
          const switched = await host.switchModel(host.context, 'openai', 'switched-model');
          globalThis.__switched = {
            providerId: switched.providerId,
            modelId: switched.modelId,
            window: switched.contextWindow,
            contextModel: host.context.modelId,
            agentSwapped: host.agents.get(host.context.id) !== before,
            agentMatches: host.agents.get(host.context.id) === switched.agent,
          };
        },
      };`,
      'utf8',
    )
    const configFile = await writeConfigFile({ plugins: ['./switcher.mjs'] })

    expect(await appFromFile(configFile).run()).toBe(0)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const switched = (globalThis as any).__switched
    expect(switched).toMatchObject({
      providerId: 'openai',
      modelId: 'switched-model',
      window: 1000,
      contextModel: 'switched-model',
      agentSwapped: true,
      agentMatches: true,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__switched
  })

  it('fails fast when run throws, naming the plugin', async () => {
    await writeFile(
      join(directory, 'ui-down.mjs'),
      `export default { name: 'ui-down', async run() { throw new Error('ui-down'); } };`,
      'utf8',
    )
    const err = sink()
    const configFile = await writeConfigFile({ plugins: ['./ui-down.mjs'] })

    const code = await appFromFile(configFile, err).run()

    expect(code).toBe(1)
    expect(messages(err.text()).join('\n')).toContain('Plugin "ui-down" failed: ui-down')
  })

  it('hands plugins a plugin-module logger', async () => {
    await writeFile(
      join(directory, 'mod.mjs'),
      `export default { name: 'mod', setup(host) { globalThis.__modBinding = host.logger.bindings(); } };`,
      'utf8',
    )
    const configFile = await writeConfigFile({ plugins: ['./mod.mjs'] })

    expect(await appFromFile(configFile).run()).toBe(0)

    expect((globalThis as Record<string, unknown>).__modBinding).toMatchObject({
      module: 'plugin',
    })
    delete (globalThis as Record<string, unknown>).__modBinding
  })

  it('stays headless with no run methods', async () => {
    const configFile = await writeConfigFile({})

    expect(await appFromFile(configFile).run()).toBe(0)
  })
})

void appWithConfig
