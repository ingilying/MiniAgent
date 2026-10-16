import type { Logger } from 'pino'

import type { Agent } from '../agent/agent.js'

/** Everything `App` takes from the outside world. Every field is optional. */
export interface AppOptions {
  /**
   * Environment variables used to resolve configuration. Defaults to
   * `process.env`, which the `.env` file is merged into. Pass a different
   * object to keep a test isolated from the real environment.
   */
  env?: NodeJS.ProcessEnv
  /**
   * Path of the `.env` file merged into the environment before the
   * configuration is read. Defaults to `.env` in the current directory; pass
   * `false` to skip it.
   */
  envFile?: string | false
  /**
   * Logger used for diagnostics. Defaults to one writing to stdout, or to
   * `logFile` when set; pass one to capture it (tests use a memory sink).
   */
  logger?: Logger
  /**
   * Quietest log level still emitted. Falls back to `MINIAGENT_LOG_LEVEL`,
   * then `'info'`. Unknown names fall back silently.
   */
  logLevel?: string
  /**
   * File diagnostics tee to as well as the console. Falls back to
   * `MINIAGENT_LOG_FILE`. Without either, diagnostics tee to the console
   * and `<dataDirectory>/log/latest.log`, renamed to the finish time when
   * the run ends.
   */
  logFile?: string
  /** Use this agent instead of building one from the provider registry. */
  agent?: Agent
  /** Model catalog endpoint. Defaults to models.dev. */
  catalogUrl?: string
  /** Directory holding sessions, the config file, and the model cache. Defaults to `.miniagent` in a checkout, `$HOME/.config/miniagent` in a release build. */
  dataDirectory?: string
  /**
   * Path of the JSON config file. Defaults to `config.json` in the data
   * directory; pass `false` to skip it.
   */
  configFile?: string | false
  /** Provider used when neither the session nor the config file names one. Defaults to `openai`. */
  defaultProvider?: string
  /** Model used when neither the config file nor `OPENAI_MODEL` names one. Defaults to `gpt-6-astra`. */
  defaultModel?: string
  /**
   * Session used when `MINIAGENT_SESSION` is unset. When omitted, a new
   * session is created for the instance.
   */
  defaultSession?: string
  /**
   * Project directory the session history is scoped to. Defaults to
   * `process.cwd()`.
   */
  cwd?: string
}
