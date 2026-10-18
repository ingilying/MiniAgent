import { PassThrough, Writable } from 'node:stream'

import { render } from 'ink'
import { createElement, type ReactElement } from 'react'
import { describe, expect, it } from 'vitest'

import {
  AssistantMessage,
  ErrorMessage,
  LiveAnswer,
  LiveReasoning,
  NoticeMessage,
  ReasoningMessage,
  UserMessage,
} from '../../../../src/plugins/builtin/tui/components.js'

/** Paints one component at a fixed width and returns its plain-text rows. */
async function rows(element: ReactElement, columns = 40): Promise<string[]> {
  const chunks: string[] = []
  const stdout = new Writable({
    write(chunk, _encoding, callback): void {
      chunks.push(String(chunk))
      callback()
    },
  }) as Writable & { isTTY: boolean; columns: number; rows: number }
  stdout.isTTY = true
  stdout.columns = columns
  stdout.rows = 40
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode(mode: boolean): void
  }
  stdin.isTTY = false
  stdin.setRawMode = (): void => {}
  const app = render(element, {
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: new Writable({ write: (_chunk, _enc, callback) => callback() }) as never,
    debug: true,
    patchConsole: false,
  })
  await new Promise((resolve) => setImmediate(resolve))
  const frame = chunks.join('')
  app.unmount()
  return frame
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

const LONG = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron'

describe('transcript rows', () => {
  it('aligns wrapped user text under the prompt marker', async () => {
    const painted = await rows(createElement(UserMessage, { text: LONG }))

    expect(painted.length).toBeGreaterThan(1)
    expect(painted[0]).toMatch(/^> alpha/)
    for (const line of painted.slice(1)) {
      expect(line).toMatch(/^ {2}\S/)
    }
  })

  it('marks the answer and wraps it back to the margin', async () => {
    const painted = await rows(createElement(AssistantMessage, { text: LONG }))

    expect(painted[0]).toMatch(/^● alpha/)
    // Markdown blocks keep the full width, so wrapped prose starts at column 0.
    expect(painted[1]?.startsWith(' ')).toBe(false)
  })

  it('marks reasoning with its own header and indent', async () => {
    const painted = await rows(createElement(ReasoningMessage, { text: 'weigh the options' }))

    expect(painted[0]).toBe('✻ Thinking')
    expect(painted[1]?.trimStart()).toBe('weigh the options')
    expect(painted[1]?.startsWith('  ')).toBe(true)
  })

  it('keeps the error marker and wraps the message red', async () => {
    const painted = await rows(createElement(ErrorMessage, { text: LONG }))

    expect(painted[0]).toMatch(/^✖ alpha/)
    for (const line of painted.slice(1)) {
      expect(line).toMatch(/^ {2}\S/)
    }
  })

  it('puts command output behind a small indent', async () => {
    const painted = await rows(createElement(NoticeMessage, { text: 'Available commands:\n/quit' }))

    expect(painted).toEqual([' Available commands:', ' /quit'])
  })

  it('rides a cursor on the live answer', async () => {
    const painted = await rows(createElement(LiveAnswer, { text: 'writing' }))

    expect(painted[0]).toBe('● writing▍')
  })

  it('renders Markdown while the answer streams', async () => {
    const painted = await rows(createElement(LiveAnswer, { text: 'use `pnpm check` here' }))

    expect(painted[0]).toBe('● use pnpm check here▍')
    expect(painted.join('\n')).not.toContain('`')
  })

  it('shows only the tail of live reasoning', async () => {
    const painted = await rows(createElement(LiveReasoning, { text: 'x'.repeat(400) }))

    expect(painted[0]?.startsWith('✻ …')).toBe(true)
  })
})
