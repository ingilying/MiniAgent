import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defaultLogger, setConsoleEnabled } from '../src/logger.js'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'miniagent-tui-console-'))
})

afterEach(async () => {
  setConsoleEnabled(true)
  await rm(directory, { recursive: true, force: true })
})

/** Runs the body with stdout captured. */
async function withCapturedStdout(body: () => void): Promise<string> {
  let captured = ''
  const original = process.stdout.write
  process.stdout.write = ((chunk: unknown) => {
    captured += String(chunk)
    return true
  }) as typeof process.stdout.write
  try {
    body()
  } finally {
    process.stdout.write = original
  }
  // Pretty console writes flush asynchronously; the file destination is sync.
  await new Promise((resolve) => setTimeout(resolve, 50))
  return captured
}

describe('console detach', () => {
  it('closes the console stream while the file tee keeps every line', async () => {
    const file = join(directory, 'tui.log')
    const { logger } = defaultLogger(directory, {}, 'info', file)

    const before = await withCapturedStdout(() => {
      logger.info('before')
      logger.flush()
    })
    expect(before).toContain('before')

    setConsoleEnabled(false)
    const during = await withCapturedStdout(() => {
      logger.info('during')
      logger.flush()
    })
    setConsoleEnabled(true)
    const after = await withCapturedStdout(() => {
      logger.info('after')
      logger.flush()
    })

    expect(during).not.toContain('during')
    expect(after).toContain('after')

    const stored = await readFile(file, 'utf8')
    expect(stored).toContain('before')
    expect(stored).toContain('during')
    expect(stored).toContain('after')
  })
})
