import { readFile } from 'node:fs/promises'

import { z } from 'zod'

/**
 * Application configuration read from `<dataDirectory>/config.json`.
 *
 * ```json
 * {
 *   "provider": "openai",
 *   "model": "gpt-6-astra",
 *   "providers": {
 *     "ollama": { "baseURL": "http://localhost:11434/v1" },
 *     "openai": { "baseURL": "https://proxy.example.com/v1", "apiKey": "sk-..." },
 *     "deepseek": { "apiKey": "sk-..." }
 *   },
 *   "plugins": ["./plugins/my-tools.js"],
 *   "tools": { "read": { "enabled": false } },
 *   "pluginConfig": { "my-tools": { "verbose": true } }
 * }
 * ```
 *
 * Every field is optional: a missing or partial file leaves the defaults in
 * place. Values here win over the environment; a stored session still wins
 * over both.
 */
export interface AppConfig {
  /** Default provider id, e.g. `openai`. */
  readonly provider?: string
  /** Default model id for a fresh session. */
  readonly model?: string
  /** Per-provider settings keyed by provider id. */
  readonly providers?: Readonly<Record<string, ProviderConfig>>
  /** Plugin specifiers loaded in order: paths relative to the data directory or package names. */
  readonly plugins?: readonly string[]
  /** Per-tool settings keyed by tool name. */
  readonly tools?: Readonly<Record<string, ToolConfig>>
  /** Per-plugin settings keyed by plugin name, passed to the plugin's hooks as-is. */
  readonly pluginConfig?: Readonly<Record<string, unknown>>
}

/** Settings for one tool: whether it stays enabled after plugins merge. */
export interface ToolConfig {
  /** Set to `false` to remove the tool from the agent. Defaults to enabled. */
  readonly enabled?: boolean
}

/** Settings for one provider: a custom endpoint and an inline API key. */
export interface ProviderConfig {
  /**
   * Custom endpoint, e.g. `http://localhost:11434/v1`. With it, any id
   * becomes an OpenAI-compatible provider and the API key is optional.
   */
  readonly baseURL?: string
  /** API key for this provider. */
  readonly apiKey?: string
}

/**
 * Reads the config file. Returns an empty config when the file does not exist
 * and throws when it exists but cannot be parsed, so a broken file is reported
 * rather than silently ignored.
 */
export async function loadConfig(path: string): Promise<AppConfig> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`invalid JSON in ${path}`)
  }

  const result = appConfigSchema.safeParse(parsed)
  return result.success ? result.data : {}
}

const nonEmptyText = z.string().min(1)

const providerConfigSchema = z
  .object({
    baseURL: nonEmptyText.optional(),
    apiKey: nonEmptyText.optional(),
  })
  .refine((entry) => entry.baseURL !== undefined || entry.apiKey !== undefined)

const toolConfigSchema = z.object({
  enabled: z.boolean(),
})

/** One bad entry skips itself instead of failing the whole block. */
function lenientRecord<T>(entrySchema: z.ZodType<T>): z.ZodType<Record<string, T>> {
  return z
    .record(z.string(), z.unknown())
    .refine((record) => !Array.isArray(record))
    .transform((record) => {
      const kept: Record<string, T> = {}
      for (const [key, entry] of Object.entries(record)) {
        const parsed = entrySchema.safeParse(entry)
        if (parsed.success) {
          kept[key] = parsed.data
        }
      }
      return kept
    })
}

const appConfigSchema = z.object({
  provider: nonEmptyText.optional().catch(undefined),
  model: nonEmptyText.optional().catch(undefined),
  providers: lenientRecord(providerConfigSchema)
    .refine((providers) => Object.keys(providers).length > 0)
    .optional()
    .catch(undefined),
  plugins: z
    .array(z.unknown())
    .transform((entries) =>
      entries.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0),
    )
    .refine((plugins) => plugins.length > 0)
    .optional()
    .catch(undefined),
  tools: lenientRecord(toolConfigSchema)
    .refine((tools) => Object.keys(tools).length > 0)
    .optional()
    .catch(undefined),
  pluginConfig: z
    .record(z.string(), z.unknown())
    .refine((record) => !Array.isArray(record))
    .refine((config) => Object.keys(config).length > 0)
    .optional()
    .catch(undefined),
})
