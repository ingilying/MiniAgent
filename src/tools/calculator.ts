import { tool } from 'ai'
import { z } from 'zod'

type Operator = '+' | '-' | '*' | '/' | '%' | '^'

type Token =
  | { type: 'number'; value: number }
  | { type: 'operator'; value: Operator }
  | { type: 'parenthesis'; value: '(' | ')' }

const OPERATORS = '+-*/%^'
const DIGIT = /[0-9.]/
const WHITESPACE = /\s/

function tokenize(expression: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < expression.length) {
    const char = expression[i]
    if (char === undefined) {
      break
    }

    if (WHITESPACE.test(char)) {
      i++
      continue
    }

    if (DIGIT.test(char)) {
      let end = i
      let digit = expression[end]
      while (digit !== undefined && DIGIT.test(digit)) {
        end++
        digit = expression[end]
      }
      const text = expression.slice(i, end)
      const value = Number(text)
      if (!Number.isFinite(value)) {
        throw new Error(`Invalid number "${text}" in expression`)
      }
      tokens.push({ type: 'number', value })
      i = end
      continue
    }

    if (OPERATORS.includes(char)) {
      tokens.push({ type: 'operator', value: char as Operator })
      i++
      continue
    }

    if (char === '(' || char === ')') {
      tokens.push({ type: 'parenthesis', value: char })
      i++
      continue
    }

    throw new Error(`Unexpected character "${char}" at position ${i}`)
  }

  return tokens
}

/**
 * Recursive-descent parser for basic arithmetic. Evaluates with the usual
 * precedence: parentheses > unary +/- > ^ (right-associative) > * / % > + -.
 */
class ExpressionParser {
  private position = 0

  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    const value = this.parseSum()
    if (this.position < this.tokens.length) {
      throw new Error(`Unexpected token at position ${this.position}`)
    }
    return value
  }

  private parseSum(): number {
    let left = this.parseProduct()
    for (;;) {
      const operator = this.peekOperator()
      if (operator !== '+' && operator !== '-') {
        return left
      }
      this.position++
      const right = this.parseProduct()
      left = operator === '+' ? left + right : left - right
    }
  }

  private parseProduct(): number {
    let left = this.parsePower()
    for (;;) {
      const operator = this.peekOperator()
      if (operator !== '*' && operator !== '/' && operator !== '%') {
        return left
      }
      this.position++
      const right = this.parsePower()
      left = operator === '*' ? left * right : operator === '/' ? left / right : left % right
    }
  }

  private parsePower(): number {
    const base = this.parseUnary()
    if (this.peekOperator() !== '^') {
      return base
    }
    this.position++
    const exponent = this.parsePower()
    return base ** exponent
  }

  private parseUnary(): number {
    const operator = this.peekOperator()
    if (operator === '-') {
      this.position++
      return -this.parseUnary()
    }
    if (operator === '+') {
      this.position++
      return this.parseUnary()
    }
    return this.parsePrimary()
  }

  private parsePrimary(): number {
    const token = this.tokens[this.position]
    if (token === undefined) {
      throw new Error('Unexpected end of expression')
    }

    if (token.type === 'number') {
      this.position++
      return token.value
    }

    if (token.type === 'parenthesis' && token.value === '(') {
      this.position++
      const value = this.parseSum()
      const closing = this.tokens[this.position]
      if (closing?.type !== 'parenthesis' || closing.value !== ')') {
        throw new Error('Missing closing parenthesis')
      }
      this.position++
      return value
    }

    throw new Error('Expected a number or a parenthesized expression')
  }

  private peekOperator(): Operator | undefined {
    const token = this.tokens[this.position]
    return token?.type === 'operator' ? token.value : undefined
  }
}

/**
 * Safely evaluate a basic arithmetic expression (no `eval`).
 *
 * Supports `+ - * / %`, `^` for exponentiation, parentheses, and unary signs.
 */
export function evaluateExpression(expression: string): number {
  return new ExpressionParser(tokenize(expression)).parse()
}

export const calculatorTool = tool({
  description:
    'Evaluate a mathematical expression and return the numeric result. ' +
    'Supports + - * / % (modulo), ^ (exponent), parentheses, and unary minus.',
  inputSchema: z.object({
    expression: z
      .string()
      .min(1)
      .describe('The arithmetic expression to evaluate, e.g. "2 + 3 * 4"'),
  }),
  execute: async ({ expression }) => {
    const result = evaluateExpression(expression)
    if (!Number.isFinite(result)) {
      throw new Error(`Expression "${expression}" does not evaluate to a finite number`)
    }
    return { expression, result }
  },
})
