import { readFile } from 'node:fs/promises'

import { tool } from 'ai'
import { z } from 'zod'

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
    const content = await readFile(path, 'utf8')
    const lines = content.split('\n')
    const start = (offset ?? 1) - 1
    const slice = limit === undefined ? lines.slice(start) : lines.slice(start, start + limit)
    return { path, content: slice.join('\n'), lines: lines.length }
  },
})
