import { exec } from 'node:child_process'
import { promisify } from 'node:util'

import { tool } from 'ai'
import { z } from 'zod'

const execAsync = promisify(exec)

/** Output streams beyond this are truncated, so one command cannot eat the window. */
export const MAX_SHELL_CHARS = 100_000

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

export const shellTool = tool({
  description:
    'Run a shell command and return its output. ' +
    'Prefer the read/write/edit tools for file work. ' +
    'The command runs with the user\u2019s privileges; relative workdir resolves ' +
    'against the working directory.',
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
        cwd: workdir ?? process.cwd(),
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
