import { cliLogger } from './logging/logger.js'
import { runCli } from './cli.js'

// Boots the app: parses the command line, loads configuration, and builds the
// agent. The conversation itself (REPL, web, ...) is driven by a layer on top
// of `app.agent`.
const logger = cliLogger()
try {
  process.exitCode = await runCli()
} catch (error) {
  logger.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  logger.flush()
}
