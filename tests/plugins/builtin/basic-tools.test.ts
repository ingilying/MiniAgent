import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createBasicTools } from '../../../src/plugins/builtin/basic-tools/tools.js'
import type { ToolSet } from 'ai'

const toolExecutionOptions = { toolCallId: 'test', messages: [], context: {} }

let directory: string
let tools: ToolSet

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'miniagent-tools-'))
  tools = createBasicTools(directory)
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('read', () => {
  it('reads a whole file', async () => {
    const path = join(directory, 'note.txt')
    await writeFile(path, 'one\ntwo\nthree', 'utf8')

    const output = await tools.read!.execute!({ path }, toolExecutionOptions)

    expect(output).toEqual({ path, content: 'one\ntwo\nthree', lines: 3 })
  })

  it('reads a line slice', async () => {
    const path = join(directory, 'note.txt')
    await writeFile(path, 'one\ntwo\nthree', 'utf8')

    const output = await tools.read!.execute!({ path, offset: 2, limit: 1 }, toolExecutionOptions)

    expect(output).toEqual({ path, content: 'two', lines: 3 })
  })

  it('throws for a missing file', async () => {
    await expect(
      tools.read!.execute!({ path: join(directory, 'missing.txt') }, toolExecutionOptions),
    ).rejects.toThrow()
  })

  it('truncates files beyond the character cap', async () => {
    const path = join(directory, 'big.txt')
    await writeFile(path, `${'x'.repeat(100_001)}\nlast`, 'utf8')

    const output = await tools.read!.execute!({ path }, toolExecutionOptions)

    expect(output).toMatchObject({ lines: 2, truncated: true })
    expect((output as { content: string }).content).toHaveLength(100_000)
  })
})

describe('write', () => {
  it('writes a file and creates parent directories', async () => {
    const path = join(directory, 'sub', 'note.txt')

    const output = await tools.write!.execute!({ path, content: 'hi' }, toolExecutionOptions)

    expect(output).toEqual({ path, bytes: 2 })
    await expect(tools.read!.execute!({ path }, toolExecutionOptions)).resolves.toMatchObject({
      content: 'hi',
    })
  })
})

describe('edit', () => {
  it('replaces exact text once', async () => {
    const path = join(directory, 'note.txt')
    await writeFile(path, 'hello world', 'utf8')

    const output = await tools.edit!.execute!(
      { path, oldString: 'world', newString: 'there' },
      toolExecutionOptions,
    )

    expect(output).toEqual({ path, replacements: 1 })
    await expect(tools.read!.execute!({ path }, toolExecutionOptions)).resolves.toMatchObject({
      content: 'hello there',
    })
  })

  it('throws when the text is missing', async () => {
    const path = join(directory, 'note.txt')
    await writeFile(path, 'hello', 'utf8')

    await expect(
      tools.edit!.execute!({ path, oldString: 'bye', newString: 'x' }, toolExecutionOptions),
    ).rejects.toThrow(/not found/)
  })

  it('throws on multiple matches without replaceAll', async () => {
    const path = join(directory, 'note.txt')
    await writeFile(path, 'a a a', 'utf8')

    await expect(
      tools.edit!.execute!({ path, oldString: 'a', newString: 'b' }, toolExecutionOptions),
    ).rejects.toThrow(/3 times/)
  })

  it('replaces all with replaceAll', async () => {
    const path = join(directory, 'note.txt')
    await writeFile(path, 'a a a', 'utf8')

    const output = await tools.edit!.execute!(
      { path, oldString: 'a', newString: 'b', replaceAll: true },
      toolExecutionOptions,
    )

    expect(output).toEqual({ path, replacements: 3 })
  })
})

describe('basic tools resolve against the injected cwd', () => {
  it('reads, writes, and edits relative paths inside the injected directory', async () => {
    const output = await tools.write!.execute!(
      { path: 'note.txt', content: 'hello world' },
      toolExecutionOptions,
    )

    expect(output).toEqual({ path: join(directory, 'note.txt'), bytes: 11 })

    await expect(
      tools.read!.execute!({ path: 'note.txt' }, toolExecutionOptions),
    ).resolves.toMatchObject({ path: join(directory, 'note.txt'), content: 'hello world' })

    const edited = await tools.edit!.execute!(
      { path: 'note.txt', oldString: 'world', newString: 'there' },
      toolExecutionOptions,
    )

    expect(edited).toEqual({ path: join(directory, 'note.txt'), replacements: 1 })
    await expect(
      tools.read!.execute!({ path: 'note.txt' }, toolExecutionOptions),
    ).resolves.toMatchObject({ content: 'hello there' })
  })

  it('runs shell commands in the injected directory without a workdir', async () => {
    await writeFile(join(directory, 'marker-shell-abc.txt'), 'x', 'utf8')

    const output = await tools.shell!.execute!({ command: 'ls' }, toolExecutionOptions)

    expect(output).toMatchObject({ exitCode: 0 })
    expect((output as { stdout: string }).stdout).toContain('marker-shell-abc.txt')
  })

  it('resolves a relative shell workdir against the injected directory', async () => {
    await tools.write!.execute!(
      { path: join('sub', 'inner.txt'), content: 'x' },
      toolExecutionOptions,
    )

    const output = await tools.shell!.execute!(
      { command: 'ls', workdir: 'sub' },
      toolExecutionOptions,
    )

    expect(output).toMatchObject({ exitCode: 0 })
    expect((output as { stdout: string }).stdout).toContain('inner.txt')
  })
})

describe('shell', () => {
  it('returns output and exit code', async () => {
    const output = await tools.shell!.execute!(
      { command: 'echo hello', workdir: directory },
      toolExecutionOptions,
    )

    expect(output).toMatchObject({ exitCode: 0, stdout: 'hello\n' })
  })

  it('returns non-zero exit codes instead of throwing', async () => {
    const output = await tools.shell!.execute!(
      { command: 'exit 3', workdir: directory },
      toolExecutionOptions,
    )

    expect(output).toMatchObject({ exitCode: 3 })
  })

  it('throws on timeout', async () => {
    await expect(
      tools.shell!.execute!(
        { command: 'sleep 5', workdir: directory, timeout: 1 },
        toolExecutionOptions,
      ),
    ).rejects.toThrow(/timed out/)
  })

  it('truncates huge output instead of returning it whole', async () => {
    const output = await tools.shell!.execute!(
      { command: `node -e "process.stdout.write('y'.repeat(300000))"`, workdir: directory },
      toolExecutionOptions,
    )

    expect(output).toMatchObject({ exitCode: 0, truncated: true })
    expect((output as { stdout: string }).stdout).toHaveLength(50_000)
  })
})
