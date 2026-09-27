import { describe, expect, it } from 'vitest'

import { greet } from '../src/greet.js'

describe('greet', () => {
  it('greets the given name', () => {
    expect(greet('world')).toBe('Hello, world!')
  })

  it('greets any other name', () => {
    expect(greet('MiniAgent')).toBe('Hello, MiniAgent!')
  })
})
