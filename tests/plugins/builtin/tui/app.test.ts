import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

import { simulateReadableStream } from 'ai'
import type { ToolSet } from 'ai'
import { render } from 'ink'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import pino from 'pino'

import { Agent } from '../../../../src/agent/agent.js'
import { AgentsManager } from '../../../../src/agent/manager.js'
import {
  CommandRegistry,
  helpCommand,
  modelCommand,
  modelsCommand,
  newCommand,
  quitCommand,
  resumeCommand,
} from '../../../../src/commands/commands.js'
import { Context } from '../../../../src/session/context.js'
import { displayWidth } from '../../../../src/plugins/builtin/tui/width.js'
import { createBasicTools } from '../../../../src/plugins/builtin/basic-tools/tools.js'
import { TuiApp } from '../../../../src/plugins/builtin/tui/app.js'
import type { RunHost } from '../../../../src/plugins/types.js'

let directory: string

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'miniagent-tui-app-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function sink(): Writable {
  return new Writable({
    write(chunk, _encoding, callback): void {
      callback()
    },
  })
}

/** Writable stdin Ink accepts: TTY-shaped with a mockable raw mode switch. */
function fakeStdin(): PassThrough & { isTTY: boolean } {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode(mode: boolean): void
  }
  stdin.isTTY = true
  stdin.setRawMode = (): void => {}
  return stdin
}

/** Matches ANSI escape sequences without a literal control char in source. */
function stripAnsi(): RegExp {
  // eslint-disable-next-line no-control-regex -- ESC/BEL have no readable spelling
  return new RegExp('\x1b\\[[0-9;?]*[a-zA-Z]|\x1b[()][AB0]|\x1b\\][^\x07]*\x07', 'g')
}

/** Latest highlighted menu row: frames accumulate, so only the tail counts. */
function lastHighlight(frames: string): string | undefined {
  const hits = frames.match(/❯ \/[A-Za-z0-9/_?.-]*/g)
  return hits?.at(-1)
}

interface Harness {
  host: RunHost
  titleSession: ReturnType<typeof vi.fn>
  stdin: PassThrough
  /** Raw output, escape sequences included. */
  raw: () => string
  frames: () => string
  write: (text: string) => Promise<void>
  writeRaw: (text: string) => Promise<void>
  settle: (ms?: number) => Promise<void>
  ready: () => Promise<void>
  waitUntilExit: () => Promise<unknown>
  stop: () => Promise<void>
}

