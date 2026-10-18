import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ModelMessage } from 'ai'
import { z } from 'zod'

/**
 * Version of the on-disk session log format. Every log file starts with a
 * header recording its version; a reader that does not know the version
 * refuses the file instead of guessing, so an older build cannot rewrite a
 * newer log.
 */
export const SESSION_LOG_VERSION = 1

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
 * One turn of a conversation, as appended to a session log: the messages a
 * finished run added, the usage it reported, and the identity it ran on.
 */
export interface TurnRecord {
  readonly messages: readonly ModelMessage[]
  readonly usage?: ContextUsage
  readonly providerId?: string
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
  /**
   * Rewrites the whole history in one write (compaction). Drops any per-turn
   * structure the backend keeps; `load()` still returns the same history.
   */
  save(id: string, snapshot: ContextSnapshot): Promise<void>
  /**
   * Appends one turn to the stored history without rewriting it. Called once
   * per finished run, so a crash loses at most the turn in flight.
   */
  append(id: string, turn: TurnRecord): Promise<void>
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
 * Stores each conversation as an append-only log (one file per context id) in
 * a directory. The file is JSON Lines: a header holding the format version,
 * then one line per record — a `turn` appended after each run, or a
 * `snapshot` written by `save()`, which compacts the log.
 *
 * `load()` folds the records back into a snapshot. A history file in the
 * older single-object format (a bare message array or one snapshot object) is
 * still read, and the next append migrates it to the log format.
 *
 * Compaction writes are atomic (temp file + rename), so a crash mid-write
 * cannot corrupt an existing history. An append is a single `appendFile`;
 * the only damage a crash can do there is a torn last line, which `load()`
 * ignores and the next append drops.
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
    if (raw.trim().length === 0) {
      return undefined
    }
    const legacy = parseWholesaleSnapshot(raw)
    if (legacy !== undefined) {
      return legacy
    }
    return this.readLog(id, file, raw)
  }

  async save(id: string, snapshot: ContextSnapshot): Promise<void> {
    await this.writeLog(id, [header(id), snapshotRecord(snapshot)])
  }

  async append(id: string, turn: TurnRecord): Promise<void> {
    const file = this.filePath(id)
    const record = { type: 'turn', at: new Date().toISOString(), ...turn }
    const state = await inspectLog(file)
    if (state.kind === 'missing') {
      await this.writeLog(id, [header(id), record])
      return
    }
    if (state.kind === 'log') {
      if (state.repair !== undefined) {
        await this.writeText(file, state.repair)
      }
      await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
      return
    }
    // An older single-object history: rewrite it as a log and keep the turn.
    const snapshot = await this.load(id)
    await this.writeLog(id, [
      header(id),
      ...(snapshot === undefined ? [] : [snapshotRecord(snapshot)]),
      record,
    ])
  }

  async delete(id: string): Promise<void> {
    await rm(this.filePath(id), { force: true })
  }

  private filePath(id: string): string {
    return join(this.directory, `${toFileName(id)}.json`)
  }

  /** Folds the records of a log file into one snapshot. */
  private async readLog(id: string, file: string, raw: string): Promise<ContextSnapshot> {
    const { records, corrupt } = parseLines(raw)
    if (corrupt) {
      throw await this.quarantine(id, file, new Error('malformed session log record'))
    }
    const head = records[0] === undefined ? undefined : headerSchema.safeParse(records[0])
    if (head === undefined || !head.success) {
      throw await this.quarantine(id, file, new Error('missing session log header'))
    }
    assertVersion(head.data.version, file)

    const snapshot: {
      messages: ModelMessage[]
      usage?: ContextUsage
      providerId?: string
      modelId?: string
    } = { messages: [] }
    for (const record of records.slice(1)) {
      const folded = foldRecord(record)
      if (folded === undefined) {
        throw await this.quarantine(id, file, new Error('malformed session log record'))
      }
      if (folded.kind === 'skip') {
        continue
      }
      if (folded.kind === 'snapshot') {
        snapshot.messages = [...folded.messages]
      } else {
        snapshot.messages.push(...folded.messages)
      }
      if (folded.usage !== undefined) {
        snapshot.usage = folded.usage
      }
      if (folded.providerId !== undefined) {
        snapshot.providerId = folded.providerId
      }
      if (folded.modelId !== undefined) {
        snapshot.modelId = folded.modelId
      }
    }
    return snapshot
  }

  /** Writes the records as a fresh log file, atomically. */
  private writeLog(id: string, records: readonly unknown[]): Promise<void> {
    const text = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
    return this.writeText(this.filePath(id), text)
  }

  /** Writes a whole file through a temp file and a rename. */
  private async writeText(file: string, text: string): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const temporary = `${file}.tmp`
    await writeFile(temporary, text, 'utf8')
    await rename(temporary, file)
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

/** Bytes read to recognise a log header before appending to it. */
const HEAD_BYTES = 512

/**
 * What `append()` finds on disk:
 *
 * - `missing`: no file, or an empty one — write a fresh log;
 * - `log`: a versioned log — append one line, after `repair` when a crash
 *   left a torn last line;
 * - `legacy`: any other format — load it, then rewrite it as a log.
 */
type LogState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'log'; readonly repair?: string }
  | { readonly kind: 'legacy' }

/**
 * Probes a log file with two small reads instead of reading all of it, so an
 * append stays cheap. A file that does not start with a readable header line
 * counts as legacy and goes through the load-and-rewrite path.
 */
