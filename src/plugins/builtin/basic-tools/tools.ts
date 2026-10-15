import { exec } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'

const execAsync = promisify(exec)

/** Files larger than this are refused: slice hints cannot help a full read. */
const MAX_READ_BYTES = 10 * 1024 * 1024

/** Returned text beyond this is truncated, so one file cannot eat the window. */
const MAX_READ_CHARS = 100_000

/** Content larger than this is refused, so one write cannot fill the disk. */
const MAX_WRITE_BYTES = 10 * 1024 * 1024

/** Files larger than this are refused: the whole file is read to edit it. */
const MAX_EDIT_BYTES = 10 * 1024 * 1024

/** Output streams beyond this are truncated, so one command cannot eat the window. */
const MAX_SHELL_CHARS = 100_000

/** Shared note for tool descriptions: paths are project-relative. */
const PATH_NOTE =
  'Relative paths resolve against the session project directory (the host cwd), ' +
  'not the process working directory.'

/** Throws when bytes pass the limit, so one file cannot fill the disk or window. */
function assertSize(subject: string, bytes: number, limit: number, verb: string): void {
  if (bytes > limit) {
    throw new Error(
      `${subject} is ${(bytes / 1024 / 1024).toFixed(1)} MB; refusing to ${verb} it whole.`,
    )
  }
}

interface ExecFailure extends Error {
  code?: number | null
  killed?: boolean
  stdout?: string
  stderr?: string
}

function capped(
  stdout: string,
  stderr: string,
): { stdout: string; stderr: string; truncated?: true } {
  if (stdout.length + stderr.length <= MAX_SHELL_CHARS) {
    return { stdout, stderr }
  }
  const half = Math.floor(MAX_SHELL_CHARS / 2)
  return { stdout: stdout.slice(0, half), stderr: stderr.slice(0, half), truncated: true }
}

/**
 * Builds the basic file and shell tools bound to a project directory.
 *
 * Every relative path the model passes (including a relative shell
 * `workdir`) resolves against `cwd` first, so the tools operate on the
 * session's project directory no matter where the process was started.
 * Absolute paths pass through unchanged. Returned and reported paths are
 * the resolved absolute ones, so the model sees where its call landed.
 */
export function createBasicTools(cwd: string): ToolSet {
  const read = tool({
    description:
      'Read a text file and return its content. ' +
      PATH_NOTE +
      ' Pass offset/limit (1-based lines) to read a slice of a large file.',
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
      const resolved = resolve(cwd, path)
      const size = (await stat(resolved)).size
      assertSize(`File ${resolved}`, size, MAX_READ_BYTES, 'read')
      const content = await readFile(resolved, 'utf8')
      const lines = content.split('\n')
      const start = (offset ?? 1) - 1
      const slice = limit === undefined ? lines.slice(start) : lines.slice(start, start + limit)
      const text = slice.join('\n')
      if (text.length <= MAX_READ_CHARS) {
        return { path: resolved, content: text, lines: lines.length }
      }
      return {
        path: resolved,
        content: text.slice(0, MAX_READ_CHARS),
        lines: lines.length,
        truncated: true,
      }
    },
  })

  const write = tool({
    description:
      'Create or overwrite a text file with the given content. ' +
      'Missing parent directories are created. ' +
      PATH_NOTE,
    inputSchema: z.object({
      path: z.string().min(1).describe('File to write, e.g. "src/index.ts"'),
      content: z.string().describe('Full content to write to the file.'),
    }),
    execute: async ({ path, content }) => {
      const resolved = resolve(cwd, path)
      const bytes = Buffer.byteLength(content, 'utf8')
      assertSize('Content', bytes, MAX_WRITE_BYTES, 'write')
      await mkdir(dirname(resolved), { recursive: true })
      await writeFile(resolved, content, 'utf8')
      return { path: resolved, bytes }
    },
  })

  const edit = tool({
    description:
      'Replace exact text in a file. ' +
      'oldString must occur exactly once, unless replaceAll is true. ' +
      PATH_NOTE,
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
      const resolved = resolve(cwd, path)
      const size = (await stat(resolved)).size
      assertSize(`File ${resolved}`, size, MAX_EDIT_BYTES, 'edit')
      const content = await readFile(resolved, 'utf8')
      const occurrences = content.split(oldString).length - 1
      if (occurrences === 0) {
        throw new Error(`oldString not found in ${resolved}`)
      }
      if (occurrences > 1 && replaceAll !== true) {
        throw new Error(
          `oldString occurs ${occurrences} times in ${resolved}; pass replaceAll to replace all`,
        )
      }
      const updated =
        replaceAll === true
          ? content.split(oldString).join(newString)
          : content.replace(oldString, newString)
      await writeFile(resolved, updated, 'utf8')
      return { path: resolved, replacements: replaceAll === true ? occurrences : 1 }
    },
  })

  const shell = tool({
    description:
      'Run a shell command and return its output. ' +
      'Prefer the read/write/edit tools for file work. ' +
      'The command runs with the user\u2019s privileges; relative workdir resolves ' +
      'against the session project directory (the host cwd), not the process working directory.',
    inputSchema: z.object({
      command: z.string().min(1).describe('Shell command to run, e.g. "pnpm test".'),
      workdir: z
        .string()
        .min(1)
        .optional()
        .describe('Directory to run in. Defaults to the working directory.'),
      timeout: z
        .number()
        .positive()
        .max(300)
        .optional()
        .describe('Timeout in seconds. Defaults to 30.'),
    }),
    execute: async ({ command, workdir, timeout }) => {
      const seconds = timeout ?? 30
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: resolve(cwd, workdir ?? '.'),
          timeout: seconds * 1000,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        })
        return { command, exitCode: 0, ...capped(stdout, stderr) }
      } catch (error) {
        const failure = error as ExecFailure
        if (failure.killed === true) {
          throw new Error(`Command timed out after ${seconds}s: ${command}`, { cause: error })
        }
        return {
          command,
          exitCode: failure.code ?? 1,
          ...capped(failure.stdout ?? '', failure.stderr ?? String(error)),
        }
      }
    },
  })

  return { read, write, edit, shell }
}
