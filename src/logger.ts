import pino, { type Logger } from 'pino'
import pretty from 'pino-pretty'
import { dirname, join } from 'node:path'
import { renameSync, rmSync } from 'node:fs'

type Tee = ReturnType<typeof pino.multistream>

/**
 * Human-readable console stream. Writes pretty logs to `process.stdout`
 * (passed as the object, so stdout captures keep working); the log file
 * destinations below keep raw JSON. Shared across loggers so repeated
 * instantiation does not pile listeners onto `process.stdout`.
 */
let sharedConsole: ReturnType<typeof pretty> | undefined
function consoleStream(): ReturnType<typeof pretty> {
  sharedConsole ??= pretty({ translateTime: 'SYS:standard', destination: process.stdout })
  return sharedConsole
}

/**
 * Whether new loggers still tee to the console. The TUI plugin closes the
 * console stream while it owns the screen (see `setConsoleEnabled`); Ink
 * cannot intercept raw `stdout` writes, so they would corrupt its frames.
 * The file tee keeps every line either way.
 */
let consoleEnabled = true

/** Live tee destinations, so the console stream detaches from all of them at once. */
const liveTees: Tee[] = []

/**
 * Closes the shared console stream (`false`) or attaches a fresh one
 * (`true`) on every live logger. File logging is unaffected: nothing is
 * lost, it just stops reaching the screen while closed.
 */
export function setConsoleEnabled(enabled: boolean): void {
  consoleEnabled = enabled
  if (enabled) {
    const fresh = consoleStream()
    for (const tee of liveTees) {
      if (!tee.streams.some((entry) => entry.stream === fresh)) {
        tee.add(fresh)
      }
    }
    return
  }
  for (const tee of liveTees) {
    const id = consoleEntryId(tee)
    if (id !== undefined) {
      tee.remove(id)
    }
  }
  sharedConsole?.end()
  sharedConsole = undefined
}

/** Runtime id pino assigns each tee entry; the public types omit it. */
function consoleEntryId(tee: Tee): number | undefined {
  const entry = tee.streams.find((candidate) => candidate.stream === sharedConsole)
  return (entry as unknown as { id?: number } | undefined)?.id
}

/** Builds a tee destination and registers it for console detach. */
function teeDestination(file: { dest: string; mkdir: boolean; sync: boolean }): Tee {
  const tee = consoleEnabled
    ? pino.multistream([consoleStream(), pino.destination(file)])
    : pino.multistream([pino.destination(file)])
  liveTees.push(tee)
  return tee
}

/**
 * Builds the default diagnostics logger: the log file when configured,
 * else a tee of the console and `<dataDirectory>/log/latest.log`, restarted
 * every run. The latest file is renamed to the finish time at the end of
 * the run (see `renameFinishedLog`). The console gets pretty
 * human-readable output; files keep newline-delimited JSON.
 */
export function defaultLogger(
  dataDirectory: string,
  env: NodeJS.ProcessEnv,
  logLevel: string | undefined,
  logFile: string | undefined,
): { logger: Logger; latestFile: string | undefined } {
  const level = resolveLevel(logLevel ?? env.MINIAGENT_LOG_LEVEL)
  const file = logFile ?? env.MINIAGENT_LOG_FILE
  if (file !== undefined) {
    return {
      logger: pino({ level }, teeDestination({ dest: file, mkdir: true, sync: true })),
      latestFile: undefined,
    }
  }
  const latest = join(dataDirectory, 'log', 'latest.log')
  try {
    rmSync(latest, { force: true })
  } catch {
    // A stale log is harmless; the destination appends to it below.
  }
  return {
    logger: pino(
      { level, base: undefined },
      teeDestination({ dest: latest, mkdir: true, sync: true }),
    ),
    latestFile: latest,
  }
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
