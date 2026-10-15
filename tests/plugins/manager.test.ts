import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import pino from 'pino'

import { PluginManager } from '../../src/plugins/manager.js'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'miniagent-manager-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function manager(): PluginManager {
  return new PluginManager({ dataDirectory: directory, logger: pino({ level: 'silent' }) })
}

describe('PluginManager.execute', () => {
  it('runs in load order and collects defined returns', async () => {
    const seen: string[] = []
    const target = manager()
    target.plugins.push({ name: 'a' }, { name: 'b' }, { name: 'c' })

    const names = await target.execute((plugin) => {
      seen.push(plugin.name)
      return plugin.name
    })

    expect(seen).toEqual(['a', 'b', 'c'])
    expect(names).toEqual(['a', 'b', 'c'])
  })

  it('skips undefined returns', async () => {
    const target = manager()
    target.plugins.push({ name: 'a' }, { name: 'b' })

    const parts = await target.execute((plugin) => (plugin.name === 'a' ? 'prompt-a' : undefined))

    expect(parts).toEqual(['prompt-a'])
  })

  it('wraps failures with the plugin name and keeps the cause', async () => {
    const cause = new Error('kaput')
    const target = manager()
    target.plugins.push({ name: 'boom' })

    const run = target.execute(() => {
      throw cause
    })

    await expect(run).rejects.toThrow('Plugin "boom" failed: kaput')
    await expect(run).rejects.toMatchObject({ cause })
  })
})

describe('PluginManager.executeAll', () => {
  it('starts every plugin before awaiting any', async () => {
    const order: string[] = []
    const gate = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))
    const target = manager()
    target.plugins.push({ name: 'a' }, { name: 'b' })

    await target.executeAll(async (plugin) => {
      order.push(`${plugin.name}:start`)
      await gate()
      order.push(`${plugin.name}:end`)
    })

    expect(order.slice(0, 2).sort()).toEqual(['a:start', 'b:start'])
    expect(order.slice(2).sort()).toEqual(['a:end', 'b:end'])
  })
})

describe('PluginManager.load', () => {
  it('loads file plugins after the built-ins', async () => {
    await writeFile(
      join(directory, 'mine.mjs'),
      `export default { name: 'mine', setup() {} };`,
      'utf8',
    )
    const target = manager()

    await target.load(['./mine.mjs'])

    expect(target.plugins.map((plugin) => plugin.name)).toEqual([
      'deepseek',
      'basic-tools',
      'tui',
      'mine',
    ])
  })
})
