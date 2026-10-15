import type { ToolSet } from 'ai'
import type { Logger } from 'pino'

import type { Agent } from '../agent/agent.js'
import type { AgentsManager } from '../agent/manager.js'
import type { CommandProvider } from '../commands/commands.js'
import type { Context } from '../session/context.js'
import type { Providers } from '../models/providers.js'
import type { SessionManager } from '../session/manager.js'
import type { PluginHost, RunHost, SwitchResult } from '../plugins/types.js'

/** Fields every host shares. `App` owns the values; these builders copy them in. */
export interface SharedHostValues {
  tools: ToolSet
  addTools(tools: ToolSet): void
  dataDirectory: string
  cwd: string
  sessions: SessionManager
  commands: CommandProvider
  logger: Logger
}

/** Builds the `setup` host: shared values plus providers and prompt parts. */
export function buildPluginHost(
  shared: SharedHostValues,
  extra: {
    providers: Providers
    systemPromptParts: string[]
    providerId: string
    modelId: string
    context: Context
  },
): PluginHost {
  return { ...shared, ...extra }
}

/** Builds the `run` host: shared values plus the built agent and switching. */
export function buildRunHost(
  shared: SharedHostValues,
  extra: {
    agent: Agent
    agentFor: (session: Context) => Agent
    agents: AgentsManager
    context: Context
    sessionId: string | undefined
    providerId: string | undefined
    modelId: string | undefined
    switchModel: (session: Context, providerId: string, modelId: string) => Promise<SwitchResult>
  },
): RunHost {
  return { ...shared, ...extra }
}
