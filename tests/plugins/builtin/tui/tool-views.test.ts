import { PassThrough, Writable } from 'node:stream'

import { render } from 'ink'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'

import {
  GenericToolView,
  summarize,
  toolView,
  type ToolViewProps,
} from '../../../../src/plugins/builtin/tui/tool-views.js'
import { displayWidth } from '../../../../src/plugins/builtin/tui/width.js'

/** Renders one tool view with Ink in debug mode (plain text, no ANSI). */
async function draw(props: Partial<ToolViewProps> & { toolName: string }): Promise<string> {
  const chunks: string[] = []
  const stdout = new Writable({
    write(chunk, _encoding, callback): void {
      chunks.push(String(chunk))
      callback()
    },
  }) as Writable & { isTTY: boolean; columns: number; rows: number }
  stdout.isTTY = true
  stdout.columns = 80
  stdout.rows = 40
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode(mode: boolean): void
  }
  stdin.isTTY = false
  stdin.setRawMode = (): void => {}
  const view = toolView(props.toolName)
  const app = render(
    createElement(view, {
      input: undefined,
      output: undefined,
      isError: false,
      pending: false,
      spaced: true,
      ...props,
    }),
    {
      stdout: stdout as never,
      stdin: stdin as never,
      stderr: new Writable({ write: (_chunk, _enc, callback) => callback() }) as never,
      debug: true,
      patchConsole: false,
    },
  )
  // Read the first painted frame, then unmount (which paints one more).
  await new Promise((resolve) => setImmediate(resolve))
  const frame = chunks.join('')
  app.unmount()
  return frame
}

