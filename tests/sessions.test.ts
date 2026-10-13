import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'

import { Agent } from '../src/agent.js'
import { App } from '../src/app.js'
import { Context } from '../src/context.js'
import pino from 'pino'
import type { Providers } from '../src/providers.js'
import { SessionManager } from '../src/sessions.js'
import { FileContextStore } from '../src/store.js'

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

let root: string
let dataDirectory: string
let projectA: string
let projectB: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'miniagent-sessions-'))
  dataDirectory = join(root, 'data')
  projectA = join(root, 'project-a')
  projectB = join(root, 'project-b')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function managerFor(cwd: string): Promise<SessionManager> {
  return SessionManager.create({
    store: new FileContextStore(join(dataDirectory, 'contexts')),
    dataDirectory,
    cwd,
    env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
  })
}

/** A model that answers with the last user text, so replies stay routable. */
function echoModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: (options) => {
      const text = `echo: ${lastUserText(options.prompt)}`
      return Promise.resolve({
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      })
    },
  })
}

function lastUserText(prompt: unknown): string {
  if (!Array.isArray(prompt)) {
    return '?'
  }
  for (let index = prompt.length - 1; index >= 0; index--) {
    const message = prompt[index] as { role?: unknown; content?: unknown }
    if (message?.role !== 'user') {
      continue
    }
    if (typeof message.content === 'string') {
      return message.content
    }
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter(
          (part): part is { type: unknown; text?: unknown } =>
            typeof part === 'object' && part !== null,
        )
        .filter((part) => part.type === 'text')
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join('')
      if (text.length > 0) {
        return text
      }
    }
  }
  return '?'
}

