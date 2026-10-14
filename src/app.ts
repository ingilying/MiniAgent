import { homedir } from 'node:os'
import { join } from 'node:path'

import { RELEASE, VERSION } from './build-info.js'

import { NoSuchProviderError } from 'ai'
import type { ToolSet } from 'ai'

import { Agent } from './agent.js'
import { AgentsManager } from './agents.js'
import { CommandRegistry, helpCommand, modelCommand, quitCommand } from './commands.js'
import { type AppConfig, loadConfig } from './config.js'
import { Context } from './context.js'
import { PluginManager } from './plugins/manager.js'
import type { Plugin, PluginHost, RunHost } from './plugins/types.js'
import { loadProviders } from './providers.js'
import type { Providers } from './providers.js'
import { SessionManager } from './sessions.js'
import { FileContextStore } from './store.js'
import { defaultLogger, renameFinishedLog } from './logger.js'
import type { Logger } from 'pino'

const SYSTEM_PROMPT =
  'You are a precise, helpful assistant. ' +
  'Use the available tools to read and change files and run shell commands.'

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

/**
 * Application bootstrap: resolves configuration and builds the agent.
 *
 * It does not talk to the user. `run()` loads the environment and config
 * file, opens a new session for the project directory (or resumes the one
 * named by `MINIAGENT_SESSION`), resolves its context window, and constructs
 * the `Agent` on top. Open sessions are saved on shutdown, and empty ones
 * are pruned, so a fresh instance never leaves a file behind.
 *
 * Everything it needs from the outside world is injected, so it can be driven
 * by tests without a TTY, a network, or a real model.
 */
export class App {
  private readonly env: NodeJS.ProcessEnv
  private readonly injectedAgent: Agent | undefined
  private readonly catalogUrl: string | undefined
  private readonly defaultProvider: string
  private readonly defaultModel: string
  private readonly defaultSession: string | undefined
  private readonly envFile: string | false
  private readonly configFile: string | false

  /** Unbound logger every module child derives from: each module binds
   * directly on the root. */
  private readonly root: Logger
  /** Diagnostics logger for the app module. */
  readonly logger: Logger
  /**
   * Active default log file (`<dataDirectory>/log/latest.log`), renamed to
   * a timestamp at the end of the run. Absent with an injected logger or
   * an explicit log file.
   */
  private readonly latestFile: string | undefined

  /** Directory holding sessions, the config file, and the model cache. */
  readonly dataDirectory: string
  /** Project directory the session history is scoped to. */
  readonly cwd: string
  /** Version stamped into this build. */
  readonly version: string

  /** Boot session id, resolved by `run()`. A new id per instance unless resumed. */
  sessionId: string | undefined
  /** Provider id, resolved by `run()`. */
  providerId: string | undefined
  /** Model id, resolved by `run()`. */
  modelId: string | undefined
  /**
   * Boot session opened by `run()` for this instance: the default agent
   * works here. The manager owns all sessions;
   * this is just the instance's own handle into it.
   */
  context: Context | undefined
  /** Sessions open in this process plus the history of the directory. */
  sessions: SessionManager | undefined
  /** Cached agents, one per session. Plugins drive them directly. */
  agents: AgentsManager | undefined
  /** Agent built by `run()` (or the injected one). */
  agent: Agent | undefined

  providers: Providers | undefined
  /** Plugins plus the phases to drive them. */
  private readonly pluginManager: PluginManager
  /** Live tool set merged from built-ins and plugins. */
  tools: ToolSet
  /** System prompt parts: base prompt first, plugin parts after in load order. */
  systemPromptParts: string[]
  /** Core-owned slash commands, exposed to plugins as read-only. */
  readonly commands: CommandRegistry
  /** Loaded plugins in load order, built-ins first. */
  get plugins(): Plugin[] {
    return this.pluginManager.plugins
  }

