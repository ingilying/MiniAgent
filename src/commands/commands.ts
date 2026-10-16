/**
 * Slash commands owned by the core layer, not by plugins.
 *
 * The `App` builds one `CommandRegistry`, registers the built-ins, and
 * exposes it on the plugin hosts as a read-only `CommandProvider`.
 * Frontends (TUI, WebUI) route `/name args` input through it; they never
 * define commands themselves.
 */

/** What a command can do: quit the frontend or print into the transcript. */
export interface CommandContext {
  /** Built-in and registered commands, for `help`. */
  readonly commands: readonly CommandInfo[]
  /** Session the command acts on. */
  readonly current: SessionIdentity
  /** Leaves the frontend. Wired by the caller (Ink `exit()`, ...). */
  quit(): void
  /** Shows one output row in the frontend. */
  notice(text: string): void
  /** Switches the session to another provider/model. Wired by `App`. */
  switchModel(providerId: string, modelId: string): Promise<ModelSwitch>
}

/** Static face of a command, for listing and completion. */
export interface CommandInfo {
  readonly name: string
  readonly aliases: readonly string[]
  readonly description: string
}

/** Session identity a command acts on. */
export interface SessionIdentity {
  readonly providerId: string
  readonly modelId: string | undefined
}

/** Outcome of a model switch, for the announcing notice. */
export interface ModelSwitch {
  readonly providerId: string
  readonly modelId: string
  readonly contextWindow: number | undefined
}

/** A slash command: `/name arg1 arg2`. */
export interface Command {
  readonly name: string
  readonly description: string
  readonly aliases?: readonly string[]
  run(args: string[], ctx: CommandContext): void | Promise<void>
}

/** Read-only view of the registry, the only face plugins see. */
export interface CommandProvider {
  find(name: string): Command | undefined
  list(): CommandInfo[]
}

/** Splits `/name arg1 arg2` into its name (lowercased) and args. */
export function parseCommand(input: string): { name: string; args: string[] } | undefined {
  if (!input.startsWith('/')) {
    return undefined
  }
  const [name, ...args] = input
    .slice(1)
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0)
  if (name === undefined) {
    return undefined
  }
  return { name: name.toLowerCase(), args }
}

/** Core-owned command table. Registration happens in `App`, never in plugins. */
export class CommandRegistry implements CommandProvider {
  private readonly commands: Command[] = []

  /** Registers a command. Throws on a duplicate name or alias. */
  register(command: Command): void {
    const taken = (name: string): Command | undefined => this.find(name)
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      const clash = taken(name.toLowerCase())
      if (clash !== undefined) {
        throw new Error(`Duplicate command "${name}" (already registered by "${clash.name}").`)
      }
    }
    this.commands.push(command)
  }

  registerAll(commands: Command[]): void {
    for (const command of commands) {
      this.register(command)
    }
  }

  /** Looks up a command by name or alias, case-insensitively. */
  find(name: string): Command | undefined {
    const lower = name.toLowerCase()
    return this.commands.find(
      (command) =>
        command.name.toLowerCase() === lower ||
        (command.aliases ?? []).some((alias) => alias.toLowerCase() === lower),
    )
  }

  /** Static faces of every command, in registration order. */
  list(): CommandInfo[] {
    return this.commands.map((command) => ({
      name: command.name,
      aliases: [...(command.aliases ?? [])],
      description: command.description,
    }))
  }
}

/** Leaves the frontend. */
export const quitCommand: Command = {
  name: 'quit',
  description: 'Exit MiniAgent.',
  aliases: ['exit', 'q'],
  run(_args, ctx): void {
    ctx.quit()
  },
}

/** Lists every command with its description. */
export const helpCommand: Command = {
  name: 'help',
  description: 'List available commands.',
  aliases: ['h', '?'],
  run(_args, ctx): void {
    const lines = ctx.commands.map((command) => `/${command.name} — ${command.description}`)
    ctx.notice(['Available commands:', ...lines].join('\n'))
  },
}

/** Shows or switches the session model. */
export const modelCommand: Command = {
  name: 'model',
  description: 'Show or switch the session model. Usage: /model [provider/]model',
  async run(args, ctx): Promise<void> {
    if (args.length === 0) {
      ctx.notice(`Model: ${ctx.current.providerId}/${ctx.current.modelId ?? '?'}`)
      return
    }
    const [raw] = args
    if (args.length > 1 || raw === undefined || raw.length === 0) {
      ctx.notice('Usage: /model [provider/]model')
      return
    }
    const slash = raw.indexOf('/')
    const provider = slash === -1 ? ctx.current.providerId : raw.slice(0, slash)
    const model = slash === -1 ? raw : raw.slice(slash + 1)
    if (provider.length === 0 || model.length === 0) {
      ctx.notice('Usage: /model [provider/]model')
      return
    }
    const switched = await ctx.switchModel(provider, model)
    const window =
      switched.contextWindow === undefined
        ? ''
        : ` (${switched.contextWindow.toLocaleString('en-US')} token window)`
    ctx.notice(`Switched to ${switched.providerId}/${switched.modelId}.${window}`)
  },
}
