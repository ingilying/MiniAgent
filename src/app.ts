import { homedir } from 'node:os'
import { join } from 'node:path'

import { RELEASE, VERSION } from './build-info.js'

import { NoSuchProviderError } from 'ai'

import { Agent } from './agent.js'
import { type AppConfig, loadConfig } from './config.js'
import { Context } from './context.js'
import { createModel, loadSettings, providerEnvVar, providerList } from './providers.js'
import type { ProviderOptions } from './providers.js'
import { FileContextStore } from './store.js'
import { calculatorTool } from './tools/calculator.js'
import { getCurrentTimeTool } from './tools/current-time.js'

const SYSTEM_PROMPT =
  'You are a precise, helpful assistant. ' +
  'Use the available tools for facts you cannot know, such as math and the current time.'

/** Data directory used when running from source (`src/`), e.g. under `tsx`. */
const DEV_DATA_DIRECTORY = '.miniagent'

/** Provider used when neither the session nor the config file names one. */
const DEFAULT_PROVIDER = 'openai'

/**
 * Whether this build is a release. The value is stamped at build time
 * (`MINIAGENT_RELEASE=1`) into `src/build-info.ts` by scripts/build-info.mjs.
 */
export function isReleaseBuild(): boolean {
  return RELEASE
}

/**
 * Default directory holding the model cache and persisted sessions:
 * `$HOME/.config/miniagent` in a release build, `.miniagent` in the checkout.
 */
export function defaultDataDirectory(): string {
  return isReleaseBuild() ? join(homedir(), '.config', 'miniagent') : DEV_DATA_DIRECTORY
}

export interface AppOptions {
  /** Arguments after the script name. Defaults to `process.argv.slice(2)`. */
  args?: readonly string[]
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
  /** Standard output for diagnostics. Defaults to `process.stdout`. */
  output?: NodeJS.WritableStream
  /** Standard error for diagnostics. Defaults to `process.stderr`. */
  errorOutput?: NodeJS.WritableStream
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
  /** Session used when `MINIAGENT_SESSION` is unset. Defaults to `default`. */
  defaultSession?: string
}

/**
 * Application bootstrap: resolves configuration and builds the agent.
 *
 * It does not talk to the user. `run()` only loads the environment and config
 * file, restores the session's `Context` (which keeps its stored provider and
 * model), resolves their context window, and constructs the `Agent` on top.
 *
 * Everything it needs from the outside world is injected, so it can be driven
 * by tests without a TTY, a network, or a real model.
 */
export class App {
  private readonly args: readonly string[]
  private readonly env: NodeJS.ProcessEnv
  private readonly output: NodeJS.WritableStream
  private readonly errorOutput: NodeJS.WritableStream
  private readonly injectedAgent: Agent | undefined
  private readonly catalogUrl: string | undefined
  private readonly defaultProvider: string
  private readonly defaultModel: string
  private readonly defaultSession: string
  private readonly envFile: string | false
  private readonly configFile: string | false

  /** Directory holding sessions, the config file, and the model cache. */
  readonly dataDirectory: string
  /** Version stamped into this build. */
  readonly version: string

  /** First positional argument, resolved by `run()`. */
  prompt: string | undefined
  /** Session name, resolved by `run()`. */
  session: string | undefined
  /** Provider id, resolved by `run()`. */
  providerId: string | undefined
  /** Model id, resolved by `run()`. */
  modelId: string | undefined
  /** Conversation the agent works on, resolved by `run()`. */
  context: Context | undefined
  /** Agent built by `run()` (or the injected one). */
  agent: Agent | undefined

  constructor(options: AppOptions = {}) {
    this.args = options.args ?? process.argv.slice(2)
    this.env = options.env ?? process.env
    this.output = options.output ?? process.stdout
    this.errorOutput = options.errorOutput ?? process.stderr
    this.injectedAgent = options.agent
    this.catalogUrl = options.catalogUrl
    this.dataDirectory = options.dataDirectory ?? defaultDataDirectory()
    this.version = VERSION
    this.defaultProvider = options.defaultProvider ?? DEFAULT_PROVIDER
    this.defaultModel = options.defaultModel ?? 'gpt-6-astra'
    this.defaultSession = options.defaultSession ?? 'default'
    this.envFile = options.envFile ?? join(process.cwd(), '.env')
    this.configFile = options.configFile ?? join(this.dataDirectory, 'config.json')
  }

