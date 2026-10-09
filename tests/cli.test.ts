import { describe, expect, it } from 'vitest'

import { buildCli } from '../src/cli.js'

/** A command wired for tests: it throws instead of exiting and captures output. */
function testCli(version = '1.2.3') {
  let out = ''
  let err = ''
  const program = buildCli(version)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        out += text
      },
      writeErr: (text) => {
        err += text
      },
    })
  return { program, stdout: () => out, stderr: () => err }
}

describe('CLI', () => {
  it('prints the version for -v and --version', () => {
    for (const flag of ['-v', '--version']) {
      const { program, stdout, stderr } = testCli('9.9.9')

      expect(() => program.parse([flag], { from: 'user' })).toThrow()

      expect(stdout()).toBe('9.9.9\n')
      expect(stderr()).toBe('')
    }
  })

  it('takes the prompt as the first positional argument', () => {
    const { program } = testCli()

    program.parse(['what is 6 * 7?'], { from: 'user' })

    expect(program.args).toEqual(['what is 6 * 7?'])
  })

  it('rejects an unknown option', () => {
    const { program, stderr } = testCli()

    expect(() => program.parse(['--nope'], { from: 'user' })).toThrow()

    expect(stderr()).toContain("unknown option '--nope'")
  })
})