async function harness(
  options: {
    providerIds?: readonly string[]
    declaredModelIds?: readonly string[]
    /** Reasoning text the mock model emits before its answer. */
    reasoning?: string
    /** Custom model, for tests that need several steps or tool calls. */
    model?: MockLanguageModelV4
    /** Tools the test agent may call. */
    tools?: ToolSet
    /** Sessions the manager can hand out, keyed by id. */
    storedSessions?: Map<string, Context>
    /** Titles the session manager reports, keyed by id. */
    titles?: Map<string, string>
  } = {},
): Promise<Harness> {
  const defaultModel = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'reasoning-start', id: 'reasoning-1' },
          { type: 'reasoning-delta', id: 'reasoning-1', delta: options.reasoning ?? '' },
          { type: 'reasoning-end', id: 'reasoning-1' },
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'hi' },
          { type: 'text-end', id: 'text-1' },
          { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
        ],
      }),
    }),
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'hi' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
    }),
  })
  const stored = new Map(options.storedSessions ?? [])
  const sessions = {
    listHistory: (): Array<{
      id: string
      cwd: string
      createdAt: string
      updatedAt: string
      title?: string
    }> =>
      [...stored.keys()].map((id) => ({
        id,
        cwd: directory,
        createdAt: '2026-10-18T19:00:00.000Z',
        updatedAt: '2026-10-18T19:00:00.000Z',
        title: options.titles?.get(id),
      })),
    get: async (id: string): Promise<Context | undefined> => stored.get(id),
    createSession: async (): Promise<Context> => {
      const created = new Context([], { contextWindow: 1000 })
      stored.set(created.id, created)
      return created
    },
  } as unknown as RunHost['sessions']

  const context = new Context([], { contextWindow: 1000 })
  const model = options.model ?? defaultModel
  const agent = new Agent({ model, context, tools: options.tools, maxSteps: 4 })
  // A switch rebuilds the agent; a fresh instance forces a rerender.
  const switchedAgent = new Agent({ model, context })
  const commands = new CommandRegistry()
  commands.register(quitCommand)
  commands.register(helpCommand)
  commands.register(modelCommand)
  commands.register(modelsCommand)
  commands.register(resumeCommand)
  commands.register(newCommand)
  const titleSession = vi.fn(async () => {})
  const host = {
    agent,
    titleSession,
    agentFor: (): Agent => agent,
    agents: new AgentsManager(),
    context,
    sessionId: 'session-1',
    providerId: 'openai',
    providerIds: options.providerIds ?? ['deepseek', 'openai'],
    declaredModelIds: options.declaredModelIds ?? [],
    modelId: 'gpt-6-astra',
    switchModel: vi.fn(async (session: Context, providerId: string, modelId: string) => {
      // Mirrors App.switchModelFor: mutate the session in place.
      session.providerId = providerId
      session.modelId = modelId
      session.contextWindow = 2000
      return { agent: switchedAgent, providerId, modelId, contextWindow: 2000 }
    }),
    tools: {},
    addTools: (tools): void => {
      Object.assign(host.tools, tools)
    },
    dataDirectory: directory,
    cwd: directory,
    sessions,
    commands,
    logger: pino({ level: 'silent', base: undefined }, sink()),
  } satisfies RunHost

  const { createElement } = await import('react')
  const stdin = fakeStdin()
  const chunks: string[] = []
  const stdout = new Writable({
    write(chunk, _encoding, callback): void {
      chunks.push(String(chunk))
      callback()
    },
  }) as Writable & { isTTY: boolean; columns: number; rows: number }
  stdout.isTTY = true
  stdout.columns = 100
  stdout.rows = 30
  const app = render(createElement(TuiApp, { host }), {
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: sink() as never,
    patchConsole: false,
  })
  const frames = (): string => chunks.join('').replace(stripAnsi(), '')
  return {
    host,
    titleSession,
    stdin,
    raw: (): string => chunks.join(''),
    frames,
    write: async (text: string): Promise<void> => {
      // One packet per char, consumed before the next lands: Ink parses
      // each data event as a single keypress and never splits a bundle.
      for (const char of text) {
        stdin.write(char)
        await new Promise((resolve) => setImmediate(resolve))
      }
    },
    /** One packet whole: escape sequences must not split across packets. */
    writeRaw: async (text: string): Promise<void> => {
      stdin.write(text)
      await new Promise((resolve) => setImmediate(resolve))
    },
    settle: async (ms = 150): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, ms))
    },
    /**
     * Ink paints its first frame before passive effects attach the stdin
     * listener, so keystrokes sent too early vanish. Wait for the listener
     * instead of guessing a delay.
     */
    ready: async (): Promise<void> => {
      const start = Date.now()
      while (stdin.listenerCount('readable') === 0) {
        if (Date.now() - start > 10000) {
          throw new Error('Ink never attached its stdin listener.')
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    },
    stop: async (): Promise<void> => {
      app.unmount()
      await app.waitUntilExit().catch(() => {})
    },
    waitUntilExit: (): Promise<unknown> => app.waitUntilExit(),
  }
}

