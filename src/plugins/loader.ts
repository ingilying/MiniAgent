import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { z } from 'zod'

import type { Plugin } from './types.js'

/**
 * Loads plugins in order from config `plugins` specifiers.
 *
 * A specifier can be:
 * - a project directory or file path: `./plugins/my-tools.js`,
 *   `./plugins/my-plugin` (a directory with a package entry), or an
 *   absolute path. Relative paths resolve against `baseDir` (the app data
 *   directory) first, then `process.cwd()`.
 * - a local package path: `file:../shared/my-plugin` (the `file:` prefix
 *   is stripped, then resolved as a path).
 * - an npm package name: `miniagent-plugin-foo`, imported by name so
 *   normal node module resolution applies.
 *
 * Each target must ask back with a `Plugin` instance: the module's
 * `default` export, `plugin` named export, or the module itself. A class
 * (or factory function) is instantiated/called to obtain the instance.
 * The instance must have a non-empty `name` and at least one method.
 */
export async function loadPlugins(
  specifiers: readonly string[],
  baseDir: string,
): Promise<Plugin[]> {
  const plugins: Plugin[] = []
  for (const specifier of specifiers) {
    plugins.push(await loadPlugin(specifier, baseDir))
  }
  return plugins
}

async function loadPlugin(specifier: string, baseDir: string): Promise<Plugin> {
  const candidates = resolveCandidates(specifier, baseDir)
  let module: unknown
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      module = await import(candidate)
      lastError = undefined
      break
    } catch (error) {
      lastError = error
    }
  }
  if (lastError !== undefined) {
    throw new Error(`Plugin "${specifier}" failed to load: ${messageOf(lastError)}`, {
      cause: lastError,
    })
  }
  const instance = await toPluginInstance(extractPlugin(module), specifier)
  const problem = invalidReason(instance)
  if (problem !== undefined) {
    throw new Error(`Plugin "${specifier}" failed to load: ${problem}`)
  }
  return instance
}

/** Import candidates in order: file URLs first, bare package name last. */
function resolveCandidates(specifier: string, baseDir: string): string[] {
  const stripped = specifier.startsWith('file:') ? specifier.slice('file:'.length) : specifier
  if (isAbsolute(stripped) || stripped.startsWith('.') || stripped.startsWith('/')) {
    // Node ESM cannot import a directory: read the project entry
    // (`package.json` exports/main, else `index.mjs`) before importing.
    const candidates: string[] = []
    for (const root of [join(baseDir, stripped), resolve(process.cwd(), stripped)]) {
      candidates.push(...entryUrls(root))
    }
    return candidates
  }
  return [stripped]
}

/**
 * File URLs a path-style specifier can mean: the file itself when it has an
 * extension, else the project entry resolved from `package.json`, else
 * `index.mjs` / `index.js`.
 */
function entryUrls(root: string): string[] {
  if (hasFileExtension(root)) {
    return [pathToFileURL(root).href]
  }
  const pkgEntry = readPackageEntry(root)
  if (pkgEntry !== undefined) {
    return [pathToFileURL(join(root, pkgEntry)).href]
  }
  return [pathToFileURL(join(root, 'index.mjs')).href, pathToFileURL(join(root, 'index.js')).href]
}

/** Reads the project entry from `package.json`: `exports` string, then `main`. */
function readPackageEntry(root: string): string | undefined {
  const file = join(root, 'package.json')
  if (!existsSync(file)) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const result = packageEntrySchema.safeParse(parsed)
    if (!result.success) {
      return undefined
    }
    return result.data.exports ?? result.data.main
  } catch {
    // A broken package.json surfaces as a load failure below.
  }
  return undefined
}

const packageEntrySchema = z.object({
  exports: z.string().optional().catch(undefined),
  main: z.string().optional().catch(undefined),
})

function hasFileExtension(path: string): boolean {
  return /\.[a-z0-9]+$/i.test(path)
}

function extractPlugin(module: unknown): unknown {
  if (typeof module !== 'object' || module === null) {
    return module
  }
  const record = module as Record<string, unknown>
  return record.default ?? record.plugin ?? module
}

/** Asks the module to give a `Plugin` instance: instantiates or calls it when needed. */
async function toPluginInstance(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exported: any,
  specifier: string,
): Promise<Plugin> {
  if (typeof exported === 'function') {
    try {
      const produced = isClass(exported)
        ? new (exported as new () => unknown)()
        : await (exported as () => unknown)()
      return produced as Plugin
    } catch (error) {
      throw new Error(
        `Plugin "${specifier}" failed to load: could not create instance: ${messageOf(error)}`,
        { cause: error },
      )
    }
  }
  return exported as Plugin
}

function isClass(value: new (...args: never[]) => unknown): boolean {
  return /^class[\s{]/.test(Function.prototype.toString.call(value))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function invalidReason(candidate: unknown): string | undefined {
  if (typeof candidate !== 'object' || candidate === null) {
    return 'must export an object with a non-empty string "name".'
  }
  const record = candidate as Record<string, unknown>
  if (typeof record.name !== 'string' || record.name.length === 0) {
    return 'must export an object with a non-empty string "name".'
  }
  if (!hasMethod(record)) {
    return `plugin "${record.name}" implements no methods.`
  }
  return undefined
}

/**
 * Whether the instance exposes any method, own or inherited. Class methods
 * live on the prototype, so `Object.values` alone would miss them.
 */
function hasMethod(record: object): boolean {
  for (
    let node: object | null = record;
    node !== null && node !== Object.prototype;
    node = Object.getPrototypeOf(node)
  ) {
    for (const key of Object.getOwnPropertyNames(node)) {
      if (key === 'constructor') {
        continue
      }
      if (typeof (record as Record<string, unknown>)[key] === 'function') {
        return true
      }
    }
  }
  return false
}
