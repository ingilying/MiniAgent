import { once } from 'node:events'
import { createWriteStream, mkdirSync } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { dirname } from 'node:path'

/**
 * One log destination. The logger only ever calls `write` to fan out and
 * `close` to flush: streams, files, and future kinds all look the same.
 */
export interface LogSink {
  /**
   * Caller-chosen name (`'stdio'`, `'session-file'`, a TUI panel id, ...).
   * `Logger.closeSink` finds sinks by it, so keep it unique per logger.
   */
  readonly id: string
  /** Writes one line (without trailing newline handling: pass it ready). */
  write(line: string): void
  /** Flushes the destination. Absent when there is nothing to flush. */
  close?(): Promise<void>
}

/** A console (or in-memory) destination: writes straight through to a stream. */
export class StreamSink implements LogSink {
  constructor(
    private readonly stream: NodeJS.WritableStream = process.stdout,
    readonly id: string = 'stdio',
  ) {}

  write(line: string): void {
    this.stream.write(line)
  }

  async close(): Promise<void> {
    await (this.stream as Partial<LogSink>).close?.()
  }
}

/** Severity levels, quietest first. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

/** One severity level. */
export type LogLevel = (typeof LOG_LEVELS)[number]

const LOG_SEVERITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

/**
 * Reads a log level from user input (flags, environment). Returns
 * `undefined` for anything but the four level names.
 */
export function parseLogLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  return LOG_LEVELS.find((level) => level === value.toLowerCase())
}

/**
 * A file destination: opens the file lazily on first write and appends.
 * A file that cannot be written falls back to the given sink with a
 * one-line notice, so logging never crashes the app.
 */
export class FileSink implements LogSink {
  private stream: WriteStream | undefined
  private broken = false

  constructor(
    readonly path: string,
    readonly id: string = 'file',
    private readonly fallback: LogSink = stderrSink,
  ) {}

  write(line: string): void {
    if (!this.broken) {
      const stream = this.open()
      if (stream !== undefined) {
        stream.write(line)
        return
      }
    }
    this.fallback.write(line)
  }

  async close(): Promise<void> {
    const stream = this.stream
    if (stream === undefined) {
      return
    }
    stream.end()
    try {
      await once(stream, 'close')
    } catch {
      // Best effort: the logs already went out or fell back.
    }
  }

  private open(): WriteStream | undefined {
    if (this.stream !== undefined) {
      return this.stream
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const stream = createWriteStream(this.path, { flags: 'a' })
      stream.on('error', (cause) => this.fail(cause))
      this.stream = stream
      return stream
    } catch (cause) {
      this.fail(cause)
      return undefined
    }
  }

  private fail(cause: unknown): void {
    this.broken = true
    this.fallback.write(`[log] cannot write ${this.path}: ${messageOf(cause)}\n`)
  }
}

/** Shared console destination used when no outputs are configured. */
export const stdoutSink: LogSink = new StreamSink(process.stdout, 'stdio')

/** Shared console destination for errors. */
export const stderrSink: LogSink = new StreamSink(process.stderr, 'stderr')

export interface LoggerOptions {
  /**
   * Diagnostics channels. Defaults to the console. Replaceable at runtime
   * with `setOutputs` / `addOutput`.
   */
  outputs?: LogSink[]
  /**
   * Error channels. Defaults to the console error stream. Replaceable at
   * runtime with `setErrorOutputs` / `addErrorOutput`.
   */
  errorOutputs?: LogSink[]
  /**
   * Quietest level still emitted. Quieter calls are dropped before
   * reaching the sinks. Defaults to `'info'`.
   */
  level?: LogLevel
}

/**
 * Application diagnostics: `line()` writes to every output, `error()` to
 * every error output. Mix consoles and files freely:
 *
 * ```ts
 * const logger = new Logger()
 * const panel = new StreamSink(tuiStream, 'tui-panel')
 * logger.addOutput(panel)
 * // ... later, when the panel closes:
 * await logger.closeSink('tui-panel')
 * ```
 */
export class Logger {
  private outputs: LogSink[]
  private errorOutputs: LogSink[]
  private readonly known = new Set<LogSink>()

  /** Quietest level this logger still emits. */
  readonly level: LogLevel

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info'
    this.outputs = options.outputs === undefined ? [stdoutSink] : [...options.outputs]
    this.errorOutputs =
      options.errorOutputs === undefined ? [stderrSink] : [...options.errorOutputs]
    for (const sink of [...this.outputs, ...this.errorOutputs]) {
      this.known.add(sink)
    }
  }

  /** Writes a debug line to every output. */
  debug(text: string): void {
    this.at('debug', this.outputs, text)
  }

  /** Writes a line to every output. Kept as the info-level shorthand. */
  line(text = ''): void {
    this.info(text)
  }

  /** Writes an info line to every output. */
  info(text: string): void {
    this.at('info', this.outputs, text)
  }

  /** Writes a warning line to every error output. */
  warn(text: string): void {
    this.at('warn', this.errorOutputs, text)
  }

  /** Writes a line to every error output. */
  error(text: string): void {
    this.at('error', this.errorOutputs, text)
  }

  /** Replaces the outputs. Returns their ids. */
  setOutputs(sinks: LogSink[]): string[] {
    this.outputs = sinks.length > 0 ? [...sinks] : [stdoutSink]
    return this.register(this.outputs)
  }

  /** Replaces the error outputs. Returns their ids. */
  setErrorOutputs(sinks: LogSink[]): string[] {
    this.errorOutputs = sinks.length > 0 ? [...sinks] : [stderrSink]
    return this.register(this.errorOutputs)
  }

  /** Appends an output unless it is already listed. Returns its id. */
  addOutput(sink: LogSink): string {
    if (!this.outputs.includes(sink)) {
      this.outputs.push(sink)
    }
    return this.register([sink])[0] as string
  }

  /** Appends an error output unless it is already listed. Returns its id. */
  addErrorOutput(sink: LogSink): string {
    if (!this.errorOutputs.includes(sink)) {
      this.errorOutputs.push(sink)
    }
    return this.register([sink])[0] as string
  }

  /**
   * Closes every sink with the id and removes them from the lists.
   * A plugin calls this to tear down its own destination (a TUI panel,
   * a file) without touching the rest. Returns whether any matched.
   */
  async closeSink(id: string): Promise<boolean> {
    const matched = [...this.known].filter((sink) => sink.id === id)
    if (matched.length === 0) {
      return false
    }
    this.outputs = this.outputs.filter((sink) => sink.id !== id)
    this.errorOutputs = this.errorOutputs.filter((sink) => sink.id !== id)
    for (const sink of matched) {
      this.known.delete(sink)
      try {
        await sink.close?.()
      } catch {
        // Best effort: the logs already went out or fell back.
      }
    }
    return true
  }

  /**
   * Flushes every destination ever added, including replaced ones.
   * Call when the app closes.
   */
  async close(): Promise<void> {
    for (const sink of this.known) {
      try {
        await sink.close?.()
      } catch {
        // Best effort: the logs already went out or fell back.
      }
    }
    this.known.clear()
  }

  private register(sinks: readonly LogSink[]): string[] {
    for (const sink of sinks) {
      this.known.add(sink)
    }
    return sinks.map((sink) => sink.id)
  }

  private at(level: LogLevel, channels: readonly LogSink[], text: string): void {
    if (LOG_SEVERITY[level] < LOG_SEVERITY[this.level]) {
      return
    }
    this.write(channels, `${text}\n`)
  }

  private write(channels: readonly LogSink[], text: string): void {
    for (const channel of channels) {
      channel.write(text)
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