  constructor(options: AppOptions = {}) {
    this.env = options.env ?? process.env
    this.dataDirectory = options.dataDirectory ?? defaultDataDirectory()
    this.cwd = options.cwd ?? process.cwd()
    const chosen =
      options.logger === undefined
        ? defaultLogger(this.dataDirectory, this.env, options.logLevel, options.logFile)
        : { logger: options.logger, latestFile: undefined as string | undefined }
    this.root = chosen.logger
    this.latestFile = chosen.latestFile
    this.logger = this.root.child({ module: 'app' })
    this.injectedAgent = options.agent
    this.pluginManager = new PluginManager({
      dataDirectory: this.dataDirectory,
      logger: this.root.child({ module: 'plugin-manager' }),
    })
    this.catalogUrl = options.catalogUrl
    this.version = VERSION
    this.defaultProvider = options.defaultProvider ?? DEFAULT_PROVIDER
    this.defaultModel = options.defaultModel ?? 'gpt-6-astra'
    this.defaultSession = options.defaultSession
    this.envFile = options.envFile ?? join(process.cwd(), '.env')
    this.configFile = options.configFile ?? join(this.dataDirectory, 'config.json')
    this.tools = {}
    this.systemPromptParts = [SYSTEM_PROMPT]
    this.commands = new CommandRegistry()
    this.commands.register(quitCommand)
    this.commands.register(helpCommand)
    this.commands.register(modelCommand)
  }

  /**
   * Loads the configuration and builds the agent. Returns `1` when the
   * settings are rejected or the provider is unknown, `0` otherwise.
   *
   * A new session is opened for the project directory on every run, unless
   * `MINIAGENT_SESSION` (or `defaultSession`) names one to resume. Open
   * sessions are saved on shutdown; empty ones are pruned.
   */
  async run(): Promise<number> {
    // initializing
    this.readEnvFile()
    const config = await this.readConfig()

    this.sessions = await this.loadSessions(config)
    const agents = new AgentsManager()
    this.agents = agents
    const resumeId = this.env.MINIAGENT_SESSION ?? this.defaultSession
    const context =
      resumeId === undefined
        ? await this.sessions.createSession()
        : await this.sessions.resume(resumeId)

    this.context = context
    this.sessionId = context.id
    this.providerId = context.providerId
    this.modelId = context.modelId ?? this.defaultModel

    // Signal handling belongs to the entry point (see runCli): this class
    // never exits the process, so it stays safe to embed.
    try {
      return await this.boot(config, this.sessions, agents, context)
    } finally {
      await this.sessions.shutdown()
      agents.releaseAll()
      this.logger.flush()
      renameFinishedLog(this.latestFile)
    }
  }

  /**
   * Saves open sessions: non-empty ones are persisted, empty ones are
   * pruned. Called automatically when `run()` finishes; frontends call it
   * when the application closes.
   */
  async shutdown(): Promise<void> {
    await this.sessions?.shutdown()
    this.agents?.releaseAll()
  }

  /**
   * Builds an agent for one session, using that session's own provider and
   * model on top of the shared tools and system prompt. Agents are cheap
   * and stateless, so make one per concurrent session instead of sharing.
   * Throws when called before `run()` has built the providers.
   */
  agentFor(context: Context): Agent {
    if (this.providers === undefined) {
      throw new Error('App has not run yet: providers are unavailable.')
    }
    const providerId = context.providerId
    const modelId = context.modelId ?? this.defaultModel
    this.logger.info(`${providerId}/${modelId} for session ${context.id}`)
    return this.buildAgent(this.providers, providerId, modelId, context)
  }

  /**
   * Switches one session to another provider/model: validates by building
   * the agent first, then updates the session, refreshes its context
   * window, caches the new agent, and persists the session. Throws for
   * unknown providers or when called before `run()`. In-flight runs on the
   * old agent keep their events but lose their subscriber; they still
   * append to the shared context.
   */
  async switchModelFor(
    session: Context,
    providerId: string,
    modelId: string,
  ): Promise<{
    agent: Agent
    providerId: string
    modelId: string
    contextWindow: number | undefined
  }> {
    if (this.providers === undefined) {
      throw new Error('App has not run yet: providers are unavailable.')
    }
    const agent = this.buildAgent(this.providers, providerId, modelId, session)
    session.providerId = providerId
    session.modelId = modelId
    session.contextWindow = undefined
    await session.initRemote()
    this.agents?.set(session, agent)
    if (session.id === this.sessionId) {
      this.providerId = providerId
      this.modelId = modelId
      this.agent = agent
    }
    if (session.store !== undefined) {
      await session.save()
    }
    return { agent, providerId, modelId, contextWindow: session.contextWindow }
  }

