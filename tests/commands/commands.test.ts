import { describe, expect, it, vi, type Mock } from 'vitest'

import {
  CommandRegistry,
  helpCommand,
  modelCommand,
  modelsCommand,
  parseCommand,
  quitCommand,
  type Command,
  type CommandContext,
  type SessionIdentity,
} from '../../src/commands/commands.js'

function ctx(
  current: SessionIdentity = { providerId: 'openai', modelId: 'gpt-6-astra' },
  switchModel: CommandContext['switchModel'] = async () => ({
    providerId: 'openai',
    modelId: 'other',
    contextWindow: undefined,
  }),
  extra: { providers?: readonly string[]; knownModels?: readonly string[] } = {},
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
    context: {
      commands: [],
      current,
      providers: extra.providers ?? ['openai', 'deepseek'],
      knownModels: extra.knownModels ?? [],
      quit,
      notice,
      switchModel: switcher,
    },
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

  it('model keeps the current provider for a model id that contains a slash', async () => {
    const { context, switchModel } = ctx()
    await modelCommand.run(['meta-llama/llama-4-scout-17b-16e-instruct'], context)

    expect(switchModel).toHaveBeenCalledWith('openai', 'meta-llama/llama-4-scout-17b-16e-instruct')
  })

  it('model treats the prefix as a provider only when it is loaded', async () => {
    const { context, switchModel } = ctx(
      { providerId: 'openai', modelId: 'gpt-6-astra' },
      async () => ({ providerId: 'deepseek', modelId: 'x/y', contextWindow: 1000 }),
    )
    await modelCommand.run(['deepseek/x/y'], context)

    expect(switchModel).toHaveBeenCalledWith('deepseek', 'x/y')
  })

  it('model warns about an unknown model but still tries it', async () => {
    const { context, notice, switchModel } = ctx(
      { providerId: 'openai', modelId: 'gpt-6-astra' },
      undefined,
      { knownModels: ['openai/gpt-6-astra', 'openai/gpt-5'] },
    )
    await modelCommand.run(['openai/ghost'], context)

    expect(switchModel).toHaveBeenCalledWith('openai', 'ghost')
    expect(notice).toHaveBeenNthCalledWith(1, 'Unknown model "openai/ghost". Trying it anyway.')
    expect(notice).toHaveBeenNthCalledWith(2, 'Switched to openai/other. Context window unknown.')
  })

  it('model hints when the slash prefix is not a loaded provider', async () => {
    const { context, notice, switchModel } = ctx(
      { providerId: 'openai', modelId: 'gpt-6-astra' },
      undefined,
      { knownModels: ['openai/gpt-6-astra'] },
    )
    await modelCommand.run(['xai/grok-4'], context)

    expect(switchModel).toHaveBeenCalledWith('openai', 'xai/grok-4')
    expect(notice).toHaveBeenNthCalledWith(
      1,
      'Unknown model "openai/xai/grok-4". Trying it anyway. Provider "xai" is not loaded.',
    )
  })

  it('model stays quiet about an unknown prefix without a cached catalog', async () => {
    const { context, notice, switchModel } = ctx()
    await modelCommand.run(['xai/grok-4'], context)

    expect(switchModel).toHaveBeenCalledWith('openai', 'xai/grok-4')
    expect(notice).toHaveBeenCalledTimes(1)
    expect(notice).toHaveBeenCalledWith('Switched to openai/other. Context window unknown.')
  })

  it('model warns when the catalog has no context window', async () => {
    const { context, notice } = ctx({ providerId: 'openai', modelId: 'gpt-6-astra' }, async () => ({
      providerId: 'openai',
      modelId: 'other',
      contextWindow: undefined,
    }))
    await modelCommand.run(['other'], context)

    expect(notice).toHaveBeenCalledWith('Switched to openai/other. Context window unknown.')
  })

  it('models lists the cached models of the loaded providers', () => {
    const { context, notice } = ctx(undefined, undefined, {
      knownModels: ['deepseek/deepseek-v4-flash', 'openai/gpt-6-astra'],
    })
    modelsCommand.run([], context)

    const [text] = notice.mock.calls[0] as [string]
    expect(text).toContain('Models (2):')
    expect(text).toContain('deepseek/deepseek-v4-flash')
    expect(text).toContain('openai/gpt-6-astra')
  })

  it('models filters by a substring and reports no match', () => {
    const { context, notice } = ctx(undefined, undefined, {
      knownModels: ['deepseek/deepseek-v4-flash', 'openai/gpt-6-astra'],
    })
    modelsCommand.run(['deepseek'], context)
    modelsCommand.run(['zzz'], context)

    const [first] = notice.mock.calls[0] as [string]
    expect(first).toContain('Models (1):')
    expect(first).toContain('deepseek/deepseek-v4-flash')
    expect(notice).toHaveBeenNthCalledWith(2, 'No models match "zzz".')
  })

  it('models lists the current provider first', () => {
    const { context, notice } = ctx(undefined, undefined, {
      knownModels: ['deepseek/a', 'openai/z', 'openai/b'],
    })
    modelsCommand.run([], context)

    const [text] = notice.mock.calls[0] as [string]
    expect(text.split('\n')).toEqual(['Models (3):', '  openai/b', '  openai/z', '  deepseek/a'])
  })

  it('models says so when the cache is empty', () => {
    const { context, notice } = ctx()
    modelsCommand.run([], context)

    expect(notice).toHaveBeenCalledWith(
      'No cached models. Send a prompt first so the catalog is fetched.',
    )
  })
})
