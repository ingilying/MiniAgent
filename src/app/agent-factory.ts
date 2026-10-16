/**
 * Agent factory: builds agents from the app's resolved state.
 *
 * Each agent gets a snapshot of the current tools and a joined system
 * prompt, so agents are cheap and isolated. The factory also handles
 * switching a session's model: the new agent is built first (so an
 * unknown provider throws before anything changes), then the session
 * identity is updated and the context window is resolved.
 */

import type { ToolSet } from 'ai'
import type { Logger } from 'pino'

import { Agent } from '../agent/agent.js'
import { APP_MAX_STEPS } from '../defaults.js'
import { resolveContextWindow } from '../models/context-window.js'
import type { Providers } from '../models/providers.js'
import type { SwitchResult } from '../plugins/types.js'
import type { Context } from '../session/context.js'

export interface AgentFactoryOptions {
  /** Resolved provider registry. */
  readonly providers: Providers
  /** Shared tool set; each built agent gets a snapshot. */
  readonly tools: ToolSet
  /** System prompt parts joined with double newlines. */
  readonly systemPromptParts: string[]
  /** Fallback model when the session stores none. */
  readonly defaultModel: string
  /** Environment for the context-window resolver. */
  readonly env: NodeJS.ProcessEnv
  /** Catalog endpoint for the context-window resolver. */
  readonly catalogUrl: string | undefined
  /** Data directory for the context-window cache. */
  readonly dataDirectory: string
  /** Logger for app-level messages (e.g. "provider/model for session"). */
  readonly appLogger: Logger
  /** Logger bound to built agents. */
  readonly agentLogger: Logger
}

/** The session's model, or the default when the session stores none. */
export function modelOf(session: Context, defaultModel: string): string {
  return session.modelId ?? defaultModel
}

/** Builds agents from the app's resolved providers, tools, and system prompt. */
export class AgentFactory {
  private readonly opts: AgentFactoryOptions

  constructor(options: AgentFactoryOptions) {
    this.opts = options
  }

  /**
   * Builds an agent for one session on that session's own provider and
   * model. Agents are cheap: make one per concurrent session.
   */
  agentFor(session: Context): Agent {
    const providerId = session.providerId
    const modelId = modelOf(session, this.opts.defaultModel)
    this.opts.appLogger.info(`${providerId}/${modelId} for session ${session.id}`)
    return this.buildAgent(session, providerId, modelId)
  }

  /**
   * Switches a session to another provider/model. Builds the new agent
   * first so an unknown provider throws before anything changes. The
   * caller is responsible for updating the agents registry.
   */
  async switchModel(session: Context, providerId: string, modelId: string): Promise<SwitchResult> {
    const agent = this.buildAgent(session, providerId, modelId)

    session.providerId = providerId
    session.modelId = modelId
    session.contextWindow = undefined
    await resolveContextWindow(session, {
      env: this.opts.env,
      catalogUrl: this.opts.catalogUrl,
      dataDirectory: this.opts.dataDirectory,
      logger: this.opts.appLogger,
    })

    if (session.store !== undefined) {
      await session.save()
    }
    return { agent, providerId, modelId, contextWindow: session.contextWindow }
  }

  private buildAgent(session: Context, providerId: string, modelId: string): Agent {
    return new Agent({
      model: this.opts.providers.createModel(providerId, modelId),
      system: this.opts.systemPromptParts.join('\n\n'),
      tools: { ...this.opts.tools },
      context: session,
      maxSteps: APP_MAX_STEPS,
      mode: 'stream',
      logger: this.opts.agentLogger,
    })
  }
}