async function contextFiles(): Promise<string[]> {
  try {
    return await readdir(join(dataDirectory, 'contexts'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
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

describe('SessionManager', () => {
  it('opens a new session without writing a history file', async () => {
    const manager = await managerFor(projectA)

    const context = await manager.createSession()

    expect(context.id).not.toHaveLength(0)
    expect(context.messageCount).toBe(0)
    expect(manager.listOpen()).toHaveLength(1)
    expect(await contextFiles()).toEqual([])
  })

  it('saves non-empty sessions on shutdown and prunes empty ones', async () => {
    const manager = await managerFor(projectA)
    const kept = await manager.createSession()
    kept.addUser('hello')
    const empty = await manager.createSession()

    await manager.shutdown()

    expect(manager.listOpen()).toEqual([])
    const files = await contextFiles()
    expect(files).toHaveLength(1)
    const history = manager.listHistory()
    expect(history.map((entry) => entry.id)).toEqual([kept.id])
    expect(history[0]?.cwd).toBe(projectA)
    expect(empty.id).not.toBe(kept.id)

    const raw = JSON.parse(await readFile(join(dataDirectory, 'contexts', files[0]!), 'utf8'))
    expect(raw.messages).toHaveLength(1)
  })

  it('runs several sessions at once and saves each on shutdown', async () => {
    const manager = await managerFor(projectA)
    const first = await manager.createSession()
    const second = await manager.createSession()
    first.addUser('first')
    second.addUser('second')

    expect(manager.listOpen()).toHaveLength(2)

    await manager.shutdown()

    expect(await contextFiles()).toHaveLength(2)
    expect(manager.listHistory()).toHaveLength(2)
  })

  it('keeps one history per directory in the global data directory', async () => {
    const managerA = await managerFor(projectA)
    const sessionA = await managerA.createSession()
    sessionA.addUser('from a')
    await managerA.shutdown()

    const managerB = await managerFor(projectB)
    await managerB.createSession()
    await managerB.shutdown()

    const reloadedA = await managerFor(projectA)
    const reloadedB = await managerFor(projectB)
    expect(reloadedA.listHistory()).toHaveLength(1)
    expect(reloadedB.listHistory()).toHaveLength(0)
    expect(reloadedA.listHistory()[0]?.id).toBe(sessionA.id)
  })

  it('gets stored sessions and misses unknown ids', async () => {
    const manager = await managerFor(projectA)
    const original = await manager.createSession()
    original.addUser('remember me')
    await manager.shutdown()

    const reopened = await managerFor(projectA)
    const restored = await reopened.get(original.id)

    expect(restored).toBeInstanceOf(Context)
    expect(restored?.messages).toHaveLength(1)
    expect(reopened.listOpen()).toHaveLength(1)
    expect(await reopened.get('no-such-session')).toBeUndefined()
  })

  it('resumes a named session for MINIAGENT_SESSION-style boots', async () => {
    const manager = await managerFor(projectA)
    const resumed = await manager.resume('named-session')

    expect(resumed.id).toBe('named-session')
    expect(manager.listOpen()).toHaveLength(1)
    // Still no history file for the empty session.
    expect(await contextFiles()).toEqual([])
    await manager.shutdown()
  })

  it('recovers from a corrupt history with a warning and a fresh session', async () => {
    const err = sink()
    const manager = await SessionManager.create({
      store: new FileContextStore(join(dataDirectory, 'contexts')),
      dataDirectory,
      cwd: projectA,
      env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
      logger: pino({ level: 'debug', base: undefined }, err.stream),
    })
    await mkdir(join(dataDirectory, 'contexts'), { recursive: true })
    await writeFile(join(dataDirectory, 'contexts', 'broken.json'), '{ nope', 'utf8')

    const resumed = await manager.resume('broken')

    expect(resumed.id).toBe('broken')
    expect(resumed.messageCount).toBe(0)
    const logged = err
      .text()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { msg: string }).msg)
    expect(logged.join('\n')).toContain('quarantined corrupt history for "broken"')
    const files = await contextFiles()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^broken\.json\.corrupt-\d+\.json$/)
    await manager.shutdown()
  })

  it('logs session lifecycle at debug level', async () => {
    const out = sink()
    const manager = await SessionManager.create({
      store: new FileContextStore(join(dataDirectory, 'contexts')),
      dataDirectory,
      cwd: projectA,
      env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
      logger: pino({ level: 'debug', base: undefined }, out.stream),
    })

    const empty = await manager.createSession()
    await manager.close(empty.id)
    const kept = await manager.createSession()
    kept.addUser('hi')
    await manager.shutdown()

    const text = out.text()
    expect(text).toContain(`created ${empty.id}`)
    expect(text).toContain(`pruned ${empty.id}`)
    expect(text).toContain(`created ${kept.id}`)
    expect(text).toContain(`saved ${kept.id}`)
    expect(text).toContain('shutdown: 1 saved, 0 pruned')
  })

  it('drives several sessions through one agent per session at the same time', async () => {
    const manager = await managerFor(projectA)
    const first = await manager.createSession()
    const second = await manager.createSession()

    // One agent per session: each agent is bound to its own conversation and
    // both runs proceed concurrently.
    const one = new Agent({ model: echoModel(), context: first })
    const two = new Agent({ model: echoModel(), context: second })
    const [firstResult, secondResult] = await Promise.all([
      one.run('question-one'),
      two.run('question-two'),
    ])

    expect(firstResult.text).toBe('echo: question-one')
    expect(secondResult.text).toBe('echo: question-two')
    expect(first.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(second.messages.map((message) => message.role)).toEqual(['user', 'assistant'])

    await manager.shutdown()
    expect(await contextFiles()).toHaveLength(2)
    const restored = await (await managerFor(projectA)).get(first.id)
    expect(restored?.messages).toHaveLength(2)
  })
})

describe('App multi-session', () => {
  function testApp(cwd: string): App {
    return new App({
      args: [],
      env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
      envFile: false,
      configFile: false,
      dataDirectory,
      cwd,
      logger: pino({ level: 'info', base: undefined }, sink().stream),
    })
  }

  it('opens a new session per instance and writes no empty file', async () => {
    const first = testApp(projectA)
    const second = testApp(projectA)

    expect(await first.run()).toBe(0)
    expect(await second.run()).toBe(0)

    expect(first.sessionId).not.toBe(second.sessionId)
    expect(await contextFiles()).toEqual([])
  })

  it('saves the session when the application closes', async () => {
    await mkdir(dataDirectory, { recursive: true })
    await writeFile(
      join(dataDirectory, 'talk.mjs'),
      `export default { name: 'talk', async run(host) { host.context.addUser('hello'); } };`,
      'utf8',
    )
    const configFile = join(dataDirectory, 'config.json')
    await writeFile(configFile, JSON.stringify({ plugins: ['./talk.mjs'] }), 'utf8')
    const app = new App({
      args: [],
      env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
      envFile: false,
      configFile,
      dataDirectory,
      cwd: projectA,
      logger: pino({ level: 'silent', base: undefined }, sink().stream),
    })

    expect(await app.run()).toBe(0)

    const files = await contextFiles()
    expect(files).toHaveLength(1)
    expect(app.sessions?.listHistory().map((entry) => entry.id)).toEqual([app.sessionId])
  })

  it('exposes open and history sessions to plugins', async () => {
    await mkdir(dataDirectory, { recursive: true })
    await writeFile(
      join(dataDirectory, 'spy.mjs'),
      `export default {
        name: 'spy',
        async run(host) {
          globalThis.__sessionsSaw = {
            open: host.sessions.listOpen().length,
            history: host.sessions.listHistory().length,
            hasCreate: typeof host.sessions.createSession === 'function',
            hasGet: typeof host.sessions.get === 'function',
            hasClose: typeof host.sessions.close === 'function',
          };
          const extra = await host.sessions.createSession();
          extra.addUser('from extra');
          host.context.addUser('from boot');
          globalThis.__sessionsSaw.openAfterCreate = host.sessions.listOpen().length;
        },
      };`,
      'utf8',
    )
    const configFile = join(dataDirectory, 'config.json')
    await writeFile(configFile, JSON.stringify({ plugins: ['./spy.mjs'] }), 'utf8')
    const app = new App({
      args: [],
      env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
      envFile: false,
      configFile,
      dataDirectory,
      cwd: projectA,
      logger: pino({ level: 'silent', base: undefined }, sink().stream),
    })

    expect(await app.run()).toBe(0)

    const seen = (globalThis as Record<string, unknown>).__sessionsSaw as Record<string, unknown>
    expect(seen).toMatchObject({
      open: 1,
      history: 1,
      hasCreate: true,
      hasGet: true,
      hasClose: true,
    })
    expect(seen.openAfterCreate).toBe(2)
    delete (globalThis as Record<string, unknown>).__sessionsSaw

    // Both sessions held messages, so both were saved on shutdown.
    expect(await contextFiles()).toHaveLength(2)
    expect(app.sessions?.listHistory()).toHaveLength(2)
  })

  it('builds one agent per session with its own model', async () => {
    await mkdir(join(dataDirectory, 'contexts'), { recursive: true })
    for (const [id, model] of [
      ['a', 'model-a'],
      ['b', 'model-b'],
    ] as const) {
      await writeFile(
        join(dataDirectory, 'contexts', `${id}.json`),
        JSON.stringify({ messages: [], providerId: 'openai', modelId: model }),
        'utf8',
      )
    }
    const app = new App({
      args: [],
      env: { MINIAGENT_CONTEXT_WINDOW: '1000', MINIAGENT_SESSION: 'a' },
      envFile: false,
      configFile: false,
      dataDirectory,
      cwd: projectA,
      logger: pino({ level: 'silent', base: undefined }, sink().stream),
    })
    expect(await app.run()).toBe(0)

    const first = app.context as Context
    const second = (await app.sessions?.get('b')) as Context
    const createModel = vi.spyOn(app.providers as Providers, 'createModel')
    const agentA = app.agentFor(first)
    const agentB = app.agentFor(second)

    expect(agentA).not.toBe(agentB)
    expect(agentA.context).toBe(first)
    expect(agentB.context).toBe(second)
    expect(createModel).toHaveBeenCalledWith('openai', 'model-a')
    expect(createModel).toHaveBeenCalledWith('openai', 'model-b')
  })

  it('refuses agents before run builds the providers', () => {
    const app = testApp(projectA)

    expect(() => app.agentFor(new Context())).toThrow(/has not run/)
  })

  it('shares one cached agent per session with plugins', async () => {
    await mkdir(dataDirectory, { recursive: true })
    await writeFile(
      join(dataDirectory, 'probe.mjs'),
      `export default {
        name: 'probe',
        async run(host) {
          const extra = await host.sessions.createSession()
          host.agents.set(extra, host.agentFor(extra))
          const extraAgent = host.agents.get(extra.id)
          globalThis.__agentsProbe = {
            bootRegistered: host.agents.get(host.sessionId) === host.agent,
            hasBoot: host.agents.has(host.sessionId),
            extraIsNew: extraAgent !== host.agent,
            extraBound: extraAgent.context === extra,
          }
        },
      };`,
      'utf8',
    )
    const configFile = join(dataDirectory, 'config.json')
    await writeFile(configFile, JSON.stringify({ plugins: ['./probe.mjs'] }), 'utf8')
    const app = new App({
      args: [],
      env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
      envFile: false,
      configFile,
      dataDirectory,
      cwd: projectA,
      logger: pino({ level: 'silent', base: undefined }, sink().stream),
    })
    expect(await app.run()).toBe(0)

    const seen = (globalThis as Record<string, unknown>).__agentsProbe as Record<string, boolean>
    expect(seen).toEqual({
      bootRegistered: true,
      hasBoot: true,
      extraIsNew: true,
      extraBound: true,
    })
    delete (globalThis as Record<string, unknown>).__agentsProbe
    expect(app.agents?.ids()).toEqual([])
  })

  it('logs boot plugins and agents at debug level', async () => {
    const out = sink()
    const app = new App({
      args: [],
      env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
      envFile: false,
      configFile: false,
      dataDirectory,
      cwd: projectA,
      logger: pino({ level: 'debug', base: undefined }, out.stream),
    })
    expect(await app.run()).toBe(0)

    const text = out.text()
    expect(text).toContain('loaded:')
    expect(text).toContain('basic-tools')
    expect(text).toContain(`created ${app.sessionId}`)
    expect(text).toContain(`openai/gpt-6-astra for session ${app.sessionId}`)

    const raw = text.split('\n').filter((line) => line.length > 0)
    const logged = raw.map((line) => JSON.parse(line) as { module?: string; msg: string })
    const moduleOf = (fragment: string): string | undefined =>
      logged.find((line) => line.msg.includes(fragment))?.module
    expect(moduleOf('loaded:')).toBe('app')
    expect(moduleOf(`created ${app.sessionId}`)).toBe('sessions')
    expect(moduleOf('for session')).toBe('app')
    // One module key per line: nested same-key children would print it twice.
    for (const line of raw) {
      expect(line.match(/"module"/g)).toHaveLength(1)
    }
  })

  it('binds built agents to the agent module', async () => {
    const app = testApp(projectA)
    expect(await app.run()).toBe(0)

    const agent = app.agentFor(app.context as Context)

    expect(agent.logger?.bindings()).toMatchObject({ module: 'agent' })
  })
})
