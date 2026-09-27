import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ModelMessage } from 'ai'

/**
 * Persistence backend for conversation histories.
 *
 * Implement this interface to store contexts anywhere (database, object
 * storage, ...). `FileContextStore` is the built-in file-based implementation.
 */
export interface ContextStore {
  /** Returns the stored messages, or `undefined` when the id is unknown. */
  load(id: string): Promise<ModelMessage[] | undefined>
  save(id: string, messages: readonly ModelMessage[]): Promise<void>
  delete(id: string): Promise<void>
}

/**
 * Stores each conversation as a JSON file (one file per context id) in a
 * directory. Writes are atomic (temp file + rename), so a crash mid-write
 * cannot corrupt an existing history.
 */
export class FileContextStore implements ContextStore {
  constructor(private readonly directory: string) {}

  async load(id: string): Promise<ModelMessage[] | undefined> {
    try {
      const raw = await readFile(this.filePath(id), 'utf8')
      return JSON.parse(raw) as ModelMessage[]
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined
      }
      throw error
    }
  }

  async save(id: string, messages: readonly ModelMessage[]): Promise<void> {
    await mkdir(this.directory, { recursive: true })

    const target = this.filePath(id)
    const temporary = `${target}.tmp`
    await writeFile(temporary, JSON.stringify(messages, null, 2), 'utf8')
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
