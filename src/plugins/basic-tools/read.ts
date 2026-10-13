import { readFile, stat } from 'node:fs/promises'

import { tool } from 'ai'
import { z } from 'zod'

/** Files larger than this are refused: slice hints cannot help a full read. */
export const MAX_READ_BYTES = 10 * 1024 * 1024

/** Returned text beyond this is truncated, so one file cannot eat the window. */
export const MAX_READ_CHARS = 100_000

export const readTool = tool({
  description:
    'Read a text file and return its content. ' +
    'Relative paths resolve against the working directory. ' +
    'Pass offset/limit (1-based lines) to read a slice of a large file.',
  inputSchema: z.object({
    path: z.string().min(1).describe('File to read, e.g. "src/index.ts"'),
    offset: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('First line to return (1-based). Defaults to 1.'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Maximum lines to return. Defaults to the whole file.'),
  }),
  execute: async ({ path, offset, limit }) => {
    const size = (await stat(path)).size
    if (size > MAX_READ_BYTES) {
      throw new Error(
        `File ${path} is ${(size / 1024 / 1024).toFixed(1)} MB; refusing to read it whole.`,
      )
    }
    const content = await readFile(path, 'utf8')
    const lines = content.split('\n')
    const start = (offset ?? 1) - 1
    const slice = limit === undefined ? lines.slice(start) : lines.slice(start, start + limit)
    const text = slice.join('\n')
    if (text.length <= MAX_READ_CHARS) {
      return { path, content: text, lines: lines.length }
    }
    return {
      path,
      content: text.slice(0, MAX_READ_CHARS),
      lines: lines.length,
      truncated: true,
    }
  },
})
