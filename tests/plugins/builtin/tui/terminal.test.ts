import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TERMINAL_TITLE,
  terminalTitleSequence,
} from '../../../../src/plugins/builtin/tui/terminal.js'

describe('terminal title', () => {
  it('wraps the title in an OSC sequence', () => {
    expect(terminalTitleSequence('Fix login bug')).toBe('\x1b]0;Fix login bug\x07')
  })

  it('strips control characters so a title cannot inject escapes', () => {
    expect(terminalTitleSequence('Fix\x1b]0;pwned\x07 bug')).toBe('\x1b]0;Fix ]0;pwned bug\x07')
  })

  it('collapses whitespace and falls back for empty titles', () => {
    expect(terminalTitleSequence('  a \n b  ')).toBe('\x1b]0;a b\x07')
    expect(terminalTitleSequence('   ')).toBe(`\x1b]0;${DEFAULT_TERMINAL_TITLE}\x07`)
  })
})