  /**
   * Builds providers, plugins, and the agent, then drives plugin `run`
   * methods. Extracted from `run()` so shutdown logic stays in one place.
   */
  private async boot(
    config: AppConfig,
    manager: SessionManager,
    agents: AgentsManager,
    context: Context,
  ): Promise<number> {
    const providerId = context.providerId
    const modelId = context.modelId ?? this.defaultModel
    const settings = { ...config.providers }
    const plugins = this.pluginManager
    try {
      await plugins.load(config.plugins ?? [])
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error))
      return 1
    }

    try {
      const providers = loadProviders()
      this.providers = providers
      await plugins.execute((plugin) =>
        plugin.onProvidersCreating?.(providers, config.pluginConfig?.[plugin.name]),
      )
      providers.loadConfig(settings)

      const host: PluginHost = {
        tools: this.tools,
        providers,
        systemPromptParts: this.systemPromptParts,
        dataDirectory: this.dataDirectory,
        cwd: this.cwd,
        providerId,
        modelId,
        context,
        sessions: manager,
        commands: this.commands,
        logger: this.root.child({ module: 'plugin' }),
      }
      await plugins.execute((plugin) => plugin.setup?.(host, config.pluginConfig?.[plugin.name]))
      for (const [name, entry] of Object.entries(config.tools ?? {})) {
        if (entry.enabled === false) {
          delete this.tools[name]
        }
      }
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error))
      return 1
    }

    if (this.injectedAgent === undefined) {
      try {
        this.agent = this.agentFor(context)
      } catch (error) {
        if (NoSuchProviderError.isInstance(error)) {
          this.logger.error(
            `Unknown provider "${providerId}". Known providers: ${error.availableProviders.join(', ')}.`,
          )
        } else {
          this.logger.error(error instanceof Error ? error.message : String(error))
        }
        return 1
      }
    } else {
      this.agent = this.injectedAgent
    }
    agents.set(context, this.agent)

    // All `run` methods start concurrently and share one session manager.
    // The built agent serves the boot session; `agentFor` builds more for
    // other sessions. A frontend (TUI, WebUI) drives the agents here. No
    // `run` methods means headless: return as before.
    try {
      const runHost: RunHost = {
        agent: this.agent as Agent,
        agentFor: (session: Context): Agent => this.agentFor(session),
        agents,
        context,
        sessionId: this.sessionId,
        providerId,
        modelId,
        switchModel: (session, sessionProviderId, sessionModelId) =>
          this.switchModelFor(session, sessionProviderId, sessionModelId),
        tools: this.tools,
        dataDirectory: this.dataDirectory,
        cwd: this.cwd,
        sessions: manager,
        commands: this.commands,
        logger: this.root.child({ module: 'plugin' }),
      }
      await plugins.executeAll((plugin) =>
        plugin.run?.(runHost, config.pluginConfig?.[plugin.name]),
      )
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error))
      return 1
    }

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
        this.logger.info(`could not read ${this.envFile}: ${String(error)}`)
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
      this.logger.warn(`could not read ${this.configFile}: ${String(error)}`)
      return {}
    }
  }

  /**
   * Creates the session manager for the project directory. The stored
   * provider and model win on resume; the config file and environment only
   * apply to fresh sessions.
   */
  private loadSessions(config: AppConfig): Promise<SessionManager> {
    const store = new FileContextStore(join(this.dataDirectory, 'contexts'))
    return SessionManager.create({
      store,
      dataDirectory: this.dataDirectory,
      cwd: this.cwd,
      providerId: config.provider ?? this.defaultProvider,
      modelId: config.model ?? this.env.OPENAI_MODEL ?? this.defaultModel,
      env: this.env,
      catalogUrl: this.catalogUrl,
      logger: this.root.child({ module: 'sessions' }),
    })
  }

  private buildAgent(
    providers: Providers,
    providerId: string,
    modelId: string,
    context: Context,
  ): Agent {
    return new Agent({
      model: providers.createModel(providerId, modelId),
      system: this.systemPromptParts.join('\n\n'),
      tools: { ...this.tools },
      context,
      maxSteps: 8,
      logger: this.root.child({ module: 'agent' }),
    })
  }
}
