import { describe, expect, it } from 'vitest'

import { calculatorTool, evaluateExpression } from '../src/tools/calculator.js'
import { getCurrentTimeTool } from '../src/tools/current-time.js'

const toolExecutionOptions = { toolCallId: 'test', messages: [], context: {} }

describe('evaluateExpression', () => {
  it('respects operator precedence', () => {
    expect(evaluateExpression('2 + 3 * 4')).toBe(14)
    expect(evaluateExpression('(1 + 2) * (3 + 4)')).toBe(21)
    expect(evaluateExpression('2 * 3 + 4')).toBe(10)
  })

  it('supports powers and unary signs', () => {
    expect(evaluateExpression('2 ^ 10')).toBe(1024)
    expect(evaluateExpression('2 ^ 3 ^ 2')).toBe(512)
    expect(evaluateExpression('-5 + 10')).toBe(5)
    expect(evaluateExpression('2 * -3')).toBe(-6)
  })

  it('supports modulo and division', () => {
    expect(evaluateExpression('10 % 3')).toBe(1)
    expect(evaluateExpression('10 / 4')).toBe(2.5)
  })

  it('rejects invalid expressions', () => {
    expect(() => evaluateExpression('1 +')).toThrow()
    expect(() => evaluateExpression('foo')).toThrow()
    expect(() => evaluateExpression('(1 + 2')).toThrow()
    expect(() => evaluateExpression('1 2')).toThrow()
    expect(() => evaluateExpression('10 / 0')).not.toThrow()
  })
})

describe('calculatorTool', () => {
  it('evaluates expressions', async () => {
    const output = await calculatorTool.execute({ expression: '6 * 7' }, toolExecutionOptions)
    expect(output).toEqual({ expression: '6 * 7', result: 42 })
  })

  it('throws on non-finite results', async () => {
    await expect(
      calculatorTool.execute({ expression: '10 / 0' }, toolExecutionOptions),
    ).rejects.toThrow(/finite/)
  })
})

describe('getCurrentTimeTool', () => {
  it('returns the time for a given time zone', async () => {
    const output = (await getCurrentTimeTool.execute(
      { timeZone: 'Asia/Seoul' },
      toolExecutionOptions,
    )) as { iso: string; timeZone: string; formatted: string }

    expect(output.timeZone).toBe('Asia/Seoul')
    expect(typeof output.iso).toBe('string')
    expect(typeof output.formatted).toBe('string')
    expect(new Date(output.iso).toString()).not.toBe('Invalid Date')
  })

  it('rejects unknown time zones', async () => {
    await expect(
      getCurrentTimeTool.execute({ timeZone: 'Mars/Olympus' }, toolExecutionOptions),
    ).rejects.toThrow(/Unknown IANA time zone/)
  })
})
