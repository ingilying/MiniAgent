import { Command } from 'commander'

import { App } from './app.js'
import { VERSION } from './build-info.js'
import { parseLogLevel } from './logger.js'

/**
 * Builds the command-line interface: the program name, the `-v` / `--version`
 * flag, the `--log-file` option, and the optional prompt argument. Commander
 * owns the generated help (`-h`, `--help`) and the parsing of the options.
 */
export function buildCli(version: string = VERSION): Command {
  return new Command()
    .name('miniagent')
    .description('Minimal AI agent built on the AI SDK')
    .version(version, '-v, --version', 'output the version number')
    .option('--log-file <path>', 'append diagnostics to a file instead of stdout/stderr')
    .option('--log-level <level>', 'quietest log level to emit (debug, info, warn, error)')
    .argument('[prompt]', 'initial prompt to send to the agent')
}

/**
 * Parses the arguments after the script name and boots the app with the
 * resulting prompt. `--help` and `--version` are handled by the command itself,
 * which prints and exits before the app is built.
 *
 * Owns process signals: on SIGINT/SIGTERM open sessions are saved and the
 * process exits with the conventional code. `App` itself never exits, so it
 * stays safe to embed.
 */
export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const program = buildCli()
  program.parse([...argv], { from: 'user' })

  const prompt = program.args[0]
  const { logFile, logLevel } = program.opts() as { logFile?: string; logLevel?: string }
  return new App({
    args: prompt === undefined ? [] : [prompt],
    logFile,
    logLevel: parseLogLevel(logLevel),
  }).run()
}
