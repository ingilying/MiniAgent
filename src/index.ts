import { App } from './app.js'

// Boots the app: loads configuration and builds the agent. The conversation
// itself (REPL, web, ...) is driven by a layer on top of `app.agent`.
try {
  process.exitCode = await new App().run()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
