import pino from 'pino'

import { runCli } from './cli.js'

// Boots the app: parses the command line, loads configuration, and builds the
// agent. The conversation itself (REPL, web, ...) is driven by a layer on top
// of `app.agent`.
const logger = pino({ level: 'info', base: undefined }).child({ module: 'cli' })
try {
  process.exitCode = await runCli()
} catch (error) {
  logger.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  logger.flush()
}
