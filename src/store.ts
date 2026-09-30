import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ModelMessage } from 'ai'

/**
 * Token usage reported by the model provider for one response.
 */
export interface ContextUsage {
  /** Total input (prompt) tokens. Already includes cached tokens. */
  readonly inputTokens: number
  /** Output (completion) tokens. */
  readonly outputTokens: number
  /** Input tokens served from the provider's prompt cache. */
  readonly cacheReadTokens: number
  /** Input tokens written to the provider's prompt cache. */
  readonly cacheWriteTokens: number
}

/**
 * Everything that is stored for a conversation: the messages and the usage of
 * the last model response (which is the token count of the conversation).
 */
export interface ContextSnapshot {
  readonly messages: readonly ModelMessage[]
  readonly usage?: ContextUsage
  /** Provider the conversation was created with, when known. */
  readonly providerId?: string
  /** Model the conversation was created with, when known. */
  readonly modelId?: string
}

/**
 * Persistence backend for conversation histories.
 *
 * Implement this interface to store contexts anywhere (database, object
 * storage, ...). `FileContextStore` is the built-in file-based implementation.
 */
export interface ContextStore {
  /** Returns the stored snapshot, or `undefined` when the id is unknown. */
  load(id: string): Promise<ContextSnapshot | undefined>
  save(id: string, snapshot: ContextSnapshot): Promise<void>
  delete(id: string): Promise<void>
}

/**
 * Stores each conversation as a JSON file (one file per context id) in a
 * directory. Writes are atomic (temp file + rename), so a crash mid-write
 * cannot corrupt an existing history.
 */
export class FileContextStore implements ContextStore {
  constructor(private readonly directory: string) {}

  async load(id: string): Promise<ContextSnapshot | undefined> {
    try {
      const raw = await readFile(this.filePath(id), 'utf8')
      return toSnapshot(JSON.parse(raw))
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined
      }
      throw error
    }
  }

  async save(id: string, snapshot: ContextSnapshot): Promise<void> {
    await mkdir(this.directory, { recursive: true })

    const target = this.filePath(id)
    const temporary = `${target}.tmp`
    await writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf8')
    await rename(temporary, target)
  }

  async delete(id: string): Promise<void> {
    await rm(this.filePath(id), { force: true })
  }

  private filePath(id: string): string {
    return join(this.directory, `${toFileName(id)}.json`)
  }
}

/**
 * Reads both the snapshot shape and the older bare message array.
 */
function toSnapshot(stored: unknown): ContextSnapshot {
  if (Array.isArray(stored)) {
    return { messages: stored as ModelMessage[] }
  }
  const snapshot = stored as Partial<ContextSnapshot> | null
  return {
    messages: snapshot?.messages ?? [],
    usage: toUsage(snapshot?.usage),
    providerId: toText(snapshot?.providerId),
    modelId: toText(snapshot?.modelId),
  }
}

function toText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Normalizes stored usage, filling cache numbers missing from older files.
 */
function toUsage(stored: Partial<ContextUsage> | undefined): ContextUsage | undefined {
  if (stored === undefined || typeof stored.inputTokens !== 'number') {
    return undefined
  }
  return {
    inputTokens: stored.inputTokens,
    outputTokens: stored.outputTokens ?? 0,
    cacheReadTokens: stored.cacheReadTokens ?? 0,
    cacheWriteTokens: stored.cacheWriteTokens ?? 0,
  }
}

/**
 * Maps a context id to a safe file name, so ids cannot escape the directory.
 */
function toFileName(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9._-]+/g, '_')
  if (safe.length === 0) {
    throw new Error('Context id must not be empty')
  }
  return safe
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
