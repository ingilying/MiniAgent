import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ModelMessage } from 'ai'
import { z } from 'zod'

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
 * Thrown when a stored history file exists but cannot be read: it holds
 * bytes that are neither JSON nor a known snapshot shape. The corrupt file
 * is moved aside (see `quarantinedPath`) instead of being treated as an
 * empty history, so the damage stays visible and no later save overwrites
 * the evidence.
 */
export class CorruptSnapshotError extends Error {
  readonly id: string
  readonly file: string
  readonly quarantinedPath: string | undefined

  constructor(
    id: string,
    file: string,
    quarantinedPath: string | undefined,
    options?: ErrorOptions,
  ) {
    super(
      `Corrupt history for "${id}" in ${file}` +
        (quarantinedPath === undefined ? '' : ` (moved to ${quarantinedPath})`),
      options,
    )
    this.name = 'CorruptSnapshotError'
    this.id = id
    this.file = file
    this.quarantinedPath = quarantinedPath
  }
}
/**
 * Stores each conversation as a JSON file (one file per context id) in a
 * directory. Writes are atomic (temp file + rename), so a crash mid-write
 * cannot corrupt an existing history.
 */
export class FileContextStore implements ContextStore {
  constructor(private readonly directory: string) {}

  async load(id: string): Promise<ContextSnapshot | undefined> {
    const file = this.filePath(id)
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined
      }
      throw error
    }
    let stored: unknown
    try {
      stored = JSON.parse(raw)
    } catch (cause) {
      throw await this.quarantine(id, file, cause)
    }
    if (Array.isArray(stored)) {
      return { messages: stored as ModelMessage[] }
    }
    const result = contextSnapshotSchema.safeParse(stored)
    if (!result.success) {
      throw await this.quarantine(id, file, new Error('unknown snapshot shape'))
    }
    return {
      messages: result.data.messages as ModelMessage[],
      usage: result.data.usage,
      providerId: result.data.providerId,
      modelId: result.data.modelId,
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

  /**
   * Moves a corrupt history file aside so its bytes survive for inspection,
   * then describes the failure. A move that itself fails keeps the original
   * in place and reports both errors.
   */
  private async quarantine(
    id: string,
    file: string,
    cause: unknown,
  ): Promise<CorruptSnapshotError> {
    const quarantinedPath = `${file}.corrupt-${Date.now()}.json`
    try {
      await rename(file, quarantinedPath)
      return new CorruptSnapshotError(id, file, quarantinedPath, { cause })
    } catch (moveError) {
      return new CorruptSnapshotError(id, file, undefined, {
        cause: new AggregateError([cause, moveError]),
      })
    }
  }
}

const contextSnapshotSchema = z.object({
  messages: z.array(z.unknown()).catch([]),
  usage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number().catch(0),
      cacheReadTokens: z.number().catch(0),
      cacheWriteTokens: z.number().catch(0),
    })
    .optional()
    .catch(undefined),
  providerId: z.string().min(1).optional().catch(undefined),
  modelId: z.string().min(1).optional().catch(undefined),
})

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
