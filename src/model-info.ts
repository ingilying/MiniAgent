import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { z } from 'zod'

/**
 * Model limits from the models.dev catalog.
 *
 * The AI SDK ships no model context-window sizes. `models.dev` is the
 * community catalog that coding agents read this metadata from; it is keyed
 * by provider id, then by model id, and each model carries
 * `limit: { context, input, output }`.
 */
export interface ModelLimits {
  /** Provider-qualified model id, e.g. `openai/gpt-6-astra`. */
  readonly id: string
  /** Context window in tokens, when the catalog reports one. */
  readonly contextWindow: number | undefined
  /** Maximum output tokens, when the catalog reports them. */
  readonly maxOutputTokens: number | undefined
}

export const DEFAULT_MODEL_CATALOG_URL = 'https://models.dev/api.json'

const CACHE_TTL_MS = 60 * 60 * 1000

const catalogModelSchema = z.object({
  limit: z
    .object({
      context: z.unknown().optional(),
      input: z.unknown().optional(),
      output: z.unknown().optional(),
    })
    .optional()
    .catch(undefined),
})

const catalogSchema = z
  .record(
    z.string(),
    z
      .object({
        models: z.record(z.string(), catalogModelSchema).optional().catch(undefined),
      })
      .catch({}),
  )
  .catch({})

type CatalogModel = z.infer<typeof catalogModelSchema>

type Catalog = z.infer<typeof catalogSchema>

export interface FetchModelLimitsOptions {
  /** Catalog URL. Defaults to models.dev. */
  catalogUrl?: string
  /** Provider id used to find a bare model id. Defaults to `openai`. */
  provider?: string
  /**
   * When set, the catalog is cached in this file between runs, so a CLI does
   * not download the whole catalog on every start.
   */
  cacheFile?: string
  /** Fetch implementation, mainly for testing. */
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
}

interface CacheEntry {
  url: string
  at: number
  catalog: Catalog
}

const cacheEntrySchema = z.object({
  url: z.string(),
  at: z.number().finite(),
  catalog: z.unknown(),
})

let memoryCache: CacheEntry | undefined

/**
 * Lists every `provider/id` in the on-disk catalog cache, without touching
 * the network. Used for model-name completion: breadth matters more than
 * freshness, so a stale cache still counts. Missing or unreadable files
 * yield an empty list, never an error.
 */
export async function listCachedModels(cacheFile: string): Promise<string[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(cacheFile, 'utf8'))
  } catch {
    return []
  }
  const result = cacheEntrySchema.safeParse(parsed)
  if (!result.success) {
    return []
  }
  const catalog = toCatalog(result.data.catalog)
  const ids: string[] = []
  for (const [providerId, provider] of Object.entries(catalog)) {
    for (const modelId of Object.keys(provider.models ?? {})) {
      ids.push(`${providerId}/${modelId}`)
    }
  }
  return ids.sort()
}

/**
 * Looks up a model's limits in the catalog.
 *
 * Returns `undefined` when the catalog does not list the model. Throws when
 * the catalog cannot be read, so callers can decide on a fallback.
 */
export async function fetchModelLimits(
  modelId: string,
  options: FetchModelLimitsOptions = {},
): Promise<ModelLimits | undefined> {
  const url = options.catalogUrl ?? DEFAULT_MODEL_CATALOG_URL
  const catalog = await loadCatalog(url, options)
  const found = findModel(catalog, options.provider ?? 'openai', modelId)

  if (found === undefined) {
    return undefined
  }

  return {
    id: `${found.providerId}/${found.id}`,
    contextWindow: positiveNumber(found.model.limit?.context),
    maxOutputTokens: positiveNumber(found.model.limit?.output),
  }
}

async function loadCatalog(url: string, options: FetchModelLimitsOptions): Promise<Catalog> {
  const now = Date.now()

  if (memoryCache !== undefined && memoryCache.url === url && now - memoryCache.at < CACHE_TTL_MS) {
    return memoryCache.catalog
  }

  const cached = await readCache(options.cacheFile, url, now)
  if (cached !== undefined) {
    memoryCache = cached
    return cached.catalog
  }

  const fetchImpl = options.fetch ?? fetch
  const response = await fetchImpl(url, { signal: options.signal })
  if (!response.ok) {
    throw new Error(`Model catalog request failed: ${response.status} ${response.statusText}`)
  }

  const catalog = toCatalog(await response.json())
  const entry = { url, at: now, catalog }
  memoryCache = entry
  await writeCache(options.cacheFile, entry)
  return catalog
}

function toCatalog(body: unknown): Catalog {
  return catalogSchema.parse(body)
}

function findModel(
  catalog: Catalog,
  provider: string,
  modelId: string,
): { providerId: string; id: string; model: CatalogModel } | undefined {
  const direct = catalog[provider]?.models?.[modelId]
  if (direct !== undefined) {
    return { providerId: provider, id: modelId, model: direct }
  }

  // Also accept provider-qualified ids such as "openai/gpt-6-astra".
  const separator = modelId.indexOf('/')
  if (separator > 0) {
    const providerId = modelId.slice(0, separator)
    const id = modelId.slice(separator + 1)
    const model = catalog[providerId]?.models?.[id]
    if (model !== undefined) {
      return { providerId, id, model }
    }
  }

  return undefined
}

async function readCache(
  cacheFile: string | undefined,
  url: string,
  now: number,
): Promise<CacheEntry | undefined> {
  if (cacheFile === undefined) {
    return undefined
  }

  try {
    const parsed: unknown = JSON.parse(await readFile(cacheFile, 'utf8'))
    const result = cacheEntrySchema.safeParse(parsed)
    if (!result.success || result.data.url !== url || now - result.data.at >= CACHE_TTL_MS) {
      return undefined
    }
    return { url, at: result.data.at, catalog: toCatalog(result.data.catalog) }
  } catch {
    // A missing or unreadable cache is not an error.
    return undefined
  }
}

async function writeCache(cacheFile: string | undefined, entry: CacheEntry): Promise<void> {
  if (cacheFile === undefined) {
    return
  }

  try {
    await mkdir(dirname(cacheFile), { recursive: true })
    await writeFile(cacheFile, JSON.stringify(entry), 'utf8')
  } catch {
    // Caching is best effort.
  }
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}