describe('tool views', () => {
  it('picks a specialised view per tool and falls back for unknown names', () => {
    expect(toolView('read')).not.toBe(GenericToolView)
    expect(toolView('shell')).not.toBe(GenericToolView)
    expect(toolView('mytool')).toBe(GenericToolView)
    // A name that collides with Object internals is still just a name.
    expect(toolView('constructor')).toBe(GenericToolView)
  })

  it('draws read as numbered lines in a box', async () => {
    const frame = await draw({
      toolName: 'read',
      input: { path: 'src/app.ts', offset: 2 },
      output: { path: '/p/src/app.ts', content: 'import a\nimport b', lines: 42 },
    })

    expect(frame).toContain('⏺ read(src/app.ts)')
    expect(frame).toContain('⎿ 2 of 42 lines')
    expect(frame).toContain('╭')
    expect(frame).toMatch(/2\s+import a/)
    expect(frame).toMatch(/3\s+import b/)
    // The raw output object never leaks into the frame.
    expect(frame).not.toContain('"content"')
  })

  it('folds a long read after its line budget', async () => {
    const content = Array.from({ length: 30 }, (_unused, index) => `line ${index + 1}`).join('\n')

    const frame = await draw({
      toolName: 'read',
      input: { path: 'a.txt' },
      output: { path: '/p/a.txt', content, lines: 30 },
    })

    expect(frame).toMatch(/20\s+line 20/)
    expect(frame).not.toContain('line 21')
    expect(frame).toContain('… +10 more lines')
  })

  it('draws write as the first ten numbered lines', async () => {
    const content = Array.from({ length: 15 }, (_unused, index) => `row ${index + 1}`).join('\n')

    const frame = await draw({
      toolName: 'write',
      input: { path: 'a.txt', content },
      output: { path: '/p/a.txt', bytes: 90 },
    })

    expect(frame).toContain('⎿ 90 bytes · 15 lines')
    expect(frame).toMatch(/1\s+row 1/)
    expect(frame).toMatch(/10\s+row 10/)
    expect(frame).not.toContain('row 11')
    expect(frame).toContain('… +5 more lines')
  })

  it('draws edit with context, removed and added lines', async () => {
    const frame = await draw({
      toolName: 'edit',
      input: { path: 'a.txt', oldString: 'let x = 1', newString: 'let x = 2' },
      output: {
        path: '/p/a.txt',
        replacements: 3,
        change: {
          line: 12,
          before: ['const a = 1'],
          removed: ['let x = 1'],
          added: ['let x = 2'],
          after: ['const b = 2'],
        },
      },
    })

    expect(frame).toContain('⎿ 3 replacements')
    expect(frame).toMatch(/11 {3}const a = 1/)
    expect(frame).toContain('12 - let x = 1')
    expect(frame).toContain('12 + let x = 2')
    expect(frame).toMatch(/13 {3}const b = 2/)
  })

  it('falls back to the call when an edit has no hunk', async () => {
    const frame = await draw({
      toolName: 'edit',
      input: { path: 'a.txt', oldString: 'let x = 1', newString: 'let x = 2' },
      output: { path: '/p/a.txt', replacements: 1 },
    })

    expect(frame).toContain('- let x = 1')
    expect(frame).toContain('+ let x = 2')
  })

  it('draws shell as a box with the command above the result', async () => {
    const frame = await draw({
      toolName: 'shell',
      input: { command: 'pnpm test' },
      output: { command: 'pnpm test', exitCode: 0, stdout: 'ok\nall green\n' },
    })

    expect(frame).toContain('⏺ shell')
    expect(frame).toContain('$ pnpm test')
    expect(frame).toContain('⎿ exit 0 · 2 lines')
    expect(frame).toContain('ok')
    expect(frame).toContain('all green')
    // The command lives in the box, not in the header.
    expect(frame).not.toContain('⏺ shell(pnpm test)')
  })

  it('keeps a long shell command inside the box', async () => {
    const command = `curl -sL "${'x'.repeat(200)}" | python3 -c "print(1)"`
    const frame = await draw({
      toolName: 'shell',
      input: { command },
      output: { command, exitCode: 0, stdout: 'ok\n' },
    })
    const lines = frame.split('\n').filter((line) => line.length > 0)
    const box = lines.filter((line) => /^[│╭╰]/.test(line))

    expect(box.length).toBeGreaterThan(2)
    // Every border line ends at the same column, so the grid is closed.
    const widths = new Set(box.map((line) => line.length))
    expect(widths.size).toBe(1)
    expect(Math.max(...widths)).toBeLessThanOrEqual(80)
    expect(frame).toContain('…')
  })

  it('keeps wide characters inside the box', async () => {
    const command = `echo ${'读取文件内容'.repeat(20)}`
    const frame = await draw({
      toolName: 'shell',
      input: { command },
      output: { command, exitCode: 0, stdout: '完成\n' },
    })
    const box = frame
      .split('\n')
      .filter((line) => /^[│╭╰]/.test(line))
      .map((line) => displayWidth(line))

    expect(box.length).toBeGreaterThan(2)
    expect(Math.max(...box)).toBeLessThanOrEqual(80)
  })

  it('folds a long command after six lines', async () => {
    const command = Array.from({ length: 12 }, (_unused, index) => `echo ${index + 1}`).join('\n')

    const frame = await draw({
      toolName: 'shell',
      input: { command },
      output: { command, exitCode: 0, stdout: 'done\n' },
    })

    expect(frame).toContain('$ echo 1')
    expect(frame).toContain('echo 6')
    expect(frame).not.toContain('echo 7')
    expect(frame).toContain('… +6 more lines')
  })

  it('folds a shell result past ten lines', async () => {
    const stdout = Array.from({ length: 14 }, (_unused, index) => `out ${index + 1}`).join('\n')

    const frame = await draw({
      toolName: 'shell',
      input: { command: 'seq' },
      output: { exitCode: 0, stdout },
    })

    expect(frame).toContain('out 10')
    expect(frame).not.toContain('out 11')
    expect(frame).toContain('… +4 more lines')
  })

  it('shows a pending call with no result line or box', async () => {
    const frame = await draw({ toolName: 'read', input: { path: 'a.txt' }, pending: true })

    expect(frame).toContain('◌ read(a.txt)')
    expect(frame).not.toContain('⎿')
    expect(frame).not.toContain('╭')
  })

  it('shows a failed call as the error, whatever the tool', async () => {
    const frame = await draw({
      toolName: 'read',
      input: { path: 'missing.txt' },
      output: new Error('ENOENT: missing.txt\nsecond line'),
      isError: true,
    })

    expect(frame).toContain('⏺ read(missing.txt)')
    // Once as the summary, the rest as detail: no line is repeated.
    expect(frame.match(/ENOENT: missing\.txt/g)).toHaveLength(1)
    expect(frame).toContain('second line')
    expect(frame).not.toContain('of 0 lines')
  })

  it('falls back to input and output for a tool without a view', async () => {
    const frame = await draw({
      toolName: 'mytool',
      input: { query: 'x' },
      output: { hits: 2 },
    })

    expect(frame).toContain('⏺ mytool({"query":"x"})')
    expect(frame).toContain('⎿ {"hits":2}')
  })

  it('shows text output of a generic tool as detail lines', async () => {
    const frame = await draw({ toolName: 'mytool', input: {}, output: 'alpha\nbeta' })

    expect(frame).toContain('alpha')
    expect(frame).toContain('beta')
  })

  it('keeps one-line previews short', () => {
    const summary = summarize('x'.repeat(300))

    expect(summary).toHaveLength(120)
    expect(summary.endsWith('…')).toBe(true)
  })
})
