import { runCli } from './cli.js'
import { Logger } from './logger.js'

// Boots the app: parses the command line, loads configuration, and builds the
// agent. The conversation itself (REPL, web, ...) is driven by a layer on top
// of `app.agent`.
const logger = new Logger()
try {
  process.exitCode = await runCli()
} catch (error) {
  logger.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await logger.close()
}
