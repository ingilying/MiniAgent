import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { editTool } from '../src/plugins/basic-tools/edit.js'
import { readTool } from '../src/plugins/basic-tools/read.js'
import { shellTool } from '../src/plugins/basic-tools/shell.js'
import { writeTool } from '../src/plugins/basic-tools/write.js'

const toolExecutionOptions = { toolCallId: 'test', messages: [], context: {} }

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'miniagent-tools-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('readTool', () => {
  it('reads a whole file', async () => {
    const path = join(directory, 'note.txt')
    await writeFile(path, 'one\ntwo\nthree', 'utf8')

    const output = await readTool.execute({ path }, toolExecutionOptions)

    expect(output).toEqual({ path, content: 'one\ntwo\nthree', lines: 3 })
  })

  it('reads a line slice', async () => {
    const path = join(directory, 'note.txt')
    await writeFile(path, 'one\ntwo\nthree', 'utf8')

    const output = await readTool.execute({ path, offset: 2, limit: 1 }, toolExecutionOptions)

    expect(output).toEqual({ path, content: 'two', lines: 3 })
  })

  it('throws for a missing file', async () => {
    await expect(
      readTool.execute({ path: join(directory, 'missing.txt') }, toolExecutionOptions),
    ).rejects.toThrow()
  })

  it('truncates files beyond the character cap', async () => {
    const path = join(directory, 'big.txt')
    await writeFile(path, `${'x'.repeat(100_001)}\nlast`, 'utf8')

    const output = await readTool.execute({ path }, toolExecutionOptions)

    expect(output).toMatchObject({ lines: 2, truncated: true })
    expect((output as { content: string }).content).toHaveLength(100_000)
  })
})

describe('writeTool', () => {
  it('writes a file and creates parent directories', async () => {
    const path = join(directory, 'sub', 'note.txt')

    const output = await writeTool.execute({ path, content: 'hi' }, toolExecutionOptions)

    expect(output).toEqual({ path, bytes: 2 })
    await expect(readTool.execute({ path }, toolExecutionOptions)).resolves.toMatchObject({
      content: 'hi',
    })
  })
})

describe('editTool', () => {
  it('replaces exact text once', async () => {
    const path = join(directory, 'note.txt')
    await writeFile(path, 'hello world', 'utf8')

    const output = await editTool.execute(
      { path, oldString: 'world', newString: 'there' },
      toolExecutionOptions,
    )

    expect(output).toEqual({ path, replacements: 1 })
    await expect(readTool.execute({ path }, toolExecutionOptions)).resolves.toMatchObject({
      content: 'hello there',
    })
  })

  it('throws when the text is missing', async () => {
    const path = join(directory, 'note.txt')
    await writeFile(path, 'hello', 'utf8')

    await expect(
      editTool.execute({ path, oldString: 'bye', newString: 'x' }, toolExecutionOptions),
    ).rejects.toThrow(/not found/)
  })

  it('throws on multiple matches without replaceAll', async () => {
    const path = join(directory, 'note.txt')
    await writeFile(path, 'a a a', 'utf8')

    await expect(
      editTool.execute({ path, oldString: 'a', newString: 'b' }, toolExecutionOptions),
    ).rejects.toThrow(/3 times/)
  })

  it('replaces all with replaceAll', async () => {
    const path = join(directory, 'note.txt')
    await writeFile(path, 'a a a', 'utf8')

    const output = await editTool.execute(
      { path, oldString: 'a', newString: 'b', replaceAll: true },
      toolExecutionOptions,
    )

    expect(output).toEqual({ path, replacements: 3 })
  })
})

describe('shellTool', () => {
  it('returns output and exit code', async () => {
    const output = await shellTool.execute(
      { command: 'echo hello', workdir: directory },
      toolExecutionOptions,
    )

    expect(output).toMatchObject({ exitCode: 0, stdout: 'hello\n' })
  })

  it('returns non-zero exit codes instead of throwing', async () => {
    const output = await shellTool.execute(
      { command: 'exit 3', workdir: directory },
      toolExecutionOptions,
    )

    expect(output).toMatchObject({ exitCode: 3 })
  })

  it('throws on timeout', async () => {
    await expect(
      shellTool.execute(
        { command: 'sleep 5', workdir: directory, timeout: 1 },
        toolExecutionOptions,
      ),
    ).rejects.toThrow(/timed out/)
  })

  it('truncates huge output instead of returning it whole', async () => {
    const output = await shellTool.execute(
      { command: `node -e "process.stdout.write('y'.repeat(300000))"`, workdir: directory },
      toolExecutionOptions,
    )

    expect(output).toMatchObject({ exitCode: 0, truncated: true })
    expect((output as { stdout: string }).stdout).toHaveLength(50_000)
  })
})
