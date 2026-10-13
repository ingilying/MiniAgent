import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import pino from 'pino'

import { App } from '../src/app.js'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'miniagent-logging-'))
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({}), { status: 200 }))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

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

/** Runs the body with stdout captured. The app holds the stdout object itself. */
async function withCapturedStdout(body: () => Promise<void>): Promise<string> {
  let captured = ''
  const original = process.stdout.write
  process.stdout.write = ((chunk: unknown) => {
    captured += String(chunk)
    return true
  }) as typeof process.stdout.write
  try {
    await body()
  } finally {
    process.stdout.write = original
  }
  return captured
}

async function stored(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

/** Finished run logs kept in `<dataDirectory>/log`. */
async function logFiles(dataDirectory: string): Promise<string[]> {
  try {
    return await readdir(join(dataDirectory, 'log'))
  } catch {
    return []
  }
}

const TIMESTAMPED = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}\.log$/

describe('App diagnostics', () => {
  it('sends diagnostics to MINIAGENT_LOG_FILE as well as stdout', async () => {
    const file = join(directory, 'app.log')
    let code = 0
    const stdout = await withCapturedStdout(async () => {
      code = await new App({
        env: { MINIAGENT_CONTEXT_WINDOW: 'nope', MINIAGENT_LOG_FILE: file },
        envFile: false,
        configFile: false,
        dataDirectory: join(directory, 'data'),
        cwd: join(directory, 'project'),
      }).run()
    })

    expect(code).toBe(0)
    expect(stdout).toContain('ignoring invalid')
    expect(await stored(file)).toContain('ignoring invalid')
  })

  it('prefers the logFile option over the environment', async () => {
    const file = join(directory, 'opt.log')
    const envFile = join(directory, 'env.log')
    let code = 0
    const stdout = await withCapturedStdout(async () => {
      code = await new App({
        env: { MINIAGENT_CONTEXT_WINDOW: 'nope', MINIAGENT_LOG_FILE: envFile },
        envFile: false,
        configFile: false,
        dataDirectory: join(directory, 'data'),
        cwd: join(directory, 'project'),
        logFile: file,
      }).run()
    })

    expect(code).toBe(0)
    expect(stdout).toContain('ignoring invalid')
    expect(await stored(file)).toContain('ignoring invalid')
    expect(await stored(envFile)).toBeUndefined()
  })

  it('tees the console and keeps a timestamped file by default', async () => {
    const dataDirectory = join(directory, 'data')
    let code = 0
    const stdout = await withCapturedStdout(async () => {
      code = await new App({
        env: { MINIAGENT_CONTEXT_WINDOW: 'nope' },
        envFile: false,
        configFile: false,
        dataDirectory,
        cwd: join(directory, 'project'),
      }).run()
    })

    expect(code).toBe(0)
    expect(stdout).toContain('ignoring invalid')
    expect(await stored(join(dataDirectory, 'log', 'latest.log'))).toBeUndefined()
    const files = await logFiles(dataDirectory)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(TIMESTAMPED)
    expect(await stored(join(dataDirectory, 'log', files[0] as string))).toContain(
      'ignoring invalid',
    )
  })

  it('keeps one file per run', async () => {
    const dataDirectory = join(directory, 'data')
    const cwd = join(directory, 'project')
    const runWith = (env: NodeJS.ProcessEnv): Promise<number> =>
      withCapturedStdout(async () => {
        await new App({
          env,
          envFile: false,
          configFile: false,
          dataDirectory,
          cwd,
        }).run()
      }).then(() => 0)

    expect(await runWith({ MINIAGENT_CONTEXT_WINDOW: 'nope' })).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 12))
    expect(await runWith({ MINIAGENT_CONTEXT_WINDOW: '1000' })).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 12))
    expect(await runWith({ MINIAGENT_CONTEXT_WINDOW: 'nope' })).toBe(0)

    const files = await logFiles(dataDirectory)
    expect(files).toHaveLength(3)
    expect(await stored(join(dataDirectory, 'log', 'latest.log'))).toBeUndefined()
  })

  it('writes no log directory content when a log file is configured', async () => {
    const dataDirectory = join(directory, 'data')
    let code = 0
    const stdout = await withCapturedStdout(async () => {
      code = await new App({
        env: { MINIAGENT_CONTEXT_WINDOW: 'nope' },
        envFile: false,
        configFile: false,
        dataDirectory,
        cwd: join(directory, 'project'),
        logFile: join(directory, 'custom.log'),
      }).run()
    })

    expect(code).toBe(0)
    expect(stdout).toContain('ignoring invalid')
    expect(await stored(join(directory, 'custom.log'))).toContain('ignoring invalid')
    expect(await logFiles(dataDirectory)).toEqual([])
  })

  it('drops info diagnostics at higher levels', async () => {
    const dataDirectory = join(directory, 'data')
    let app: App | undefined
    const stdout = await withCapturedStdout(async () => {
      app = new App({
        env: { MINIAGENT_CONTEXT_WINDOW: 'nope', MINIAGENT_LOG_LEVEL: 'error' },
        envFile: false,
        configFile: false,
        dataDirectory,
        cwd: join(directory, 'project'),
      })
      expect(await app.run()).toBe(0)
    })

    expect(app?.logger.level).toBe('error')
    expect(stdout).toBe('')
    expect(await logFiles(dataDirectory)).toHaveLength(1)
  })

  it('takes the level from the option over the environment', async () => {
    const app = new App({
      env: { MINIAGENT_CONTEXT_WINDOW: '1000', MINIAGENT_LOG_LEVEL: 'error' },
      envFile: false,
      configFile: false,
      dataDirectory: join(directory, 'data'),
      cwd: join(directory, 'project'),
      logLevel: 'debug',
    })

    expect(await app.run()).toBe(0)
    expect(app.logger.level).toBe('debug')
  })

  it('leaves an injected logger level alone', async () => {
    const app = new App({
      env: { MINIAGENT_CONTEXT_WINDOW: '1000', MINIAGENT_LOG_LEVEL: 'error' },
      envFile: false,
      configFile: false,
      dataDirectory: join(directory, 'data'),
      cwd: join(directory, 'project'),
      logger: pino({ level: 'silent', base: undefined }, sink().stream),
      logLevel: 'debug',
    })

    expect(await app.run()).toBe(0)
    expect(app.logger.level).toBe('silent')
  })

  it('falls back to info for an unknown level', async () => {
    const app = new App({
      env: { MINIAGENT_CONTEXT_WINDOW: '1000', MINIAGENT_LOG_LEVEL: 'verbose' },
      envFile: false,
      configFile: false,
      dataDirectory: join(directory, 'data'),
      cwd: join(directory, 'project'),
      logLevel: 'verbose',
    })

    expect(await app.run()).toBe(0)
    expect(app.logger.level).toBe('info')
  })

  it('uses an injected logger as is and writes no log files', async () => {
    const out = sink()
    const dataDirectory = join(directory, 'data')
    const app = new App({
      env: { MINIAGENT_CONTEXT_WINDOW: 'nope' },
      envFile: false,
      configFile: false,
      dataDirectory,
      cwd: join(directory, 'project'),
      logger: pino({ level: 'info', base: undefined }, out.stream),
    })

    expect(await app.run()).toBe(0)
    expect(out.text()).toContain('ignoring invalid')
    expect(await logFiles(dataDirectory)).toEqual([])
  })
})
