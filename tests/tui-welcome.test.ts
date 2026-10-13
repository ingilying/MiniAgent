import { describe, expect, it } from 'vitest'

import { titleArt } from '../src/plugins/tui/welcome.js'

describe('welcome title art', () => {
  it('renders five rows of equal width', () => {
    const rows = titleArt('MINIAGENT')

    expect(rows).toHaveLength(5)
    expect(rows.every((row) => row.length > 0)).toBe(true)
    const widths = new Set(rows.map((row) => row.length))
    expect(widths.size).toBe(1)
  })

  it('renders unknown characters blank without breaking the grid', () => {
    const rows = titleArt('A?')

    expect(rows).toHaveLength(5)
    const widths = new Set(rows.map((row) => row.length))
    expect(widths.size).toBe(1)
    expect(rows.join('')).toContain('█')
  })
})
