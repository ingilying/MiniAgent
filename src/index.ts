import { runCli } from './cli.js'

// Boots the app: parses the command line, loads configuration, and builds the
// agent. The conversation itself (REPL, web, ...) is driven by a layer on top
// of `app.agent`.
try {
  process.exitCode = await runCli()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
