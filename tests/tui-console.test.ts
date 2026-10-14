import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defaultLogger, fileLogger, headlessLogger } from '../src/logger.js'

let directory: string
let originalIsTTY: boolean

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'miniagent-tui-console-'))
  originalIsTTY = process.stdout.isTTY
})

afterEach(async () => {
  process.stdout.isTTY = originalIsTTY
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

describe('loggers', () => {
  it('headless logger writes console and file together', async () => {
    const file = join(directory, 'headless.log')
    const { logger } = headlessLogger(directory, {}, 'info', file)

    const shown = await withCapturedStdout(() => {
      logger.info('hello')
      logger.flush()
    })

    expect(shown).toContain('hello')
    expect(await readFile(file, 'utf8')).toContain('hello')
  })

  it('file logger writes file only', async () => {
    const file = join(directory, 'tui.log')
    const { logger } = fileLogger(directory, {}, 'info', file)

    const shown = await withCapturedStdout(() => {
      logger.info('hello')
      logger.flush()
    })

    expect(shown).not.toContain('hello')
    expect(await readFile(file, 'utf8')).toContain('hello')
  })

  it('defaultLogger picks file logger on TTY, headless logger otherwise', async () => {
    process.stdout.isTTY = true
    const tuiFile = join(directory, 'default-tui.log')
    const tuiShown = await withCapturedStdout(() => {
      const { logger } = defaultLogger(directory, {}, 'info', tuiFile)
      logger.info('tui line')
      logger.flush()
    })
    expect(tuiShown).not.toContain('tui line')
    expect(await readFile(tuiFile, 'utf8')).toContain('tui line')

    process.stdout.isTTY = false
    const headlessFile = join(directory, 'default-headless.log')
    const headlessShown = await withCapturedStdout(() => {
      const { logger } = defaultLogger(directory, {}, 'info', headlessFile)
      logger.info('headless line')
      logger.flush()
    })
    expect(headlessShown).toContain('headless line')
    expect(await readFile(headlessFile, 'utf8')).toContain('headless line')
  })
})
