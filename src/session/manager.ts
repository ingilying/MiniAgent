import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { z } from 'zod'

import { Context } from './context.js'
import { resolveContextWindow } from '../models/context-window.js'
import type { Logger } from 'pino'
import { CorruptSnapshotError, type ContextStore } from './store.js'

const sessionInfoSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

const sessionIndexFileSchema = z.object({
  cwd: z.string(),
  sessions: z.array(sessionInfoSchema),
})

/**
 * One entry in a project's session list. The history itself lives in the
 * `ContextStore` under the id; the index only tracks which ids belong to
 * the project directory.
 */
export type SessionInfo = z.infer<typeof sessionInfoSchema>

export interface SessionManagerOptions {
  /** Backend holding the conversation histories. */
  store: ContextStore
  /** Global data directory holding the per-project index files. */
  dataDirectory: string
  /** Project directory this manager scopes history to. */
  cwd: string
  /** Default provider for fresh sessions. */
  providerId?: string
  /** Default model for fresh sessions. */
  modelId?: string
  /** Environment read for `MINIAGENT_CONTEXT_WINDOW`. */
  env?: NodeJS.ProcessEnv
  /** Catalog endpoint for the context-window lookup. */
  catalogUrl?: string
  /** Receives lifecycle lines (created, saved, pruned) at debug level. */
  logger?: Logger
}

/**
 * Tracks the sessions of one project directory.
 *
 * Histories stay in the global store; the manager keeps a per-directory
 * index (`<dataDirectory>/sessions/<hash>.json`) listing the ids that belong
 * to `cwd`. Several sessions can be open at once, each driven by its own
 * agent (see `App.agentFor`).
 *
 * Sessions are only written to the store on `close()` / `shutdown()` and
 * only when they hold at least one message, so opening an instance never
 * leaves an empty file behind.
 */
export class SessionManager {
  private readonly open = new Map<string, Context>()
  private readonly index: SessionIndex

  private readonly store: ContextStore
  private readonly dataDirectory: string
  private readonly defaultProviderId: string | undefined
  private readonly defaultModelId: string | undefined
  private readonly env: NodeJS.ProcessEnv | undefined
  private readonly catalogUrl: string | undefined
  private readonly logger: Logger | undefined

  /** Project directory this manager scopes history to (resolved). */
  readonly cwd: string

  private constructor(options: SessionManagerOptions, index: SessionIndex) {
    this.store = options.store
    this.dataDirectory = options.dataDirectory
    this.cwd = resolve(options.cwd)
    this.defaultProviderId = options.providerId
    this.defaultModelId = options.modelId
    this.env = options.env
    this.catalogUrl = options.catalogUrl
    this.logger = options.logger
    this.index = index
  }

  /**
   * Loads the index for `options.cwd` from the global data directory. A
   * missing or broken index starts empty; it is repaired on the next write.
   */
  static async create(options: SessionManagerOptions): Promise<SessionManager> {
    const cwd = resolve(options.cwd)
    const index = await SessionIndex.load(SessionIndex.fileFor(options.dataDirectory, cwd), cwd)
    return new SessionManager(options, index)
  }

  /** Sessions currently open in this process. */
  listOpen(): readonly Context[] {
    return [...this.open.values()]
  }

  /** All sessions of this directory, newest first. */
  listHistory(): readonly SessionInfo[] {
    return this.index.list()
  }

  /**
   * Opens a new session for this directory: a fresh, store-bound context
   * with a generated id. Nothing is written to the store until `close()`
   * or `shutdown()`.
   */
  async createSession(): Promise<Context> {
    const context = await this.loadContext(randomUUID())
    await this.resolveWindow(context)
    this.open.set(context.id, context)
    this.index.touch(context.id)
    await this.index.save()
    this.logger?.debug(`created ${context.id} in ${this.cwd}`)
    return context
  }

  /**
   * Resumes a session by id, creating a bound empty one when the store
   * holds nothing yet. The stored provider and model win, matching
   * `Context.load()`. Used at boot for `MINIAGENT_SESSION`.
   */
  async resume(id: string): Promise<Context> {
    const known = this.open.get(id)
    if (known !== undefined) {
      return known
    }
    const context = await this.loadContext(id)
    await this.resolveWindow(context)
    this.open.set(context.id, context)
    this.index.touch(context.id)
    await this.index.save()
    this.logger?.debug(`resumed ${context.id} in ${this.cwd}`)
    return context
  }

  /**
   * Returns an open or stored session, tracking it as open. Returns
   * `undefined` when the id is unknown to this directory and the store.
   */
  async get(id: string): Promise<Context | undefined> {
    const known = this.open.get(id)
    if (known !== undefined) {
      return known
    }
    let snapshot
    try {
      snapshot = await this.store.load(id)
    } catch (error) {
      if (!(error instanceof CorruptSnapshotError)) {
        throw error
      }
      // The store moved the corrupt file aside; continue with a fresh session.
      this.warnIfCorrupt(id, error)
      snapshot = undefined
    }
    if (snapshot === undefined && !this.index.has(id)) {
      return undefined
    }
    const context = await this.loadContext(id)
    await this.resolveWindow(context)
    this.open.set(context.id, context)
    this.index.touch(context.id)
    await this.index.save()
    this.logger?.debug(`attached ${context.id} in ${this.cwd}`)
    return context
  }

