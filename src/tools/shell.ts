import { exec } from 'node:child_process'
import { promisify } from 'node:util'

import { tool } from 'ai'
import { z } from 'zod'

const execAsync = promisify(exec)

interface ExecFailure extends Error {
  code?: number | null
  killed?: boolean
  stdout?: string
  stderr?: string
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
      return { command, exitCode: 0, stdout, stderr }
    } catch (error) {
      const failure = error as ExecFailure
      if (failure.killed === true) {
        throw new Error(`Command timed out after ${seconds}s: ${command}`, { cause: error })
      }
      return {
        command,
        exitCode: failure.code ?? 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? String(error),
      }
    }
  },
})
