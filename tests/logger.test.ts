import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../src/app.js'
import { FileSink, Logger, StreamSink, parseLogLevel, type LogSink } from '../src/logger.js'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'miniagent-logger-'))
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

describe('StreamSink', () => {
  it('writes through and closes without work', async () => {
    const buffer = sink()
    const target = new StreamSink(buffer.stream, 'test')

    target.write('hello\n')
    await target.close()

    expect(target.id).toBe('test')
    expect(buffer.text()).toBe('hello\n')
  })

  it('names sinks by kind unless the user names them', () => {
    const buffer = sink()

    expect(new StreamSink(buffer.stream).id).toBe('stdio')
    expect(new FileSink(join(directory, 'x.log')).id).toBe('file')
    expect(new FileSink(join(directory, 'y.log'), 'session-file').id).toBe('session-file')
  })
})

describe('FileSink', () => {
  it('appends lines and flushes on close', async () => {
    const file = join(directory, 'app.log')
    const target = new FileSink(file)

    target.write('one\n')
    target.write('two\n')
    await target.close()

    expect(await readFile(file, 'utf8')).toBe('one\ntwo\n')
  })

  it('falls back with a notice when the file cannot be written', async () => {
    const fallback = sink()
    // A file path through an existing file can never open.
    const blocker = join(directory, 'blocker')
    await writeFile(blocker, 'x', 'utf8')
    const target = new FileSink(
      join(blocker, 'app.log'),
      'blocked',
      new StreamSink(fallback.stream),
    )

    target.write('hello\n')
    await target.close()

    expect(fallback.text()).toContain('[log] cannot write')
    expect(fallback.text()).toContain('hello\n')
  })
})

describe('Logger', () => {
  it('writes lines and errors to the given sinks', async () => {
    const out = sink()
    const err = sink()
    const logger = new Logger({
      outputs: [new StreamSink(out.stream, 'out')],
      errorOutputs: [new StreamSink(err.stream, 'err')],
    })

    logger.line('hello')
    logger.line()
    logger.error('boom')
    await logger.close()

    expect(out.text()).toBe('hello\n\n')
    expect(err.text()).toBe('boom\n')
  })

  it('routes debug and info to outputs, warnings and errors to error outputs', async () => {
    const out = sink()
    const err = sink()
    const logger = new Logger({
      outputs: [new StreamSink(out.stream, 'out')],
      errorOutputs: [new StreamSink(err.stream, 'err')],
      level: 'debug',
    })

    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    await logger.close()

    expect(out.text()).toBe('d\ni\n')
    expect(err.text()).toBe('w\ne\n')
  })

  it('drops calls quieter than the configured level', async () => {
    const out = sink()
    const err = sink()
    const logger = new Logger({
      outputs: [new StreamSink(out.stream, 'out')],
      errorOutputs: [new StreamSink(err.stream, 'err')],
      level: 'warn',
    })

    expect(logger.level).toBe('warn')
    logger.debug('d')
    logger.line('i')
    logger.warn('w')
    logger.error('e')
    await logger.close()

    expect(out.text()).toBe('')
    expect(err.text()).toBe('w\ne\n')
  })

  it('parses levels from user input', () => {
    expect(parseLogLevel('debug')).toBe('debug')
    expect(parseLogLevel('ERROR')).toBe('error')
    expect(parseLogLevel('verbose')).toBeUndefined()
    expect(parseLogLevel('')).toBeUndefined()
    expect(parseLogLevel(undefined)).toBeUndefined()
    expect(parseLogLevel(7)).toBeUndefined()
  })

  it('fans out to several sinks sharing one file handle', async () => {
    const first = sink()
    const second = sink()
    const errors = sink()
    const file = new FileSink(join(directory, 'app.log'))
    const logger = new Logger({
      outputs: [
        new StreamSink(first.stream, 'first'),
        new StreamSink(second.stream, 'second'),
        file,
      ],
      errorOutputs: [new StreamSink(errors.stream, 'errors'), file],
    })

    logger.line('hello')
    logger.error('boom')
    await logger.close()

    expect(first.text()).toBe('hello\n')
    expect(second.text()).toBe('hello\n')
    expect(errors.text()).toBe('boom\n')
    expect(await readFile(file.path, 'utf8')).toBe('hello\nboom\n')
  })

  it('replaces and extends the lists at runtime', async () => {
    const first = sink()
    const second = sink()
    const firstSink = new StreamSink(first.stream, 'first')
    const secondSink = new StreamSink(second.stream, 'second')
    const logger = new Logger({ outputs: [firstSink] })

    logger.line('one')
    expect(logger.setOutputs([secondSink])).toEqual(['second'])
    logger.line('two')
    expect(logger.addOutput(firstSink)).toBe('first')
    logger.addOutput(firstSink)
    logger.line('three')
    await logger.close()

    expect(first.text()).toBe('one\nthree\n')
    expect(second.text()).toBe('two\nthree\n')
  })

  it('closes one sink by id and keeps the rest', async () => {
    const panel = sink()
    const console = sink()
    const panelSink = new StreamSink(panel.stream, 'tui-panel')
    const logger = new Logger({ outputs: [new StreamSink(console.stream, 'console'), panelSink] })

    logger.line('one')
    expect(await logger.closeSink('tui-panel')).toBe(true)
    logger.line('two')
    expect(await logger.closeSink('tui-panel')).toBe(false)
    expect(await logger.closeSink('missing')).toBe(false)
    await logger.close()

    expect(panel.text()).toBe('one\n')
    expect(console.text()).toBe('one\ntwo\n')
  })

  it('flushes a file closed by id', async () => {
    const file = join(directory, 'panel.log')
    const logger = new Logger({ outputs: [new FileSink(file, 'panel-file')] })

    logger.line('hello')
    expect(await logger.closeSink('panel-file')).toBe(true)
    await logger.close()

    expect(await readFile(file, 'utf8')).toBe('hello\n')
  })
})