async function inspectLog(file: string): Promise<LogState> {
  let handle
  try {
    handle = await open(file, 'r')
  } catch (error) {
    if (isNotFoundError(error)) {
      return { kind: 'missing' }
    }
    throw error
  }
  try {
    const { size } = await handle.stat()
    if (size === 0) {
      return { kind: 'missing' }
    }
    const head = Buffer.alloc(Math.min(size, HEAD_BYTES))
    await handle.read(head, 0, head.length, 0)
    const lineEnd = head.indexOf(0x0a)
    if (lineEnd === -1) {
      return { kind: 'legacy' }
    }
    if (!isLogHeader(head.subarray(0, lineEnd).toString('utf8'), file)) {
      return { kind: 'legacy' }
    }
    const last = Buffer.alloc(1)
    await handle.read(last, 0, 1, size - 1)
    if (last[0] === 0x0a) {
      return { kind: 'log' }
    }
    return { kind: 'log', repair: dropTornTail(await readFile(file, 'utf8')) }
  } finally {
    await handle.close()
  }
}

/** Whether one line is a log header this build can append to. */
function isLogHeader(line: string, file: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return false
  }
  const result = headerSchema.safeParse(parsed)
  if (!result.success) {
    return false
  }
  assertVersion(result.data.version, file)
  return true
}

/**
 * Drops a final line that a crash left half-written. `load()` already ignores
 * it; the repair makes room for the next append, which would otherwise glue
 * its line onto the torn one. Returns the text to write back.
 */
function dropTornTail(text: string): string {
  if (text.endsWith('\n')) {
    return text
  }
  const end = text.lastIndexOf('\n')
  if (end === -1) {
    return text
  }
  const tail = text.slice(end + 1)
  try {
    JSON.parse(tail)
    return `${text}\n`
  } catch {
    return text.slice(0, end + 1)
  }
}

/** Splits JSON Lines into records. A torn last line is ignored, not fatal. */
function parseLines(text: string): { records: unknown[]; corrupt: boolean } {
  const lines = text.split('\n')
  const records: unknown[] = []
  let corrupt = false
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue
    }
    try {
      records.push(JSON.parse(line))
    } catch {
      if (index !== lines.length - 1) {
        corrupt = true
      }
    }
  }
  return { records, corrupt }
}

/**
 * Reads a history file in the older single-object format: a bare message
 * array, or one snapshot object. Returns `undefined` for anything else, which
 * `load()` then reads as a log.
 */
function parseWholesaleSnapshot(text: string): ContextSnapshot | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (Array.isArray(parsed)) {
    return { messages: parsed as ModelMessage[] }
  }
  if (typeof parsed !== 'object' || parsed === null || 'type' in parsed) {
    return undefined
  }
  const result = snapshotFieldsSchema.safeParse(parsed)
  if (!result.success) {
    return undefined
  }
  return toSnapshot(result.data)
}

/** One folded record: replaces the history, extends it, or adds nothing. */
type Folded =
  | {
      readonly kind: 'snapshot' | 'turn'
      readonly messages: readonly ModelMessage[]
      readonly usage?: ContextUsage
      readonly providerId?: string
      readonly modelId?: string
    }
  | { readonly kind: 'skip' }

/** Folds one record. Unknown record types are skipped for forward compatibility. */
function foldRecord(record: unknown): Folded | undefined {
  const type =
    typeof record === 'object' && record !== null ? (record as { type?: unknown }).type : undefined
  if (type === 'snapshot') {
    const result = snapshotRecordSchema.safeParse(record)
    return result.success ? { kind: 'snapshot', ...toSnapshot(result.data) } : undefined
  }
  if (type === 'turn') {
    const result = turnRecordSchema.safeParse(record)
    return result.success ? { kind: 'turn', ...toSnapshot(result.data) } : undefined
  }
  return typeof type === 'string' ? { kind: 'skip' } : undefined
}

function assertVersion(version: number, file: string): void {
  if (version !== SESSION_LOG_VERSION) {
    throw new Error(
      `Unsupported session log version ${version} in ${file}.` +
        ` This build reads version ${SESSION_LOG_VERSION}.`,
    )
  }
}

function header(id: string): Record<string, unknown> {
  return { type: 'session', version: SESSION_LOG_VERSION, id, createdAt: new Date().toISOString() }
}

function snapshotRecord(snapshot: ContextSnapshot): Record<string, unknown> {
  return {
    type: 'snapshot',
    version: SESSION_LOG_VERSION,
    messages: snapshot.messages,
    usage: snapshot.usage,
    providerId: snapshot.providerId,
    modelId: snapshot.modelId,
  }
}

const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number().catch(0),
  cacheReadTokens: z.number().catch(0),
  cacheWriteTokens: z.number().catch(0),
})

/** The fields shared by a snapshot, a turn record, and a v0 history file. */
const snapshotFieldsSchema = z.object({
  messages: z.array(z.unknown()).catch([]),
  usage: usageSchema.optional().catch(undefined),
  providerId: z.string().min(1).optional().catch(undefined),
  modelId: z.string().min(1).optional().catch(undefined),
})

const headerSchema = z.object({
  type: z.literal('session'),
  version: z.number().int().positive(),
  id: z.string().min(1),
  createdAt: z.string().optional(),
})

const snapshotRecordSchema = snapshotFieldsSchema.extend({
  type: z.literal('snapshot'),
})

const turnRecordSchema = snapshotFieldsSchema.extend({
  type: z.literal('turn'),
  messages: z.array(z.unknown()),
})

type SnapshotFields = z.infer<typeof snapshotFieldsSchema>

function toSnapshot(fields: SnapshotFields): ContextSnapshot {
  return {
    messages: fields.messages as ModelMessage[],
    usage: fields.usage,
    providerId: fields.providerId,
    modelId: fields.modelId,
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
