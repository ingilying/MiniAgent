import { describe, expect, it } from 'vitest'

import { commandMenu, modelMenu } from '../../../../src/plugins/builtin/tui/menu.js'

describe('TUI menu', () => {
  it('builds command menu rows by name or alias prefix', () => {
    const commands = [
      { name: 'quit', aliases: ['exit', 'q'], description: 'Exit.' },
      { name: 'help', aliases: ['h', '?'], description: 'Help.' },
    ]

    expect(commandMenu(commands, '').map((item) => item.label)).toEqual(['/help', '/quit'])
    expect(commandMenu(commands, 'q')).toEqual([{ label: '/quit', hint: 'Exit.', fill: '/quit ' }])
    expect(commandMenu(commands, 'QU').map((item) => item.label)).toEqual(['/quit'])
    expect(commandMenu(commands, 'h').map((item) => item.label)).toEqual(['/help'])
    expect(commandMenu(commands, 'e').map((item) => item.label)).toEqual(['/quit'])
    expect(commandMenu(commands, 'zzz')).toEqual([])
  })

  it('builds model menu rows with the current provider first', () => {
    const ids = ['openai/gpt-5', 'openai/gpt-6-astra', 'deepseek/deepseek-chat']

    expect(modelMenu(ids, 'openai', '').map((item) => item.label)).toEqual([
      'openai/gpt-5',
      'openai/gpt-6-astra',
      'deepseek/deepseek-chat',
    ])
    expect(modelMenu(ids, 'openai', 'gpt').map((item) => item.label)).toEqual([
      'openai/gpt-5',
      'openai/gpt-6-astra',
    ])
    expect(modelMenu(ids, 'deepseek', 'gpt')).toEqual([
      { label: 'openai/gpt-5', hint: '', fill: '/model openai/gpt-5 ' },
      { label: 'openai/gpt-6-astra', hint: '', fill: '/model openai/gpt-6-astra ' },
    ])
    expect(modelMenu(ids, 'openai', 'deepseek/')).toEqual([
      { label: 'deepseek/deepseek-chat', hint: '', fill: '/model deepseek/deepseek-chat ' },
    ])
    expect(modelMenu(ids, 'openai', 'zzz')).toEqual([])
  })
})