describe('App log destinations', () => {
  function testApp(options: { env: NodeJS.ProcessEnv; logFile?: string; outputs?: LogSink[] }): {
    app: App
    out: { text: () => string }
  } {
    const out = sink()
    const app = new App({
      args: [],
      env: options.env,
      envFile: false,
      configFile: false,
      dataDirectory: join(directory, 'data'),
      cwd: join(directory, 'project'),
      output: out.stream,
      errorOutput: sink().stream,
      logFile: options.logFile,
      outputs: options.outputs,
    })
    return { app, out }
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({}), { status: 200 }))
  })

  it('sends diagnostics to MINIAGENT_LOG_FILE instead of stdout', async () => {
    const file = join(directory, 'app.log')
    const { app, out } = testApp({
      env: { MINIAGENT_CONTEXT_WINDOW: 'nope', MINIAGENT_LOG_FILE: file },
    })

    expect(await app.run()).toBe(0)

    expect(out.text()).toBe('')
    expect(await readFile(file, 'utf8')).toContain('[model] ignoring invalid')
  })

  it('prefers the logFile option over the environment', async () => {
    const file = join(directory, 'opt.log')
    const envFile = join(directory, 'env.log')
    const { app, out } = testApp({
      env: { MINIAGENT_CONTEXT_WINDOW: 'nope', MINIAGENT_LOG_FILE: envFile },
      logFile: file,
    })

    expect(await app.run()).toBe(0)

    expect(out.text()).toBe('')
    expect(await readFile(file, 'utf8')).toContain('[model] ignoring invalid')
    const envExists = await readFile(envFile, 'utf8')
      .then(() => true)
      .catch(() => false)
    expect(envExists).toBe(false)
  })

  it('tees to the file when channels are explicit', async () => {
    const file = join(directory, 'tee.log')
    const tee = sink()
    const { app, out } = testApp({
      env: { MINIAGENT_CONTEXT_WINDOW: 'nope' },
      logFile: file,
      outputs: [new StreamSink(tee.stream, 'tee')],
    })

    expect(await app.run()).toBe(0)

    expect(tee.text()).toContain('[model] ignoring invalid')
    expect(out.text()).toBe('')
    expect(await readFile(file, 'utf8')).toContain('[model] ignoring invalid')
  })

  it('tees the console and latest.log by default', async () => {
    const dataDirectory = join(directory, 'data')
    const out = sink()
    const app = new App({
      args: [],
      env: { MINIAGENT_CONTEXT_WINDOW: 'nope' },
      envFile: false,
      configFile: false,
      dataDirectory,
      cwd: join(directory, 'project'),
      output: out.stream,
      errorOutput: sink().stream,
    })

    expect(await app.run()).toBe(0)

    expect(out.text()).toContain('[model] ignoring invalid')
    expect(await readFile(join(dataDirectory, 'latest.log'), 'utf8')).toContain(
      '[model] ignoring invalid',
    )
  })

  it('restarts latest.log on every run', async () => {
    const dataDirectory = join(directory, 'data')
    const cwd = join(directory, 'project')
    const first = new App({
      args: [],
      env: { MINIAGENT_CONTEXT_WINDOW: 'nope' },
      envFile: false,
      configFile: false,
      dataDirectory,
      cwd,
      output: sink().stream,
      errorOutput: sink().stream,
    })
    expect(await first.run()).toBe(0)
    expect(await readFile(join(dataDirectory, 'latest.log'), 'utf8')).toContain(
      '[model] ignoring invalid',
    )

    const second = new App({
      args: [],
      env: { MINIAGENT_CONTEXT_WINDOW: '1000' },
      envFile: false,
      configFile: false,
      dataDirectory,
      cwd,
      output: sink().stream,
      errorOutput: sink().stream,
    })
    expect(await second.run()).toBe(0)

    const exists = await readFile(join(dataDirectory, 'latest.log'), 'utf8')
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  it('writes no latest.log when a log file is configured', async () => {
    const dataDirectory = join(directory, 'data')
    const app = new App({
      args: [],
      env: { MINIAGENT_CONTEXT_WINDOW: 'nope' },
      envFile: false,
      configFile: false,
      dataDirectory,
      cwd: join(directory, 'project'),
      output: sink().stream,
      errorOutput: sink().stream,
      logFile: join(directory, 'custom.log'),
    })

    expect(await app.run()).toBe(0)

    expect(await readFile(join(directory, 'custom.log'), 'utf8')).toContain(
      '[model] ignoring invalid',
    )
    const exists = await readFile(join(dataDirectory, 'latest.log'), 'utf8')
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  it('drops info diagnostics at higher levels', async () => {
    const dataDirectory = join(directory, 'data')
    const out = sink()
    const app = new App({
      args: [],
      env: { MINIAGENT_CONTEXT_WINDOW: 'nope', MINIAGENT_LOG_LEVEL: 'error' },
      envFile: false,
      configFile: false,
      dataDirectory,
      cwd: join(directory, 'project'),
      output: out.stream,
      errorOutput: sink().stream,
    })

    expect(await app.run()).toBe(0)
    expect(app.logger.level).toBe('error')

    expect(out.text()).toBe('')
    const exists = await readFile(join(dataDirectory, 'latest.log'), 'utf8')
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  it('takes the level from the option over the environment', async () => {
    const app = new App({
      args: [],
      env: { MINIAGENT_CONTEXT_WINDOW: '1000', MINIAGENT_LOG_LEVEL: 'error' },
      envFile: false,
      configFile: false,
      dataDirectory: join(directory, 'data'),
      cwd: join(directory, 'project'),
      output: sink().stream,
      errorOutput: sink().stream,
      logLevel: 'debug',
    })

    expect(await app.run()).toBe(0)
    expect(app.logger.level).toBe('debug')
  })
})
