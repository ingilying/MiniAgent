import pino, { type Logger } from 'pino'
import { dirname, join } from 'node:path'
import { renameSync, rmSync } from 'node:fs'

/**
 * Builds the default diagnostics logger: the log file when configured,
 * else a tee of the console and `<dataDirectory>/log/latest.log`, restarted
 * every run. The latest file is renamed to the finish time at the end of
 * the run (see `renameFinishedLog`).
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
      logger: pino({ level },
        pino.multistream([
          process.stdout,
          pino.destination({ dest: file, mkdir: true, sync: true }),
        ]),
      ),
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
      pino.multistream([
        process.stdout,
        pino.destination({ dest: latest, mkdir: true, sync: true }),
      ]),
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
