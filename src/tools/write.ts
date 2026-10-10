import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { tool } from 'ai'
import { z } from 'zod'

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
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
    return { path, bytes: Buffer.byteLength(content, 'utf8') }
  },
})
