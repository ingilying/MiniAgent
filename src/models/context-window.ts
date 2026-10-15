import { join } from 'node:path'

import type { Logger } from 'pino'

import type { Context } from '../session/context.js'
import { fetchModelLimits } from './catalog.js'

export interface ContextWindowOptions {
  /**
   * Environment read for `MINIAGENT_CONTEXT_WINDOW`. Defaults to
   * `process.env`.
   */
  env?: NodeJS.ProcessEnv
  /** Catalog endpoint. Defaults to models.dev. */
  catalogUrl?: string
  /**
   * Directory holding the model cache. Without it the catalog is fetched
   * but not cached.
   */
  dataDirectory?: string
  /** Diagnostics for the lookup. */
  logger?: Logger
}

/**
 * Fills in `context.contextWindow` for its configured `modelId`: an
 * explicit `MINIAGENT_CONTEXT_WINDOW` wins, otherwise the limit is read
 * from the catalog. Resolves to nothing; the result lands in
 * `context.contextWindow`.
 *
 * Optional and never throws: without a window the context still works,
 * `remainingTokens` just stays `undefined`.
 */
export async function resolveContextWindow(
  context: Context,
  options: ContextWindowOptions = {},
): Promise<void> {
  if (context.contextWindow !== undefined || context.modelId === undefined) {
    return
  }

  const env = options.env ?? process.env
  const override = env.MINIAGENT_CONTEXT_WINDOW
  if (override !== undefined) {
    const value = Number(override)
    if (Number.isFinite(value) && value > 0) {
      context.contextWindow = value
      return
    }
    options.logger?.info(`ignoring invalid MINIAGENT_CONTEXT_WINDOW="${override}"`)
  }

  try {
    const limits = await fetchModelLimits(context.modelId, {
      provider: context.providerId,
      cacheFile:
        options.dataDirectory === undefined
          ? undefined
          : join(options.dataDirectory, 'models.json'),
      catalogUrl: options.catalogUrl,
    })
    if (limits?.contextWindow === undefined) {
      options.logger?.warn(`no context window in catalog for "${context.modelId}"`)
      return
    }
    context.contextWindow = limits.contextWindow
    options.logger?.info(
      `${limits.id}: ${limits.contextWindow.toLocaleString('en-US')} token context window`,
    )
  } catch (error) {
    options.logger?.error(`could not read model limits: ${String(error)}`)
  }
}
