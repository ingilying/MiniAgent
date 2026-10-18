import { describe, expect, it } from 'vitest'

import { commandMenu, modelMenu } from '../../../../src/plugins/builtin/tui/menu.js'

describe('TUI menu', () => {
  it('builds command menu rows by name or alias prefix', () => {
    const commands = [
      { name: 'quit', aliases: ['exit', 'q'], description: 'Exit.' },
      { name: 'help', aliases: ['h', '?'], description: 'Help.' },
    ]

    expect(commandMenu(commands, '').items.map((item) => item.label)).toEqual(['/help', '/quit'])
    expect(commandMenu(commands, 'q').items).toEqual([
      { label: '/quit', hint: 'Exit.', fill: '/quit ' },
    ])
    expect(commandMenu(commands, 'QU').items.map((item) => item.label)).toEqual(['/quit'])
    expect(commandMenu(commands, 'h').items.map((item) => item.label)).toEqual(['/help'])
    expect(commandMenu(commands, 'e').items.map((item) => item.label)).toEqual(['/quit'])
    expect(commandMenu(commands, 'zzz').items).toEqual([])
  })

  it('builds model menu rows with the current provider first', () => {
    const ids = ['openai/gpt-5', 'openai/gpt-6-astra', 'deepseek/deepseek-chat']

    expect(modelMenu(ids, 'openai', '').items.map((item) => item.label)).toEqual([
      'openai/gpt-5',
      'openai/gpt-6-astra',
      'deepseek/deepseek-chat',
    ])
    expect(modelMenu(ids, 'openai', 'gpt').items.map((item) => item.label)).toEqual([
      'openai/gpt-5',
      'openai/gpt-6-astra',
    ])
    expect(modelMenu(ids, 'deepseek', 'gpt').items).toEqual([
      { label: 'openai/gpt-5', hint: '', fill: '/model openai/gpt-5 ' },
      { label: 'openai/gpt-6-astra', hint: '', fill: '/model openai/gpt-6-astra ' },
    ])
    expect(modelMenu(ids, 'openai', 'deepseek/').items).toEqual([
      { label: 'deepseek/deepseek-chat', hint: '', fill: '/model deepseek/deepseek-chat ' },
    ])
    expect(modelMenu(ids, 'openai', 'zzz').items).toEqual([])
  })

  it('caps the rows and counts the rest as hidden', () => {
    const ids = Array.from({ length: 20 }, (_unused, index) => `openai/model-${index}`)
    const menu = modelMenu(ids, 'openai', '')

    expect(menu.items).toHaveLength(15)
    expect(menu.hidden).toBe(5)
  })
})
