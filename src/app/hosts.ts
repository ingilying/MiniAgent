/**
 * Plugin host builders.
 *
 * Assembles the `PluginHost` and `RunHost` objects that plugins receive
 * during their `setup` and `run` phases. The shared base (`addTools`,
 * directories, sessions, commands, logger) is built once per phase so
 * the `run` phase always sees the tools the `setup` phase registered.
 */

import type { ToolSet } from 'ai'
import type { Logger } from 'pino'

import type { Agent } from '../agent/agent.js'
import type { AgentsManager } from '../agent/manager.js'
import type { CommandProvider } from '../commands/commands.js'
import type { Providers } from '../models/providers.js'
import type { PluginHost, RunHost, SwitchResult } from '../plugins/types.js'
import type { Context } from '../session/context.js'
import type { SessionManager } from '../session/manager.js'

/** The identity fields every plugin host phase shares. */
export interface SharedHostFields {
  readonly tools: ToolSet
  readonly dataDirectory: string
  readonly cwd: string
  readonly sessions: SessionManager
  readonly commands: CommandProvider
  readonly logger: Logger
}

/**
 * Builds the base host that both `PluginHost` and `RunHost` extend.
 * `addTools` closes over the shared `tools` set so mutations are
 * visible to agents built after setup.
 */
function buildBase(fields: SharedHostFields) {
  return {
    tools: fields.tools,
    addTools: (tools: ToolSet): void => {
      Object.assign(fields.tools, tools)
    },
    dataDirectory: fields.dataDirectory,
    cwd: fields.cwd,
    sessions: fields.sessions,
    commands: fields.commands,
    logger: fields.logger,
  }
}

/** Assembles the host passed to `Plugin.setup`. */
export function buildPluginHost(
  shared: SharedHostFields,
  phase: {
    providers: Providers
    systemPromptParts: string[]
    context: Context
    modelId: string
  },
): PluginHost {
  return {
    ...buildBase(shared),
    providers: phase.providers,
    systemPromptParts: phase.systemPromptParts,
    providerId: phase.context.providerId,
    modelId: phase.modelId,
    context: phase.context,
  }
}

/** Assembles the host passed to `Plugin.run`. */
export function buildRunHost(
  shared: SharedHostFields,
  phase: {
    agent: Agent
    agents: AgentsManager
    context: Context
    modelId: string
    providerIds: readonly string[]
    declaredModelIds: readonly string[]
    titleSession: (id: string, firstMessage: string) => Promise<void>
    agentFor: (session: Context) => Agent
    switchModel: (session: Context, providerId: string, modelId: string) => Promise<SwitchResult>
  },
): RunHost {
  return {
    ...buildBase(shared),
    agent: phase.agent,
    agentFor: phase.agentFor,
    agents: phase.agents,
    context: phase.context,
    sessionId: phase.context.id,
    providerId: phase.context.providerId,
    providerIds: phase.providerIds,
    declaredModelIds: phase.declaredModelIds,
    titleSession: phase.titleSession,
    modelId: phase.modelId,
    switchModel: phase.switchModel,
  }
}
