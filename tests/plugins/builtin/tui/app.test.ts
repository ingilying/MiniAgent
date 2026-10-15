import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

import { simulateReadableStream } from 'ai'
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
  quitCommand,
} from '../../../../src/commands/commands.js'
import { Context } from '../../../../src/session/context.js'
import { TuiApp } from '../../../../src/plugins/builtin/tui/app.js'
import type { RunHost } from '../../../../src/plugins/types.js'

let directory: string

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
  // eslint-disable-next-line no-control-regex -- ESC has no readable spelling
  return new RegExp('\x1b\\[[0-9;?]*[a-zA-Z]|\x1b[()][AB0]', 'g')
}

/** Latest highlighted menu row: frames accumulate, so only the tail counts. */
function lastHighlight(frames: string): string | undefined {
  const hits = frames.match(/❯ \/[A-Za-z0-9/_?.-]*/g)
  return hits?.at(-1)
}

interface Harness {
  host: RunHost
  stdin: PassThrough
  frames: () => string
  write: (text: string) => Promise<void>
  writeRaw: (text: string) => Promise<void>
  settle: (ms?: number) => Promise<void>
  ready: () => Promise<void>
  waitUntilExit: () => Promise<unknown>
  stop: () => Promise<void>
}

async function harness(): Promise<Harness> {
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  }
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
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
  const context = new Context([], { contextWindow: 1000 })
  const agent = new Agent({ model, context })
  // A switch rebuilds the agent; a fresh instance forces a rerender.
  const switchedAgent = new Agent({ model, context })
  const commands = new CommandRegistry()
  commands.register(quitCommand)
  commands.register(helpCommand)
  commands.register(modelCommand)
  const host = {
    agent,
    agentFor: (): Agent => agent,
    agents: new AgentsManager(),
    context,
    sessionId: 'session-1',
    providerId: 'openai',
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
    sessions: {} as never,
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
    stdin,
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
      expect(lastHighlight(ui.frames())).toBe('❯ /quit')
      await ui.writeRaw('\x1b[B')
      await ui.settle()
      expect(lastHighlight(ui.frames())).toBe('❯ /help')
      await ui.writeRaw('\x1b[A')
      await ui.settle()
      expect(lastHighlight(ui.frames())).toBe('❯ /quit')
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
