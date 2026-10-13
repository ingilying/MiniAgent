import type { ToolSet } from 'ai'

import type { Agent } from '../agent.js'
import type { AgentsManager } from '../agents.js'
import type { Context } from '../context.js'
import type { Logger } from 'pino'
import type { Providers } from '../providers.js'
import type { SessionManager } from '../sessions.js'

/**
 * Narrow view of the app passed to `Plugin.setup`.
 *
 * Only the live extension points are exposed: the merged tool set, the
 * provider registry, and the system prompt parts. Identity fields are
 * read-only. A plugin mutates `tools`, `providers`, and `systemPromptParts`
 * directly; anything else is out of reach.
 */
export interface PluginHost {
  /** Live tool set merged into the agent. Mutate in place. */
  tools: ToolSet
  /** Live provider registry. Call `add` to insert providers. */
  providers: Providers
  /** System prompt parts joined with blank lines. Push to append. */
  systemPromptParts: string[]
  /** Directory holding sessions, the config file, and the model cache. */
  readonly dataDirectory: string
  /** Provider id the session runs on. */
  readonly providerId: string
  /** Model id the session runs on. */
  readonly modelId: string
  /** Conversation the agent works on. */
  readonly context: Context
  /** Sessions open in this process plus the history of the directory. */
  readonly sessions: SessionManager
  /** Application diagnostics. Prefer it over `console`. */
  readonly logger: Logger
}

/**
 * Narrow view of the app passed to `Plugin.run`, after the agent is built.
 *
 * Everything a frontend needs to drive: the built agent, the conversation,
 * the initial prompt, and the session identity. Read-only except `tools`,
 * which `run` may still extend before driving.
 */
export interface RunHost {
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
  /** First positional argument, if any. */
  readonly prompt: string | undefined
  /** Session id, resolved by `run()`. */
  readonly sessionId: string | undefined
  /** Provider id the session runs on. */
  readonly providerId: string | undefined
  /** Model id the session runs on. */
  readonly modelId: string | undefined
  /** Live tool set merged from built-ins and plugins. */
  tools: ToolSet
  /** Directory holding sessions, the config file, and the model cache. */
  readonly dataDirectory: string
  /** Sessions open in this process plus the history of the directory. */
  readonly sessions: SessionManager
  /** Application diagnostics. Prefer it over `console`. */
  readonly logger: Logger
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
