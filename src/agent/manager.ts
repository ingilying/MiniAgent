import type { Agent } from './agent.js'
import type { Context } from '../session/context.js'

/**
 * Agents serving live sessions, keyed by session id. The manager stores
 * instances only: callers build them (usually with `App.agentFor`, which
 * applies the session's own model) and drive them with the full `Agent`
 * API. One entry per session keeps histories from crossing agents.
 */
export class AgentsManager {
  private readonly agents = new Map<string, Agent>()

  /** Registers the agent serving the session, replacing any cached one. */
  set(session: Context, agent: Agent): void {
    this.agents.set(session.id, agent)
  }

  /** Returns the registered agent, or `undefined` when none serves the id. */
  get(id: string): Agent | undefined {
    return this.agents.get(id)
  }

  /** Whether an agent is registered for the id. */
  has(id: string): boolean {
    return this.agents.has(id)
  }

  /** Ids with a registered agent. */
  ids(): readonly string[] {
    return [...this.agents.keys()]
  }

  /**
   * Drops the registration. Call after `sessions.close(id)`.
   * Returns whether one was registered.
   */
  release(id: string): boolean {
    return this.agents.delete(id)
  }

  /** Drops every registration. */
  releaseAll(): void {
    this.agents.clear()
  }
}
