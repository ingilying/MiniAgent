import { join } from 'node:path'

import { NoSuchProviderError } from 'ai'
import type { ToolSet } from 'ai'
import type { Logger } from 'pino'

import type { Agent } from '../agent/agent.js'
import { AgentsManager } from '../agent/manager.js'
import { VERSION } from '../build-info.js'
import { CommandRegistry, helpCommand, modelCommand, quitCommand } from '../commands/commands.js'
import { DEFAULT_MODEL, DEFAULT_PROVIDER, SYSTEM_PROMPT } from '../defaults.js'
import { defaultLogger, renameFinishedLog } from '../logging/logger.js'
import { loadProviders } from '../models/providers.js'
import type { Providers } from '../models/providers.js'
import { PluginManager } from '../plugins/manager.js'
import type { Plugin, SwitchResult } from '../plugins/types.js'
import type { Context } from '../session/context.js'
import { SessionManager } from '../session/manager.js'
import { FileContextStore } from '../session/store.js'
import { AgentFactory, modelOf } from './agent-factory.js'
import type { AppConfig } from './config.js'
import { buildPluginHost, buildRunHost } from './hosts.js'
import type { SharedHostFields } from './hosts.js'
import type { AppOptions } from './options.js'
import { defaultDataDirectory } from './paths.js'
import { mergeEnvFile, readConfigFile } from './startup.js'

export { defaultDataDirectory, isReleaseBuild } from './paths.js'
export type { AppOptions } from './options.js'

/**
 * Application bootstrap: resolves configuration and builds the agent.
 *
 * It does not talk to the user. `run()` goes through these steps:
 *
 * 1. merge the `.env` file and read the config file;
 * 2. open a session for the project directory (a new one, or the one named
 *    by `MINIAGENT_SESSION`) and resolve its context window;
 * 3. load plugins, create the providers, and let plugins `setup`;
 * 4. build the agent for the session, or take the injected one;
 * 5. start every plugin's `run`, which is where a frontend drives the agent.
 *
 * Open sessions are saved on shutdown and empty ones are pruned, so a fresh
 * instance never leaves a file behind. Everything the app needs from the
 * outside world is injected, so tests can drive it without a TTY, a network,
 * or a real model.
 */
export class App {
  /** Diagnostics logger for the app module. */
  readonly logger: Logger
  /** Directory holding sessions, the config file, and the model cache. */
  readonly dataDirectory: string
  /** Project directory the session history is scoped to. */
  readonly cwd: string
  /** Version stamped into this build. */
  readonly version = VERSION
  /** Core-owned slash commands, exposed to plugins as read-only. */
  readonly commands = new CommandRegistry()
  /** Live tool set merged from plugins. Each agent gets a copy. */
  readonly tools: ToolSet = {}
  /** System prompt parts: base prompt first, plugin parts after in load order. */
  readonly systemPromptParts: string[] = [SYSTEM_PROMPT]

  /** Sessions open in this process plus the history of the directory. Set by `run()`. */
  sessions: SessionManager | undefined
  /** Agents serving live sessions, one per session. Set by `run()`. */
  agents: AgentsManager | undefined
  /** Provider registry. Set by `run()` once plugins had their say. */
  providers: Providers | undefined
  /** The session `run()` opened for this instance: the default agent works here. */
  context: Context | undefined
  /** Agent serving the boot session: the injected one, or the one `run()` built. */
  agent: Agent | undefined

  /** Builds agents from the providers, tools, and prompt. Set by `run()`. */
  private factory: AgentFactory | undefined

  private readonly options: AppOptions
  private readonly env: NodeJS.ProcessEnv
  private readonly envFile: string | false
  private readonly configFile: string | false
  private readonly defaultProvider: string
  private readonly defaultModel: string

  /** Unbound logger every module child derives from. */
  private readonly rootLogger: Logger
  /** Log file renamed to the finish time at the end of the run, when the app owns one. */
  private readonly latestLogFile: string | undefined
  private readonly pluginManager: PluginManager

