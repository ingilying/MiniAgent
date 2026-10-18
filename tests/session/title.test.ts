import { describe, expect, it } from 'vitest'

import { TITLE_MAX_LENGTH, titleFromAnswer, titleFromMessage } from '../../src/session/title.js'

describe('session title from the first message', () => {
  it('keeps a short message as it is', () => {
    expect(titleFromMessage('Fix the login bug')).toBe('Fix the login bug')
  })

  it('uses the first non-empty line', () => {
    expect(titleFromMessage('\n  First line  \nsecond line')).toBe('First line')
  })

  it('drops Markdown markers and flattens whitespace', () => {
    expect(titleFromMessage('## **Rename**   the   `sessions`   list')).toBe(
      'Rename the sessions list',
    )
  })

  it('cuts a long message at the limit', () => {
    const title = titleFromMessage('x'.repeat(TITLE_MAX_LENGTH + 20))

    expect(title).toHaveLength(TITLE_MAX_LENGTH)
    expect(title.endsWith('…')).toBe(true)
  })

  it('returns an empty title for blank input', () => {
    expect(titleFromMessage('   \n\n  ')).toBe('')
  })
})

describe('session title from the model answer', () => {
  it('keeps a plain answer', () => {
    expect(titleFromAnswer('Fix login bug')).toBe('Fix login bug')
  })

  it('drops a fenced block', () => {
    expect(titleFromAnswer('```\nFix login bug\n```')).toBe('Fix login bug')
  })

  it('drops quotes and a title prefix', () => {
    expect(titleFromAnswer('Title: "Fix login bug"')).toBe('Fix login bug')
    expect(titleFromAnswer('「修复登录问题」')).toBe('修复登录问题')
    expect(titleFromAnswer('**Fix login bug**')).toBe('Fix login bug')
    expect(titleFromAnswer('标题：修复登录问题')).toBe('修复登录问题')
  })

  it('takes the first line of a chatty answer', () => {
    expect(titleFromAnswer('Fix login bug\n\nHope this helps!')).toBe('Fix login bug')
  })

  it('returns an empty title when there is nothing usable', () => {
    expect(titleFromAnswer('```')).toBe('')
    expect(titleFromAnswer('   ')).toBe('')
  })
})