  /**
   * Closes one session: saves it when it holds messages, otherwise deletes
   * any stored file and drops the index entry. Closing an unknown id is a
   * no-op. Returns whether anything was saved.
   */
  async close(id: string): Promise<boolean> {
    const context = this.open.get(id)
    if (context === undefined) {
      if (this.index.has(id)) {
        await this.store.delete(id)
        this.index.drop(id)
        await this.index.save()
        this.logger?.debug(`pruned ${id}`)
      }
      return false
    }
    this.open.delete(id)
    if (context.messageCount > 0) {
      await context.save()
      this.index.touch(id)
      this.logger?.debug(`saved ${id}`)
    } else {
      await this.store.delete(id)
      this.index.drop(id)
      this.logger?.debug(`pruned ${id}`)
    }
    await this.index.save()
    return context.messageCount > 0
  }

  /**
   * Closes every open session: non-empty ones are saved, empty ones are
   * pruned. Call when the application shuts down.
   */
  async shutdown(): Promise<void> {
    let saved = 0
    let pruned = 0
    for (const id of [...this.open.keys()]) {
      if (await this.close(id)) {
        saved += 1
      } else {
        pruned += 1
      }
    }
    this.logger?.debug(`shutdown: ${saved} saved, ${pruned} pruned in ${this.cwd}`)
  }

  private contextDefaults() {
    return {
      providerId: this.defaultProviderId,
      modelId: this.defaultModelId,
    }
  }

  /** Fills in the session's context window from the catalog or override. */
  private resolveWindow(context: Context): Promise<void> {
    return resolveContextWindow(context, {
      env: this.env,
      catalogUrl: this.catalogUrl,
      dataDirectory: this.dataDirectory,
      logger: this.logger,
    })
  }

  /**
   * Loads a store-bound context, recovering from a corrupt history file by
   * warning and starting fresh: the store quarantines the corrupt bytes on
   * the first read, so the retry finds nothing and returns an empty context.
   */
  private loadContext(id: string): Promise<Context> {
    return Context.load(this.store, id, {
      ...this.contextDefaults(),
      autoSave: false,
    }).catch((error: unknown) => {
      if (!(error instanceof CorruptSnapshotError)) {
        throw error
      }
      this.warnIfCorrupt(id, error)
      return Context.load(this.store, id, {
        ...this.contextDefaults(),
        autoSave: false,
      })
    })
  }

  private warnIfCorrupt(id: string, error: CorruptSnapshotError): void {
    this.logger?.warn(
      `quarantined corrupt history for "${id}"` +
        (error.quarantinedPath === undefined ? '' : ` at ${error.quarantinedPath}`),
    )
  }
}

/**
 * The session list of one project directory, backed by an index file in the
 * global data directory (`<dataDirectory>/sessions/<hash>.json`).
 *
 * Files on disk are untrusted input: schemas validate every load, and a
 * missing or broken file starts empty (repaired on the next save).
 */
export class SessionIndex {
  private entries: SessionInfo[]

  private constructor(
    readonly file: string,
    readonly cwd: string,
    entries: SessionInfo[] = [],
  ) {
    this.entries = entries
  }

  /** Loads the index for `cwd`. A missing or broken file starts empty. */
  static async load(file: string, cwd: string): Promise<SessionIndex> {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new SessionIndex(file, cwd)
      }
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return new SessionIndex(file, cwd)
    }
    const result = sessionIndexFileSchema.safeParse(parsed)
    if (!result.success || result.data.cwd !== cwd) {
      return new SessionIndex(file, cwd)
    }
    return new SessionIndex(
      file,
      cwd,
      result.data.sessions.filter((entry) => entry.cwd === cwd),
    )
  }

  /** Maps a project directory to a safe index file name. */
  static fileFor(dataDirectory: string, cwd: string): string {
    const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 16)
    return join(dataDirectory, 'sessions', `${hash}.json`)
  }

  /** All entries, newest first. */
  list(): readonly SessionInfo[] {
    return [...this.entries].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }

  has(id: string): boolean {
    return this.entries.some((entry) => entry.id === id)
  }

  /** Adds the id or refreshes its timestamp. */
  touch(id: string): void {
    const now = new Date().toISOString()
    const existing = this.entries.find((entry) => entry.id === id)
    if (existing === undefined) {
      this.entries.push({ id, cwd: this.cwd, createdAt: now, updatedAt: now })
    } else {
      this.entries[this.entries.indexOf(existing)] = { ...existing, updatedAt: now }
    }
  }

  drop(id: string): void {
    this.entries = this.entries.filter((entry) => entry.id !== id)
  }

  /** Persists the index atomically (temp file + rename). */
  async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    await writeFile(
      temporary,
      JSON.stringify({ cwd: this.cwd, sessions: this.entries }, null, 2),
      'utf8',
    )
    await rename(temporary, this.file)
  }
}
