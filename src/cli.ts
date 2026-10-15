import { Command } from 'commander'

import { App } from './app/app.js'
import { VERSION } from './build-info.js'

/**
 * Builds the command-line interface: the program name, the `-v` / `--version`
 * flag, and the `--log-file` option. Commander owns the generated help
 * (`-h`, `--help`) and the parsing of the options.
 */
export function buildCli(version: string = VERSION): Command {
  return new Command()
    .name('miniagent')
    .description('Minimal AI agent built on the AI SDK')
    .version(version, '-v, --version', 'output the version number')
    .option('--log-file <path>', 'tee diagnostics to a file as well as stdout')
    .option('--log-level <level>', 'quietest log level to emit (debug, info, warn, error)')
}

/**
 * Parses the arguments after the script name and boots the app.
 * `--help` and `--version` are handled by the command itself,
 * which prints and exits before the app is built.
 *
 * Owns process signals: on SIGINT/SIGTERM open sessions are saved and the
 * process exits with the conventional code. `App` itself never exits, so it
 * stays safe to embed.
 */
export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const program = buildCli()
  program.parse([...argv], { from: 'user' })

  const { logFile, logLevel } = program.opts() as { logFile?: string; logLevel?: string }
  const app = new App({ logFile, logLevel })
  const onSigint = (): void => {
    void shutdownAndExit(app, 130)
  }
  const onSigterm = (): void => {
    void shutdownAndExit(app, 143)
  }
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  try {
    return await app.run()
  } finally {
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
  }
}

async function shutdownAndExit(app: App, code: number): Promise<never> {
  try {
    await app.shutdown()
  } finally {
    app.logger.flush()
    process.exit(code)
  }
}
