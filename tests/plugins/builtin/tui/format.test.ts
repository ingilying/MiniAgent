import { describe, expect, it } from 'vitest'

import type { Context } from '../../../../src/session/context.js'
import { contextUsage } from '../../../../src/plugins/builtin/tui/format.js'

describe('TUI usage line', () => {
  it('summarizes context usage', () => {
    const context = (tokenCount: number, contextWindow?: number): Context =>
      ({ tokenCount, contextWindow }) as Context

    expect(contextUsage(context(0))).toBe('—')
    expect(contextUsage(context(950))).toBe('950')
    expect(contextUsage(context(1500, 128000))).toBe('1.5k/128k (1%)')
    expect(contextUsage(context(64000, 128000))).toBe('64k/128k (50%)')
    expect(contextUsage(context(0, 1000000))).toBe('0/1M (0%)')
    expect(contextUsage(context(0, 1050000))).toBe('0/1.1M (0%)')
  })
})
