import { readFile } from 'node:fs/promises'

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

  return toConfig(parsed)
}

function toConfig(value: unknown): AppConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }

  const record = value as Record<string, unknown>
  return {
    provider: toText(record.provider),
    model: toText(record.model),
    providers: toProviders(record.providers),
    plugins: toPlugins(record.plugins),
    tools: toTools(record.tools),
    pluginConfig: toPluginConfig(record.pluginConfig),
  }
}

function toProviders(value: unknown): Record<string, ProviderConfig> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }

  const providers: Record<string, ProviderConfig> = Object.create(null)
  for (const [id, entry] of Object.entries(value)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue
    }
    const record = entry as Record<string, unknown>
    const baseURL = toText(record.baseURL)
    const apiKey = toText(record.apiKey)
    if (baseURL !== undefined || apiKey !== undefined) {
      providers[id] = { baseURL, apiKey }
    }
  }
  return Object.keys(providers).length === 0 ? undefined : providers
}

function toText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function toPlugins(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const plugins = value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  )
  return plugins.length === 0 ? undefined : plugins
}

function toTools(value: unknown): Record<string, ToolConfig> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }

  const tools: Record<string, ToolConfig> = Object.create(null)
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue
    }
    const record = entry as Record<string, unknown>
    if (typeof record.enabled !== 'boolean') {
      continue
    }
    tools[name] = { enabled: record.enabled }
  }
  return Object.keys(tools).length === 0 ? undefined : tools
}

function toPluginConfig(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) {
    return undefined
  }
  const pluginConfig: Record<string, unknown> = Object.create(null)
  for (const [name, entry] of entries) {
    pluginConfig[name] = entry
  }
  return pluginConfig
}
