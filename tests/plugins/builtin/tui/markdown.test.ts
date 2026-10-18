import { PassThrough, Writable } from 'node:stream'

import { Text, render } from 'ink'
import { createElement, type ReactElement } from 'react'
import { describe, expect, it } from 'vitest'

import {
  Markdown,
  inlineSpans,
  parseMarkdown,
} from '../../../../src/plugins/builtin/tui/markdown.js'

/** Paints a node at a fixed width and returns the plain frame. */
async function paintNode(element: ReactElement, columns = 60): Promise<string> {
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
    .join('\n')
}

/** Paints a Markdown fragment at a fixed width and returns the plain frame. */
async function paint(text: string, columns = 60): Promise<string> {
  return paintNode(createElement(Markdown, { text }), columns)
}

/** Non-empty painted rows: blank lines carry only spacing. */
async function rows(text: string, columns = 60): Promise<string[]> {
  return (await paint(text, columns)).split('\n').filter((line) => line.length > 0)
}

describe('Markdown blocks', () => {
  it('parses headings, lists, quotes, rules and fences', () => {
    const blocks = parseMarkdown(
      [
        '# Title',
        '',
        'A paragraph.',
        '',
        '- one',
        '- two',
        '',
        '1. first',
        '',
        '> quoted',
        '',
        '---',
        '',
        '```ts',
        'const a = 1',
        '```',
      ].join('\n'),
    )

    expect(blocks.map((block) => block.kind)).toEqual([
      'heading',
      'paragraph',
      'list',
      'list',
      'quote',
      'rule',
      'code',
    ])
  })

  it('parses a table with its alignment', () => {
    const blocks = parseMarkdown(
      ['| name | qty | note |', '| :--- | ---: | :---: |', '| apple | 3 | ok |'].join('\n'),
    )

    expect(blocks).toEqual([
      {
        kind: 'table',
        header: ['name', 'qty', 'note'],
        align: ['left', 'right', 'center'],
        rows: [['apple', '3', 'ok']],
      },
    ])
  })

  it('keeps an unterminated fence as code', () => {
    const blocks = parseMarkdown('```\nstill streaming')

    expect(blocks).toEqual([{ kind: 'code', lang: '', text: 'still streaming' }])
  })

  it('splits inline emphasis into spans', () => {
    expect(inlineSpans('a **b** `c` *d* ~~e~~ [f](https://x)')).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' ' },
      { text: 'c', code: true },
      { text: ' ' },
      { text: 'd', italic: true },
      { text: ' ' },
      { text: 'e', strike: true },
      { text: ' ' },
      { text: 'f', href: 'https://x' },
    ])
  })
})

describe('Markdown rendering', () => {
  it('renders inline emphasis without its markers', async () => {
    const painted = await rows('Use **bold** and `code` and *slanted* text.')

    expect(painted.join('\n')).toContain('Use bold and code and slanted text.')
    expect(painted.join('\n')).not.toContain('**')
    expect(painted.join('\n')).not.toContain('`')
  })

  it('renders a heading without its hashes', async () => {
    const painted = await rows('# Setup')

    expect(painted).toEqual(['Setup'])
  })

  it('prints a link target next to its text', async () => {
    const painted = await rows('see [docs](https://example.test/docs)')

    expect(painted[0]).toBe('see docs (https://example.test/docs)')
  })

  it('renders list markers and nesting', async () => {
    const painted = await rows('- one\n- two\n  - nested')

    expect(painted[0]).toMatch(/^• one/)
    expect(painted[1]).toMatch(/^• two/)
    expect(painted[2]).toMatch(/^ {2}• nested/)
  })

  it('renders ordered lists with their numbers', async () => {
    const painted = await rows('1. first\n2. second')

    expect(painted[0]).toMatch(/^1\. first/)
    expect(painted[1]).toMatch(/^2\. second/)
  })

  it('renders quotes behind a rule and a horizontal rule as a line', async () => {
    const quote = await rows('> quoted line')

    expect(quote[0]).toContain('│')
    expect(quote[0]).toContain('quoted line')

    const rule = await rows('---')
    expect(rule[0]).toMatch(/^─+$/)
  })

  it('renders a fenced code block in a box with its language', async () => {
    const painted = await rows('```ts\nconst a = 1\n```')

    expect(painted.join('\n')).toContain('ts')
    expect(painted.join('\n')).toContain('const a = 1')
    expect(painted.join('\n')).toContain('╭')
  })

  it('renders a table as a bordered grid', async () => {
    const painted = await rows(
      ['| name | qty |', '| :--- | ---: |', '| apple | 3 |', '| kiwi | 12 |'].join('\n'),
    )
    const frame = painted.join('\n')

    expect(frame).toContain('┌')
    expect(frame).toContain('├')
    expect(frame).toContain('└')
    expect(frame).toContain('name')
    expect(frame).toContain('apple')
    // The qty column is right aligned: numbers sit against the right edge.
    expect(frame).toMatch(/│\s+3 │/)
    expect(frame).toMatch(/│\s+12 │/)
  })

  it('keeps inline emphasis inside table cells', async () => {
    const painted = await rows(['| a |', '| --- |', '| **bold** |'].join('\n'))

    expect(painted.join('\n')).toContain('bold')
    expect(painted.join('\n')).not.toContain('**')
  })

  it('wraps a cell that does not fit and keeps the grid closed', async () => {
    const long = 'word '.repeat(30).trim()
    const painted = await rows(['| col |', '| --- |', `| ${long} |`].join('\n'), 40)
    const grid = painted.filter((line) => line.includes('│'))

    // Header, several wrapped body lines, and a separator on every one.
    expect(grid.length).toBeGreaterThan(3)
    for (const line of grid) {
      expect(line.match(/│/g)).toHaveLength(2)
    }
  })

  it('measures wide characters as two columns', async () => {
    const painted = await rows(['| 名称 | qty |', '| --- | --- |', '| 苹果 | 3 |'].join('\n'))

    expect(painted[0]).toBe('┌──────┬─────┐')
    expect(painted.join('\n')).toContain('│ 名称 │ qty │')
  })

  it('appends a suffix inline on the last paragraph', async () => {
    const painted = await paintNode(
      createElement(Markdown, {
        text: 'first\n\nsecond',
        suffix: createElement(Text, null, '▍'),
      }),
    )

    expect(painted).toContain('second▍')
  })

  it('appends a suffix on its own row after a code block', async () => {
    const painted = await paintNode(
      createElement(Markdown, {
        text: '```\ncode\n```',
        suffix: createElement(Text, null, '▍'),
      }),
    )

    expect(painted).toContain('code')
    expect(painted.split('\n').at(-1)).toBe('▍')
  })

  it('separates blocks with a blank line', async () => {
    const painted = await paint('first paragraph\n\nsecond paragraph')

    expect(painted).toContain('first paragraph\n')
    expect(painted.split('\n').filter((line) => line.length === 0).length).toBeGreaterThan(0)
  })
})
