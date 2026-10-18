import { describe, expect, it } from 'vitest'

import {
  commandMenu,
  menuWindow,
  modelMenu,
  sessionMenu,
  type MenuItem,
} from '../../../../src/plugins/builtin/tui/menu.js'
import type { SessionInfo } from '../../../../src/session/manager.js'

function rows(count: number): MenuItem[] {
  return Array.from({ length: count }, (_unused, index) => ({
    label: `row-${index}`,
    hint: '',
    fill: `row-${index} `,
  }))
}

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
      { label: 'openai/gpt-5', hint: '', fill: '/model openai/gpt-5 ', submit: true },
      { label: 'openai/gpt-6-astra', hint: '', fill: '/model openai/gpt-6-astra ', submit: true },
    ])
    expect(modelMenu(ids, 'openai', 'deepseek/')).toEqual([
      {
        label: 'deepseek/deepseek-chat',
        hint: '',
        fill: '/model deepseek/deepseek-chat ',
        submit: true,
      },
    ])
    expect(modelMenu(ids, 'openai', 'zzz')).toEqual([])
  })

  it('keeps every match so the highlight can reach the end', () => {
    const ids = Array.from({ length: 40 }, (_unused, index) => `openai/model-${index}`)

    expect(modelMenu(ids, 'openai', '')).toHaveLength(40)
  })
})

describe('session menu', () => {
  const sessions: SessionInfo[] = [
    {
      id: 'aaaa-1111',
      cwd: '/p',
      createdAt: '2026-10-18T19:00:00Z',
      updatedAt: '2026-10-18T19:00:00Z',
      title: 'Fix login bug',
    },
    {
      id: 'bbbb-2222',
      cwd: '/p',
      createdAt: '2026-10-18T18:00:00Z',
      updatedAt: '2026-10-18T18:00:00Z',
    },
  ]

  it('labels sessions by title and fills the full id', () => {
    expect(sessionMenu(sessions, '')).toEqual([
      {
        label: 'Fix login bug',
        hint: 'aaaa-111 · 2026-10-18 19:00',
        fill: '/resume aaaa-1111 ',
        submit: true,
      },
      {
        label: '(untitled)',
        hint: 'bbbb-222 · 2026-10-18 18:00',
        fill: '/resume bbbb-2222 ',
        submit: true,
      },
    ])
  })

  it('filters by id prefix or title substring', () => {
    expect(sessionMenu(sessions, 'bbbb').map((item) => item.label)).toEqual(['(untitled)'])
    expect(sessionMenu(sessions, 'login').map((item) => item.label)).toEqual(['Fix login bug'])
    expect(sessionMenu(sessions, 'zzz')).toEqual([])
  })
})

describe('menu window', () => {
  it('shows the first rows with a count below', () => {
    const window = menuWindow(rows(20), 0, 8)

    expect(window.items.map((item) => item.label)).toEqual([
      'row-0',
      'row-1',
      'row-2',
      'row-3',
      'row-4',
      'row-5',
      'row-6',
      'row-7',
    ])
    expect(window.selected).toBe(0)
    expect(window.above).toBe(0)
    expect(window.below).toBe(12)
  })

  it('slides once the highlight passes the middle', () => {
    const window = menuWindow(rows(20), 10, 8)

    expect(window.items[0]?.label).toBe('row-6')
    expect(window.items.at(-1)?.label).toBe('row-13')
    expect(window.selected).toBe(4)
    expect(window.above).toBe(6)
    expect(window.below).toBe(6)
  })

  it('stops sliding at the end and keeps the highlight visible', () => {
    const window = menuWindow(rows(20), 19, 8)

    expect(window.items[0]?.label).toBe('row-12')
    expect(window.items.at(-1)?.label).toBe('row-19')
    expect(window.selected).toBe(7)
    expect(window.above).toBe(12)
    expect(window.below).toBe(0)
  })

  it('wraps the highlight around the whole list', () => {
    const wrapped = menuWindow(rows(20), 20, 8)

    expect(wrapped.items[0]?.label).toBe('row-0')
    expect(wrapped.selected).toBe(0)
  })

  it('yields an empty window for no matches', () => {
    expect(menuWindow([], 3, 8)).toEqual({ items: [], selected: 0, above: 0, below: 0 })
  })
})
