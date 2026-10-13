import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { tool } from 'ai'
import { z } from 'zod'

/** Content larger than this is refused, so one write cannot fill the disk. */
export const MAX_WRITE_BYTES = 10 * 1024 * 1024

export const writeTool = tool({
  description:
    'Create or overwrite a text file with the given content. ' +
    'Missing parent directories are created. ' +
    'Relative paths resolve against the working directory.',
  inputSchema: z.object({
    path: z.string().min(1).describe('File to write, e.g. "src/index.ts"'),
    content: z.string().describe('Full content to write to the file.'),
  }),
  execute: async ({ path, content }) => {
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_WRITE_BYTES) {
      throw new Error(
        `Content is ${(bytes / 1024 / 1024).toFixed(1)} MB; refusing to write it whole.`,
      )
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
    return { path, bytes }
  },
})