  constructor(options: AppOptions = {}) {
    this.options = options
    this.env = options.env ?? process.env
    this.dataDirectory = options.dataDirectory ?? defaultDataDirectory()
    this.cwd = options.cwd ?? process.cwd()
    this.envFile = options.envFile ?? join(process.cwd(), '.env')
    this.configFile = options.configFile ?? join(this.dataDirectory, 'config.json')
    this.defaultProvider = options.defaultProvider ?? DEFAULT_PROVIDER
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL

    if (options.logger === undefined) {
      const { logger, latestFile } = defaultLogger(
        this.dataDirectory,
        this.env,
        options.logLevel,
        options.logFile,
      )
      this.rootLogger = logger
      this.latestLogFile = latestFile
    } else {
      this.rootLogger = options.logger
    }
    this.logger = this.moduleLogger('app')

    this.pluginManager = new PluginManager({
      dataDirectory: this.dataDirectory,
      logger: this.moduleLogger('plugin-manager'),
    })
    this.commands.registerAll([quitCommand, helpCommand, modelCommand])
  }

  /** Loaded plugins in load order, built-ins first. */
  get plugins(): Plugin[] {
    return this.pluginManager.plugins
  }

  /** Id of the boot session. */
  get sessionId(): string | undefined {
    return this.context?.id
  }

  /** Provider the boot session runs on. */
  get providerId(): string | undefined {
    return this.context?.providerId
  }

  /** Model the boot session runs on. */
  get modelId(): string | undefined {
    return this.context === undefined ? undefined : modelOf(this.context, this.defaultModel)
  }

  /**
   * Runs the boot steps. Returns `1` when plugins, providers, or a frontend
   * fail (the cause is logged), `0` otherwise. A new session is opened on
   * every run, unless `MINIAGENT_SESSION` (or `defaultSession`) names one to
   * resume. Open sessions are saved when the run ends.
   *
   * Signal handling belongs to the entry point (see `runCli`): this class
   * never exits the process, so it stays safe to embed.
   */
  async run(): Promise<number> {
    mergeEnvFile(this.envFile, this.logger)
    const config = await readConfigFile(this.configFile, this.logger)

    const sessions = await this.openSessions(config)
    this.sessions = sessions
    this.agents = new AgentsManager()
    this.context = await this.openBootSession(sessions)

    try {
      await this.boot(config, sessions, this.agents, this.context)
      return 0
    } catch (error) {
      this.logger.error(describeError(error))
      return 1
    } finally {
      await this.shutdown()
      this.logger.flush()
      renameFinishedLog(this.latestLogFile)
    }
  }

  /**
   * Saves open sessions (non-empty ones are persisted, empty ones are
   * pruned) and drops the agents. `run()` calls it when it finishes;
   * frontends and signal handlers may call it earlier.
   */
  async shutdown(): Promise<void> {
    await this.sessions?.shutdown()
    this.agents?.releaseAll()
  }

  /**
   * Builds an agent for one session, on that session's own provider and
   * model, with the shared tools and system prompt. Agents are cheap, so
   * make one per concurrent session instead of sharing. Throws before
   * `run()` has created the providers.
   */
  agentFor(session: Context): Agent {
    return this.requireFactory().agentFor(session)
  }

  /**
   * Switches a session to another provider and model. The factory builds the
   * new agent first, so an unknown provider throws before anything changes.
   * Then the agent replaces the cached one. Runs still going on the old agent
   * keep appending to the shared context.
   */
  async switchModelFor(
    session: Context,
    providerId: string,
    modelId: string,
  ): Promise<SwitchResult> {
    const result = await this.requireFactory().switchModel(session, providerId, modelId)
    this.agents?.set(session, result.agent)
    if (session.id === this.context?.id) {
      this.agent = result.agent
    }
    return result
  }

  /** The boot steps after the session is open. Throws on any failure. */
  private async boot(
    config: AppConfig,
    sessions: SessionManager,
    agents: AgentsManager,
    context: Context,
  ): Promise<void> {
    const shared = this.sharedHostFields(sessions)

    await this.pluginManager.load(config.plugins ?? [])
    const providers = await this.setupProviders(config, shared, context)
    this.providers = providers
    this.factory = new AgentFactory({
      providers,
      tools: this.tools,
      systemPromptParts: this.systemPromptParts,
      defaultModel: this.defaultModel,
      env: this.env,
      catalogUrl: this.options.catalogUrl,
      dataDirectory: this.dataDirectory,
      appLogger: this.logger,
      agentLogger: this.moduleLogger('agent'),
    })

    this.agent = this.options.agent ?? this.agentFor(context)
    agents.set(context, this.agent)

    await this.runPlugins(config, shared, agents, context, this.agent)
  }