describe('TuiApp', () => {
  it('selects a command with Enter, then runs it with a second Enter', async () => {
    const ui = await harness()
    try {
      await ui.ready()
      await ui.write('/help')
      await ui.settle()
      await ui.write('\r')
      await ui.settle()
      // Selected into the input box: the prompt row now holds the fill.
      expect(ui.frames()).toContain('> /help ')
      await ui.write('\r')
      await ui.settle()
      const frame = ui.frames()
      expect(frame).toContain('Available commands:')
      expect(frame).toContain('/quit')
      expect(frame).toContain('/model')
    } finally {
      await ui.stop()
    }
  })

  it('reports unknown commands without touching the agent', async () => {
    const ui = await harness()
    try {
      await ui.ready()
      await ui.write('/nope\r')
      await ui.settle()
      expect(ui.frames()).toContain('Unknown command "/nope". /help lists commands.')
    } finally {
      await ui.stop()
    }
  })

  it('completes a command name on Tab', async () => {
    const ui = await harness()
    try {
      await ui.ready()
      await ui.write('/q')
      await ui.settle()
      expect(ui.frames()).toContain('/quit')
      await ui.write('\t')
      await ui.settle()
      expect(ui.frames()).toContain('> /quit ')
    } finally {
      await ui.stop()
    }
  })

  it('moves the highlight with arrow keys, wrapping around', async () => {
    const ui = await harness()
    try {
      await ui.ready()
      await ui.write('/')
      await ui.settle()
      expect(lastHighlight(ui.frames())).toBe('❯ /help')
      await ui.writeRaw('\x1b[B')
      await ui.settle()
      expect(lastHighlight(ui.frames())).toBe('❯ /model')
      await ui.writeRaw('\x1b[B')
      await ui.settle()
      expect(lastHighlight(ui.frames())).toBe('❯ /models')
      await ui.writeRaw('\x1b[B')
      await ui.settle()
      expect(lastHighlight(ui.frames())).toBe('❯ /new')
      await ui.writeRaw('\x1b[B')
      await ui.settle()
      expect(lastHighlight(ui.frames())).toBe('❯ /quit')
      await ui.writeRaw('\x1b[B')
      await ui.settle()
      expect(lastHighlight(ui.frames())).toBe('❯ /resume')
      await ui.writeRaw('\x1b[B')
      await ui.settle()
      expect(lastHighlight(ui.frames())).toBe('❯ /help')
      await ui.writeRaw('\x1b[A')
      await ui.settle()
      expect(lastHighlight(ui.frames())).toBe('❯ /resume')
    } finally {
      await ui.stop()
    }
  })

  it('switches the model through host.switchModel and swaps agents', async () => {
    const ui = await harness()
    try {
      await ui.ready()
      await ui.write('/model openai/other')
      await ui.settle()
      await ui.write('\r')
      await ui.settle(300)
      expect(ui.host.switchModel).toHaveBeenCalledWith(ui.host.context, 'openai', 'other')
      expect(ui.frames()).toContain('Switched to openai/other.')
    } finally {
      await ui.stop()
    }
  })

  it('lists cached models under /model and selects one with Enter', async () => {
    await writeFile(
      join(directory, 'models.json'),
      JSON.stringify({
        url: 'https://models.dev/api.json',
        at: Date.now(),
        catalog: {
          openai: { models: { 'gpt-5': { limit: {} }, 'gpt-6-astra': { limit: {} } } },
          deepseek: { models: { 'deepseek-chat': { limit: {} } } },
        },
      }),
      'utf8',
    )
    const ui = await harness()
    try {
      await ui.ready()
      await ui.write('/model gpt')
      await ui.settle()
      expect(ui.frames()).toContain('openai/gpt-5')
      expect(ui.frames()).toContain('openai/gpt-6-astra')
      await ui.write('\r')
      await ui.settle()
      await ui.write('\r')
      await ui.settle(300)
      expect(ui.host.switchModel).toHaveBeenCalledWith(ui.host.context, 'openai', 'gpt-5')
      expect(ui.frames()).toContain('Switched to openai/gpt-5.')
      // Usage line and model name read the live context, not boot snapshots.
      expect(ui.frames()).toContain('0/2k (0%)')
    } finally {
      await ui.stop()
    }
  })

  it('offers only loaded providers in the model menu', async () => {
    await writeFile(
      join(directory, 'models.json'),
      JSON.stringify({
        url: 'https://models.dev/api.json',
        at: Date.now(),
        catalog: {
          openai: { models: { 'gpt-6-astra': { limit: {} } } },
          deepseek: { models: { 'deepseek-chat': { limit: {} } } },
          xai: { models: { 'grok-4.7': { limit: {} } } },
        },
      }),
      'utf8',
    )
    const ui = await harness()
    try {
      await ui.ready()
      await ui.write('/model ')
      await ui.settle()
      const frame = ui.frames()
      expect(frame).toContain('openai/gpt-6-astra')
      expect(frame).toContain('deepseek/deepseek-chat')
      expect(frame).not.toContain('xai/grok-4.7')
    } finally {
      await ui.stop()
    }
  })

  it('offers declared models the catalog cannot list', async () => {
    const ui = await harness({
      providerIds: ['gateway', 'openai'],
      declaredModelIds: ['gateway/big', 'gateway/small'],
    })
    try {
      await ui.ready()
      await ui.write('/model ')
      await ui.settle()
      const frame = ui.frames()
      expect(frame).toContain('gateway/big')
      expect(frame).toContain('gateway/small')
    } finally {
      await ui.stop()
    }
  })

  it('lists the models of the loaded providers with /models', async () => {
    await writeFile(
      join(directory, 'models.json'),
      JSON.stringify({
        url: 'https://models.dev/api.json',
        at: Date.now(),
        catalog: {
          openai: { models: { 'gpt-6-astra': { limit: {} } } },
          deepseek: { models: { 'deepseek-chat': { limit: {} } } },
          xai: { models: { 'grok-4.7': { limit: {} } } },
        },
      }),
      'utf8',
    )
    const ui = await harness()
    try {
      await ui.ready()
      await ui.write('/models')
      await ui.settle()
      await ui.write('\r')
      await ui.settle()
      await ui.write('\r')
      await ui.settle()
      const frame = ui.frames()
      expect(frame).toContain('Models (2):')
      expect(frame).toContain('deepseek/deepseek-chat')
      expect(frame).toContain('openai/gpt-6-astra')
      expect(frame).not.toContain('xai/grok-4.7')
    } finally {
      await ui.stop()
    }
  })

  it('draws reasoning and the answer as separate rows', async () => {
    const ui = await harness({ reasoning: 'weigh the options' })
    try {
      await ui.ready()
      await ui.write('hi')
      await ui.settle()
      await ui.write('\r')
      await ui.settle(400)
      const frame = ui.frames()
      expect(frame).toContain('✻ Thinking')
      expect(frame).toContain('weigh the options')
      expect(frame).toContain('● hi')
    } finally {
      await ui.stop()
    }
  })

  it('draws a tool call and its result as one row', async () => {
    const file = join(directory, 'note.txt')
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'write',
                input: JSON.stringify({ path: file, content: 'hello' }),
              },
              { type: 'finish', usage, finishReason: { unified: 'tool-calls', raw: undefined } },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'Wrote it.' },
              { type: 'text-end', id: 'text-1' },
              { type: 'finish', usage, finishReason: { unified: 'stop', raw: undefined } },
            ],
          }),
        },
      ],
    })
    const ui = await harness({
      model,
      tools: { write: createBasicTools(directory).write! },
    })
    try {
      await ui.ready()
      await ui.write('write a note')
      await ui.settle()
      await ui.write('\r')
      await ui.settle(500)
      const frame = ui.frames()
      // write has its own view: path plus byte count, not raw JSON.
      expect(frame).toContain('⏺ write(')
      expect(frame).toContain('⎿ 5 bytes')
      expect(frame).toContain('● Wrote it.')
    } finally {
      await ui.stop()
    }
  })

  it('titles the session from its first message, once', async () => {
    const ui = await harness()
    try {
      await ui.ready()
      await ui.write('rename the session list')
      await ui.settle()
      await ui.write('\r')
      await ui.settle(300)
      expect(ui.titleSession).toHaveBeenCalledTimes(1)
      expect(ui.titleSession).toHaveBeenCalledWith(ui.host.context.id, 'rename the session list')
    } finally {
      await ui.stop()
    }
  })

  it('names the terminal after the session', async () => {
    const ui = await harness()
    try {
      await ui.ready()
      // Boot names the tab before any conversation starts.
      expect(ui.raw()).toContain('\x1b]0;MiniAgent\x07')

      await ui.write('rename the session list')
      await ui.settle()
      await ui.write('\r')
      await ui.settle(300)
      // eslint-disable-next-line no-control-regex -- OSC ends with BEL
      const pattern = /\x1b\]0;([^\x07]*)\x07/g
      const titles = [...ui.raw().matchAll(pattern)].map((match) => match[1])
      expect(titles.at(-1)).toBe('rename the session list')
    } finally {
      await ui.stop()
    }
  })

  it('scrolls a long model menu as the highlight moves', async () => {
    const models = Object.fromEntries(
      Array.from({ length: 20 }, (_unused, index) => [
        `model-${String(index).padStart(2, '0')}`,
        { limit: {} },
      ]),
    )
    await writeFile(
      join(directory, 'models.json'),
      JSON.stringify({
        url: 'https://models.dev/api.json',
        at: Date.now(),
        catalog: { openai: { models } },
      }),
      'utf8',
    )
    const ui = await harness()
    try {
      await ui.ready()
      await ui.write('/model model-')
      await ui.settle(300)
      const first = ui.frames()
      expect(first).toContain('openai/model-07')
      expect(first).toContain('↓ 12 more')

      for (let step = 0; step < 10; step += 1) {
        await ui.writeRaw('\x1b[B')
        await ui.settle(80)
      }
      await ui.settle(200)
      const moved = ui.frames()
      // The window followed the highlight past the first eight rows.
      expect(moved).toContain('↑ 6 more')
      expect(moved).toContain('❯ openai/model-10')
      expect(moved).toContain('openai/model-13')
    } finally {
      await ui.stop()
    }
  })

  it('offers stored sessions in the /resume menu', async () => {
    const earlier = new Context([{ role: 'user', content: 'earlier question' }], {
      contextWindow: 1000,
    })
    const ui = await harness({
      storedSessions: new Map([[earlier.id, earlier]]),
      titles: new Map([[earlier.id, 'Fix login bug']]),
    })
    try {
      await ui.ready()
      await ui.write('/resume')
      await ui.settle(200)
      expect(ui.frames()).toContain('Fix login bug')

      await ui.write('\r')
      await ui.settle()
      expect(ui.frames()).toContain(`/resume ${earlier.id} `)

      await ui.write('\r')
      await ui.settle(400)
      expect(ui.frames()).toContain('earlier question')
    } finally {
      await ui.stop()
    }
  })

  it('starts a fresh session with /new', async () => {
    const ui = await harness()
    try {
      await ui.ready()
      await ui.write('/new')
      await ui.settle()
      await ui.write('\r')
      await ui.settle()
      await ui.write('\r')
      await ui.settle(400)
      expect(ui.frames()).toContain('Started ')
    } finally {
      await ui.stop()
    }
  })

  it('resumes a stored session and replays its history', async () => {
    const earlier = new Context(
      [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
      ],
      { contextWindow: 1000 },
    )
    const ui = await harness({ storedSessions: new Map([[earlier.id, earlier]]) })
    try {
      await ui.ready()
      await ui.write(`/resume ${earlier.id}\r`)
      await ui.settle(400)
      const frame = ui.frames()
      expect(frame).toContain('earlier question')
      expect(frame).toContain('earlier answer')
      expect(frame).toContain(`Resumed ${earlier.id}.`)
    } finally {
      await ui.stop()
    }
  })

  it('keeps a resumed tool box inside the terminal', async () => {
    const command = 'ls -l bun-vs-nodejs.md && head -20 bun-vs-nodejs.md'
    const long =
      '包管理器 | 内置 bun install，极快（全局缓存 + 硬链接），兼容 package.json 与 node_modules | 自带 npm，也可用 pnpm / yarn '.repeat(
        2,
      )
    const messages = [
      { role: 'user' as const, content: 'go' },
      {
        role: 'assistant' as const,
        content: [
          { type: 'tool-call' as const, toolCallId: 'c1', toolName: 'shell', input: { command } },
        ],
      },
      {
        role: 'tool' as const,
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: 'c1',
            toolName: 'shell',
            output: {
              type: 'json' as const,
              value: { command, exitCode: 0, stdout: `${long}\n`, stderr: '' },
            },
          },
        ],
      },
    ]
    const earlier = new Context(messages, { contextWindow: 1000 })
    const ui = await harness({ storedSessions: new Map([[earlier.id, earlier]]) })
    try {
      await ui.ready()
      await ui.write(`/resume ${earlier.id}\r`)
      await ui.settle(500)
      const rows = ui.frames().split('\n')
      const shell = rows.findIndex((line) => line.includes('⏺ shell'))
      expect(shell).toBeGreaterThanOrEqual(0)
      const box = rows
        .slice(shell)
        .filter((line) => line.startsWith('│') || line.startsWith('╭') || line.startsWith('╰'))
      expect(box.length).toBeGreaterThan(3)
      // Every border row ends in the same column, inside the 100-column frame.
      const widths = new Set(box.map((line) => displayWidth(line)))
      expect(widths.size).toBe(1)
      expect(Math.max(...widths)).toBeLessThan(100)
      expect(box.join('\n')).toContain('…')
    } finally {
      await ui.stop()
    }
  })

  it('quits after selecting /quit with a second Enter', async () => {
    const ui = await harness()
    try {
      await ui.ready()
      await ui.write('/quit')
      await ui.settle()
      await ui.write('\r')
      await ui.settle()
      await ui.write('\r')
      const exited = await Promise.race([
        ui.waitUntilExit().then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
      ])
      expect(exited).toBe(true)
    } finally {
      await ui.stop()
    }
  })
})
