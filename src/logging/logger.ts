import pino, { type Logger } from 'pino'
import pretty from 'pino-pretty'
import { dirname, join } from 'node:path'
import { renameSync, rmSync } from 'node:fs'

/**
 * Human-readable console stream. Writes pretty logs to `process.stdout`
 * (passed as the object, so stdout captures keep working); log files keep
 * raw JSON. Shared so repeated instantiation does not pile listeners onto
 * `process.stdout`.
 */
let sharedConsole: ReturnType<typeof pretty> | undefined
function consoleStream(): ReturnType<typeof pretty> {
  sharedConsole ??= pretty({ translateTime: 'SYS:standard', destination: process.stdout })
  return sharedConsole
}

function fileDestination(dest: string): pino.DestinationStream {
  return pino.destination({ dest, mkdir: true, sync: true })
}

/** Resolves the file target: explicit file, else `<dataDirectory>/log/latest.log`. */
function resolveFile(
  dataDirectory: string,
  env: NodeJS.ProcessEnv,
  logFile: string | undefined,
): { dest: string; latestFile: string | undefined } {
  const file = logFile ?? env.MINIAGENT_LOG_FILE
  if (file !== undefined) {
    return { dest: file, latestFile: undefined }
  }
  const latest = join(dataDirectory, 'log', 'latest.log')
  try {
    rmSync(latest, { force: true })
  } catch {
    // A stale log is harmless; the destination appends to it below.
  }
  return { dest: latest, latestFile: latest }
}

/**
 * Headless logger: console and file together. Multistream only lives here,
 * the one place two outputs are needed.
 */
export function headlessLogger(
  dataDirectory: string,
  env: NodeJS.ProcessEnv,
  logLevel: string | undefined,
  logFile: string | undefined,
): { logger: Logger; latestFile: string | undefined } {
  const { dest, latestFile } = resolveFile(dataDirectory, env, logFile)
  const logger = buildLogger(
    resolveLevel(logLevel ?? env.MINIAGENT_LOG_LEVEL),
    pino.multistream([consoleStream(), fileDestination(dest)]),
  )
  return { logger, latestFile }
}

/** TUI logger: file only. No multistream, single destination. */
export function fileLogger(
  dataDirectory: string,
  env: NodeJS.ProcessEnv,
  logLevel: string | undefined,
  logFile: string | undefined,
): { logger: Logger; latestFile: string | undefined } {
  const { dest, latestFile } = resolveFile(dataDirectory, env, logFile)
  const logger = buildLogger(
    resolveLevel(logLevel ?? env.MINIAGENT_LOG_LEVEL),
    fileDestination(dest),
  )
  return { logger, latestFile }
}

/** Builds one pino logger on the given destination at the given level. */
function buildLogger(
  level: 'debug' | 'info' | 'warn' | 'error',
  destination: pino.DestinationStream,
): Logger {
  return pino({ level }, destination)
}

/** Entry-point logger: console only, for boot failures before the app logger exists. */
export function cliLogger(): Logger {
  return pino({ level: 'info', base: undefined }).child({ module: 'cli' })
}

/**
 * Builds the default diagnostics logger. Headless (no TTY): console and
 * `<dataDirectory>/log/latest.log` together. TUI (TTY): file only, so raw
 * `stdout` writes never corrupt Ink frames. The log file when configured
 * wins in both modes. The latest file is renamed to the finish time at the
 * end of the run (see `renameFinishedLog`). The console gets pretty
 * human-readable output; files keep newline-delimited JSON.
 */
export function defaultLogger(
  dataDirectory: string,
  env: NodeJS.ProcessEnv,
  logLevel: string | undefined,
  logFile: string | undefined,
): { logger: Logger; latestFile: string | undefined } {
  if (process.stdout.isTTY === true) {
    return fileLogger(dataDirectory, env, logLevel, logFile)
  }
  return headlessLogger(dataDirectory, env, logLevel, logFile)
}

/**
 * Renames a finished run's log to the local time it finished at, next to
 * itself (`2026-10-12_14-30-00-042.log`). Every run keeps its file: boot
 * diagnostics log at info, so no run is quiet. A missing file is left
 * alone. Never throws: logging must not fail the run.
 */
export function renameFinishedLog(latest: string | undefined): void {
  if (latest === undefined) {
    return
  }
  try {
    renameSync(latest, join(dirname(latest), `${localTimestamp()}.log`))
  } catch {
    // Best effort: the log already went to the console.
  }
}

/** Local wall-clock time, filesystem-safe and sortable. */
export function localTimestamp(date = new Date()): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-` +
    `${pad(date.getMilliseconds(), 3)}`
  )
}

/** Reads a log level from flags or environment. Unknown names fall back to `'info'`. */
export function resolveLevel(value: unknown): 'debug' | 'info' | 'warn' | 'error' {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
    ? value
    : 'info'
}