  /**
   * Creates the providers and lets plugins add to them. Plugins see the
   * registry before the config file's provider settings apply, so providers
   * they insert still receive their settings. The tools the config file
   * disables are removed last, after every plugin had its say.
   */
  private async setupProviders(
    config: AppConfig,
    shared: SharedHostFields,
    context: Context,
  ): Promise<Providers> {
    const providers = loadProviders()
    await this.pluginManager.execute((plugin) =>
      plugin.onProvidersCreating?.(providers, pluginConfigOf(config, plugin)),
    )
    providers.loadConfig({ ...config.providers })

    const host = buildPluginHost(shared, {
      providers,
      systemPromptParts: this.systemPromptParts,
      context,
      modelId: modelOf(context, this.defaultModel),
    })
    await this.pluginManager.execute((plugin) =>
      plugin.setup?.(host, pluginConfigOf(config, plugin)),
    )

    for (const [name, tool] of Object.entries(config.tools ?? {})) {
      if (tool.enabled === false) {
        delete this.tools[name]
      }
    }
    return providers
  }

  /**
   * Starts every plugin's `run` at once. A frontend (TUI, web) drives the
   * agents from here. With no `run` methods the app is headless and returns.
   */
  private async runPlugins(
    config: AppConfig,
    shared: SharedHostFields,
    agents: AgentsManager,
    context: Context,
    agent: Agent,
  ): Promise<void> {
    const host = buildRunHost(shared, {
      agent,
      agents,
      context,
      modelId: modelOf(context, this.defaultModel),
      agentFor: (session) => this.agentFor(session),
      switchModel: (session, providerId, modelId) =>
        this.switchModelFor(session, providerId, modelId),
    })
    await this.pluginManager.executeAll((plugin) =>
      plugin.run?.(host, pluginConfigOf(config, plugin)),
    )
  }

  /** The values every plugin host shares. */
  private sharedHostFields(sessions: SessionManager): SharedHostFields {
    return {
      tools: this.tools,
      dataDirectory: this.dataDirectory,
      cwd: this.cwd,
      sessions,
      commands: this.commands,
      logger: this.moduleLogger('plugin'),
    }
  }

  /**
   * Opens the session manager for the project directory. A stored session
   * keeps its own provider and model; the config file and environment only
   * apply to fresh ones.
   */
  private openSessions(config: AppConfig): Promise<SessionManager> {
    return SessionManager.create({
      store: new FileContextStore(join(this.dataDirectory, 'contexts')),
      dataDirectory: this.dataDirectory,
      cwd: this.cwd,
      providerId: config.provider ?? this.defaultProvider,
      modelId: config.model ?? this.env.OPENAI_MODEL ?? this.defaultModel,
      env: this.env,
      catalogUrl: this.options.catalogUrl,
      logger: this.moduleLogger('sessions'),
    })
  }

  /** Resumes the session named by `MINIAGENT_SESSION` / `defaultSession`, or creates a new one. */
  private openBootSession(sessions: SessionManager): Promise<Context> {
    const resumeId = this.env.MINIAGENT_SESSION ?? this.options.defaultSession
    return resumeId === undefined ? sessions.createSession() : sessions.resume(resumeId)
  }

  private requireFactory(): AgentFactory {
    if (this.factory === undefined) {
      throw new Error('App has not run yet: providers are unavailable.')
    }
    return this.factory
  }

  private moduleLogger(module: string): Logger {
    return this.rootLogger.child({ module })
  }
}

/** The settings the config file holds for one plugin. */
function pluginConfigOf(config: AppConfig, plugin: Plugin): unknown {
  return config.pluginConfig?.[plugin.name]
}

/** The message to log for a boot failure. */
function describeError(error: unknown): string {
  if (NoSuchProviderError.isInstance(error)) {
    return `Unknown provider "${error.providerId}". Known providers: ${error.availableProviders.join(', ')}.`
  }
  return error instanceof Error ? error.message : String(error)
}