  /**
   * Loads the configuration and builds the agent. Returns `1` when the
   * provider is unknown or its API key is missing, `0` otherwise.
   */
  async run(): Promise<number> {
    this.readEnvFile()
    const config = await this.readConfig()

    this.session = this.env.MINIAGENT_SESSION ?? this.defaultSession
    this.prompt = this.args[0]

    const context = await this.loadContext(config)
    this.context = context
    this.providerId = context.providerId
    this.modelId = context.modelId ?? this.defaultModel

    loadSettings(this.providerSettings(config))

    try {
      createModel(this.providerId, this.modelId)
    } catch (error) {
      if (NoSuchProviderError.isInstance(error)) {
        this.error(
          `Unknown provider "${this.providerId}". Known providers: ${providerList().join(', ')}.`,
        )
      } else {
        this.error(error instanceof Error ? error.message : String(error))
      }
      return 1
    }

    const apiKey = this.resolveApiKey(this.providerId, config)
    const baseUrl = config.providers?.[this.providerId]?.baseUrl
    if (apiKey === undefined && baseUrl === undefined) {
      this.error(
        `Missing API key for provider "${this.providerId}". ` + this.apiKeyHint(this.providerId),
      )
      return 1
    }

    if (this.injectedAgent === undefined) {
      try {
        this.agent = this.buildAgent(this.providerId, this.modelId, context)
      } catch (error) {
        this.error(error instanceof Error ? error.message : String(error))
        return 1
      }
    } else {
      this.agent = this.injectedAgent
    }

    await context.initRemote()
    return 0
  }

  /**
   * Merges the `.env` file into the environment. Values already present in the
   * environment win, and a missing file is fine; any other read failure is
   * reported so it does not masquerade as a missing credential.
   */
  private readEnvFile(): void {
    if (this.envFile === false) {
      return
    }
    try {
      process.loadEnvFile(this.envFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.line(`[env] could not read ${this.envFile}: ${String(error)}`)
      }
    }
  }

  /** Reads the config file; a missing one is fine, a broken one is reported. */
  private async readConfig(): Promise<AppConfig> {
    if (this.configFile === false) {
      return {}
    }
    try {
      return await loadConfig(this.configFile)
    } catch (error) {
      this.line(`[config] could not read ${this.configFile}: ${String(error)}`)
      return {}
    }
  }

  /**
   * Restores the session's conversation. The stored provider and model win;
   * the config file and environment only apply to a fresh or legacy session.
   */
  private loadContext(config: AppConfig): Promise<Context> {
    const store = new FileContextStore(join(this.dataDirectory, 'contexts'))
    return Context.load(store, this.session ?? this.defaultSession, {
      providerId: config.provider ?? this.defaultProvider,
      modelId: config.model ?? this.env.OPENAI_MODEL ?? this.defaultModel,
      env: this.env,
      catalogUrl: this.catalogUrl,
      dataDirectory: this.dataDirectory,
      onModelLine: (line) => this.line(line),
    })
  }

  /**
   * Per-provider settings for the registry: the config file's `providers`
   * block with every API key resolved (config file, then environment).
   */
  private providerSettings(config: AppConfig): Record<string, ProviderOptions> {
    const settings: Record<string, ProviderOptions> = {}
    const ids = new Set([
      ...Object.keys(config.providers ?? {}),
      ...Object.keys(config.apiKeys ?? {}),
    ])
    for (const id of ids) {
      settings[id] = {
        apiKey: this.resolveApiKey(id, config),
        baseUrl: config.providers?.[id]?.baseUrl,
      }
    }
    return settings
  }

  /** API key for a provider: `providers.<id>.apiKey`, then `apiKeys.<id>`, then the env var. */
  private resolveApiKey(providerId: string, config: AppConfig): string | undefined {
    const fromProvider = config.providers?.[providerId]?.apiKey
    if (fromProvider !== undefined) {
      return fromProvider
    }
    const fromConfig = config.apiKeys?.[providerId]
    if (fromConfig !== undefined) {
      return fromConfig
    }
    const envVar = providerEnvVar(providerId)
    const fromEnv = envVar === undefined ? undefined : this.env[envVar]
    return fromEnv === undefined || fromEnv === '' ? undefined : fromEnv
  }

  private apiKeyHint(providerId: string): string {
    const sources: string[] = []
    if (this.configFile !== false) {
      sources.push(`providers.${providerId}.apiKey or apiKeys.${providerId} in ${this.configFile}`)
    }
    const envVar = providerEnvVar(providerId)
    if (envVar !== undefined) {
      sources.push(`${envVar} in the environment`)
    }
    return sources.length === 0 ? '' : `Set ${sources.join(' or ')}.`
  }

  private buildAgent(providerId: string, modelId: string, context: Context): Agent {
    return new Agent({
      model: createModel(providerId, modelId),
      system: SYSTEM_PROMPT,
      tools: { calculator: calculatorTool, getCurrentTime: getCurrentTimeTool },
      context,
      maxSteps: 8,
    })
  }

  private line(text = ''): void {
    this.output.write(`${text}\n`)
  }

  private error(text: string): void {
    this.errorOutput.write(`${text}\n`)
  }
}
