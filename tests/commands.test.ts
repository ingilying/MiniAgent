import { describe, expect, it, vi, type Mock } from 'vitest'

import {
  CommandRegistry,
  helpCommand,
  modelCommand,
  parseCommand,
  quitCommand,
  type Command,
  type CommandContext,
  type SessionIdentity,
} from '../src/commands.js'

function ctx(
  current: SessionIdentity = { providerId: 'openai', modelId: 'gpt-6-astra' },
  switchModel: CommandContext['switchModel'] = async () => ({
    providerId: 'openai',
    modelId: 'other',
    contextWindow: undefined,
  }),
): {
  context: CommandContext
  quit: Mock
  notice: Mock
  switchModel: Mock
} {
  const quit = vi.fn()
  const notice = vi.fn()
  const switcher = vi.fn(switchModel)
  return {
    context: { commands: [], current, quit, notice, switchModel: switcher },
    quit,
    notice,
    switchModel: switcher,
  }
}

describe('parseCommand', () => {
  it('splits name and args', () => {
    expect(parseCommand('/quit')).toEqual({ name: 'quit', args: [] })
    expect(parseCommand('/model gpt-6-astra fast')).toEqual({
      name: 'model',
      args: ['gpt-6-astra', 'fast'],
    })
  })

  it('lowercases the name and tolerates extra spaces', () => {
    expect(parseCommand('/  Quit  now  ')).toEqual({ name: 'quit', args: ['now'] })
  })

  it('rejects plain text and a bare slash', () => {
    expect(parseCommand('quit')).toBeUndefined()
    expect(parseCommand('')).toBeUndefined()
    expect(parseCommand('/')).toBeUndefined()
    expect(parseCommand('/   ')).toBeUndefined()
  })
})

describe('CommandRegistry', () => {
  it('finds commands by name or alias, case-insensitively', () => {
    const registry = new CommandRegistry()
    const greet: Command = {
      name: 'greet',
      description: 'Says hi.',
      aliases: ['hello'],
      run: () => {},
    }
    registry.register(greet)

    expect(registry.find('greet')).toBe(greet)
    expect(registry.find('GREET')).toBe(greet)
    expect(registry.find('hello')).toBe(greet)
    expect(registry.find('bye')).toBeUndefined()
  })

  it('rejects duplicate names and aliases', () => {
    const registry = new CommandRegistry()
    registry.register({ name: 'quit', description: 'Bye.', run: () => {} })

    expect(() => registry.register({ name: 'quit', description: 'Again.', run: () => {} })).toThrow(
      /Duplicate command/,
    )
    expect(() =>
      registry.register({ name: 'leave', description: 'Bye.', aliases: ['QUIT'], run: () => {} }),
    ).toThrow(/Duplicate command/)
  })

  it('lists static faces in registration order', () => {
    const registry = new CommandRegistry()
    registry.register(quitCommand)
    registry.register(helpCommand)

    expect(registry.list()).toEqual([
      { name: 'quit', aliases: ['exit', 'q'], description: 'Exit MiniAgent.' },
      { name: 'help', aliases: ['h', '?'], description: 'List available commands.' },
    ])
  })
})

describe('built-in commands', () => {
  it('quit calls back into the frontend', () => {
    const { context, quit } = ctx()
    quitCommand.run([], context)

    expect(quit).toHaveBeenCalledOnce()
  })

  it('help prints every command', () => {
    const { context, notice } = ctx()
    const full: CommandContext = {
      ...context,
      commands: [
        { name: 'quit', aliases: ['exit'], description: 'Exit MiniAgent.' },
        { name: 'help', aliases: [], description: 'List available commands.' },
      ],
    }
    helpCommand.run([], full)

    expect(notice).toHaveBeenCalledOnce()
    const [text] = notice.mock.calls[0] as [string]
    expect(text).toContain('/quit — Exit MiniAgent.')
    expect(text).toContain('/help — List available commands.')
  })

  it('model prints the current session model without args', async () => {
    const { context, notice, switchModel } = ctx()
    await modelCommand.run([], context)

    expect(notice).toHaveBeenCalledOnce()
    expect(notice).toHaveBeenCalledWith('Model: openai/gpt-6-astra')
    expect(switchModel).not.toHaveBeenCalled()
  })

  it('model switches provider and model from one argument', async () => {
    const { context, notice, switchModel } = ctx(
      { providerId: 'openai', modelId: 'gpt-6-astra' },
      async () => ({ providerId: 'deepseek', modelId: 'deepseek-chat', contextWindow: 64000 }),
    )
    await modelCommand.run(['deepseek/deepseek-chat'], context)

    expect(switchModel).toHaveBeenCalledWith('deepseek', 'deepseek-chat')
    expect(notice).toHaveBeenCalledWith('Switched to deepseek/deepseek-chat. (64,000 token window)')
  })

  it('model keeps the provider when only a model is given', async () => {
    const { context, switchModel } = ctx()
    await modelCommand.run(['other-model'], context)

    expect(switchModel).toHaveBeenCalledWith('openai', 'other-model')
  })

  it('model rejects extra or empty arguments with usage', async () => {
    const { context, notice, switchModel } = ctx()
    await modelCommand.run(['a', 'b'], context)
    await modelCommand.run(['a/'], context)

    expect(switchModel).not.toHaveBeenCalled()
    expect(notice).toHaveBeenNthCalledWith(1, 'Usage: /model [provider/]model')
    expect(notice).toHaveBeenNthCalledWith(2, 'Usage: /model [provider/]model')
  })
})
