import type { ToolSet } from 'ai'

import type { Agent } from '../agent/agent.js'
import type { AgentsManager } from '../agent/manager.js'
import type { CommandProvider, ModelSwitch } from '../commands/commands.js'
import type { Context } from '../session/context.js'
import type { Logger } from 'pino'
import type { Providers } from '../models/providers.js'
import type { SessionManager } from '../session/manager.js'

/** Outcome of switching a session's model: the new identity plus the rebuilt agent. */
export type SwitchResult = ModelSwitch & { readonly agent: Agent }

/**
 * Fields every host shares: the live tool set plus the read-only app
 * identity (directories, sessions, commands, diagnostics).
 */
export interface HostBase {
  /** Live tool set merged into the agent. Mutate in place. */
  tools: ToolSet
  /**
   * Merges a group of tools into `host.tools`: each key is assigned in
   * turn, so a later tool overwrites an earlier one under the same name,
   * exactly as assigning `host.tools[name]` directly would. `host.tools`
   * stays the live set, so plugins that mutate it directly keep working;
   * `addTools` is the recommended way to register tools.
   */
  addTools(tools: ToolSet): void
  /** Directory holding sessions, the config file, and the model cache. */
  readonly dataDirectory: string
  /** Project directory the session history is scoped to. */
  readonly cwd: string
  /** Sessions open in this process plus the history of the directory. */
  readonly sessions: SessionManager
  /** Core-owned slash commands. Consume only: registration lives in `App`. */
  readonly commands: CommandProvider
  /** Application diagnostics. Prefer it over `console`. */
  readonly logger: Logger
}

/**
 * Narrow view of the app passed to `Plugin.setup`.
 *
 * Only the live extension points are exposed: the merged tool set, the
 * provider registry, and the system prompt parts. Identity fields are
 * read-only. A plugin mutates `tools`, `providers`, and `systemPromptParts`
 * directly; anything else is out of reach.
 */
export interface PluginHost extends HostBase {
  /** Live provider registry. Call `add` to insert providers. */
  providers: Providers
  /** System prompt parts joined with blank lines. Push to append. */
  systemPromptParts: string[]
  /** Provider id the session runs on. */
  readonly providerId: string
  /** Model id the session runs on. */
  readonly modelId: string
  /** Conversation the agent works on. */
  readonly context: Context
}

/**
 * Narrow view of the app passed to `Plugin.run`, after the agent is built.
 *
 * Everything a frontend needs to drive: the built agent, the conversation,
 * and the session identity. Read-only except `tools`,
 * which `run` may still extend before driving.
 */
export interface RunHost extends HostBase {
  /** Built agent. Drive it with `run(input)` or `stream(input)`. */
  agent: Agent
  /**
   * Builds an agent for any session, using that session's own provider
   * and model. Make one per concurrent session instead of sharing.
   */
  agentFor: (context: Context) => Agent
  /**
   * Registered agents, one per served session. Look one up by session id
   * and drive it yourself with the full `Agent` API. The default path
   * for plugins.
   */
  agents: AgentsManager
  /** Conversation the agent works on. */
  readonly context: Context
  /** Session id, resolved by `run()`. */
  readonly sessionId: string | undefined
  /** Provider id the session runs on. */
  readonly providerId: string | undefined
  /** Ids of the loaded providers, sorted. A frontend offers models from these. */
  readonly providerIds: readonly string[]
  /**
   * Provider-qualified model ids the loaded providers declared, sorted.
   * Frontends merge them with the catalog's list: the catalog has no entry
   * for a custom provider.
   */
  readonly declaredModelIds: readonly string[]
  /** Model id the session runs on. */
  readonly modelId: string | undefined
  /**
   * Switches a session to another provider/model and returns the rebuilt
   * agent plus the resolved identity. See `App.switchModelFor` for the
   * full contract. Throws for unknown providers.
   */
  switchModel(session: Context, providerId: string, modelId: string): Promise<SwitchResult>
}

/**
 * A plugin. Every method is optional: implement only what the plugin needs.
 * A missing method is skipped.
 */
export interface Plugin {
  /** Unique name used for `pluginConfig` lookup and error messages. */
  name: string
  version?: string
  /**
   * Runs before the config file's provider settings are applied, so providers
   * inserted here still receive their `providers.<id>` settings.
   */
  onProvidersCreating?: (providers: Providers, config?: unknown) => void | Promise<void>
  /** Runs after the host is built. Mutate `host.tools`, `host.providers`, and `host.systemPromptParts` directly. */
  setup?: (host: PluginHost, config?: unknown) => void | Promise<void>
  /**
   * Runs after the agent is built. All `run` methods start concurrently and
   * share one agent and session manager; coordinate turns between themselves. A
   * frontend (TUI, WebUI) drives the agent here and returns `void`.
   */
  run?: (host: RunHost, config?: unknown) => void | Promise<void>
}

export type { Context }
