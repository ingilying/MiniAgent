import { readFile, stat, writeFile } from 'node:fs/promises'

import { tool } from 'ai'
import { z } from 'zod'

/** Files larger than this are refused: the whole file is read to edit it. */
export const MAX_EDIT_BYTES = 10 * 1024 * 1024

export const editTool = tool({
  description:
    'Replace exact text in a file. ' +
    'oldString must occur exactly once, unless replaceAll is true. ' +
    'Relative paths resolve against the working directory.',
  inputSchema: z.object({
    path: z.string().min(1).describe('File to edit, e.g. "src/index.ts"'),
    oldString: z.string().min(1).describe('Exact text to find and replace.'),
    newString: z.string().describe('Text to replace oldString with.'),
    replaceAll: z
      .boolean()
      .optional()
      .describe('Replace every occurrence. Defaults to false (exactly one expected).'),
  }),
  execute: async ({ path, oldString, newString, replaceAll }) => {
    const size = (await stat(path)).size
    if (size > MAX_EDIT_BYTES) {
      throw new Error(
        `File ${path} is ${(size / 1024 / 1024).toFixed(1)} MB; refusing to edit it whole.`,
      )
    }
    const content = await readFile(path, 'utf8')
    const occurrences = content.split(oldString).length - 1
    if (occurrences === 0) {
      throw new Error(`oldString not found in ${path}`)
    }
    if (occurrences > 1 && replaceAll !== true) {
      throw new Error(
        `oldString occurs ${occurrences} times in ${path}; pass replaceAll to replace all`,
      )
    }
    const updated =
      replaceAll === true
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString)
    await writeFile(path, updated, 'utf8')
    return { path, replacements: replaceAll === true ? occurrences : 1 }
  },
})
