import type { Logger } from 'pino'

import { basicToolsPlugin } from './builtin/basic-tools/index.js'
import { deepseekPlugin } from './builtin/deepseek.js'
import { tuiPlugin } from './builtin/tui/index.js'
import { loadPlugins } from './loader.js'
import type { Plugin } from './types.js'

/**
 * Loaded plugins and the two ways to drive them.
 *
 * All per-plugin phases run through `execute` (in load order) or
 * `executeAll` (concurrently), so the `Plugin "name" failed` wrap lives
 * in one place. Callers pass their phase as a function, e.g.
 * `execute((plugin) => plugin.setup?.(host, pluginConfig?.[plugin.name]))`.
 */
export class PluginManager {
  /** Loaded plugins in load order, built-ins first. */
  readonly plugins: Plugin[] = []

  private readonly dataDirectory: string
  private readonly logger: Logger

  constructor(options: { dataDirectory: string; logger: Logger }) {
    this.dataDirectory = options.dataDirectory
    this.logger = options.logger
  }

  /** Loads config plugins after the built-ins. Throws with the specifier. */
  async load(specifiers: readonly string[]): Promise<void> {
    const loaded = await loadPlugins(specifiers, this.dataDirectory)
    this.plugins.length = 0
    this.plugins.push(deepseekPlugin, basicToolsPlugin, tuiPlugin, ...loaded)
    this.logger.info(`loaded: ${this.plugins.map((plugin) => plugin.name).join(', ')}`)
  }

  /**
   * Runs `fn` for every plugin in load order, collecting defined returns.
   * A missing method returns `undefined` and is skipped.
   */
  async execute<T>(fn: (plugin: Plugin) => T | Promise<T>): Promise<NonNullable<Awaited<T>>[]> {
    const collected: NonNullable<Awaited<T>>[] = []
    for (const plugin of this.plugins) {
      const value = await this.runOne(plugin, fn)
      if (value !== undefined) {
        collected.push(value as NonNullable<Awaited<T>>)
      }
    }
    return collected
  }

  /**
   * Runs `fn` for every plugin concurrently, collecting defined returns.
   * Only the `run` phase uses this; setup order stays sequential.
   */
  async executeAll<T>(fn: (plugin: Plugin) => T | Promise<T>): Promise<NonNullable<Awaited<T>>[]> {
    const values = await Promise.all(this.plugins.map((plugin) => this.runOne(plugin, fn)))
    return values.filter((value) => value !== undefined) as NonNullable<Awaited<T>>[]
  }

  /** Runs one plugin, wrapping failures with its name. */
  private async runOne<T>(
    plugin: Plugin,
    fn: (plugin: Plugin) => T | Promise<T>,
  ): Promise<Awaited<T> | undefined> {
    try {
      return await fn(plugin)
    } catch (error) {
      throw new Error(
        `Plugin "${plugin.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }
}
