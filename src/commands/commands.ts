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
  /** Ids of the loaded providers, sorted. A provider outside this set is unknown. */
  readonly providers: readonly string[]
  /** Provider-qualified model ids the cached catalog lists for the loaded providers. */
  readonly knownModels: readonly string[]
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

/** Caps one `/models` listing; a filter narrows it. */
const MAX_LISTED_MODELS = 40

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
    const target = parseModelTarget(raw, ctx.current.providerId, ctx.providers)
    if (target === undefined) {
      ctx.notice('Usage: /model [provider/]model')
      return
    }
    const id = `${target.providerId}/${target.modelId}`
    if (ctx.knownModels.length > 0 && !ctx.knownModels.includes(id)) {
      // The catalog is a cached snapshot, so a model it does not list may
      // still work. Warn about the likely typo, then let the provider decide.
      const hint =
        target.unknownPrefix === undefined
          ? ''
          : ` Provider "${target.unknownPrefix}" is not loaded.`
      ctx.notice(`Unknown model "${id}". Trying it anyway.${hint}`)
    }
    const switched = await ctx.switchModel(target.providerId, target.modelId)
    const window =
      switched.contextWindow === undefined
        ? ' Context window unknown.'
        : ` (${switched.contextWindow.toLocaleString('en-US')} token window)`
    ctx.notice(`Switched to ${switched.providerId}/${switched.modelId}.${window}`)
  },
}

/** Lists the models the cached catalog holds for the loaded providers. */
export const modelsCommand: Command = {
  name: 'models',
  description: 'List models of the loaded providers. Usage: /models [filter]',
  run(args, ctx): void {
    if (ctx.knownModels.length === 0) {
      ctx.notice('No cached models. Send a prompt first so the catalog is fetched.')
      return
    }
    const filter = args.join(' ').trim().toLowerCase()
    const matched =
      filter.length === 0
        ? ctx.knownModels
        : ctx.knownModels.filter((id) => id.toLowerCase().includes(filter))
    if (matched.length === 0) {
      ctx.notice(`No models match "${filter}".`)
      return
    }
    const ordered = [...matched].sort((a, b) => compareModelIds(a, b, ctx.current.providerId))
    const shown = ordered.slice(0, MAX_LISTED_MODELS)
    const lines = shown.map((id) => `  ${id}`)
    if (ordered.length > shown.length) {
      lines.push(`  … ${ordered.length - shown.length} more. Narrow with /models <filter>.`)
    }
    ctx.notice([`Models (${ordered.length}):`, ...lines].join('\n'))
  },
}

/** Current provider first, then alphabetical: the order the model menu uses. */
function compareModelIds(a: string, b: string, currentProvider: string): number {
  const aOurs = a.startsWith(`${currentProvider}/`) ? 0 : 1
  const bOurs = b.startsWith(`${currentProvider}/`) ? 0 : 1
  return aOurs - bOurs || a.localeCompare(b)
}

/**
 * Resolves the `/model` argument to a provider and model. A `provider/model`
 * prefix counts as a provider only when it is one of the loaded provider ids,
 * so a bare model id that contains a slash (e.g. `meta-llama/llama-4-...`)
 * stays on the current provider. `unknownPrefix` holds such a prefix, so the
 * caller can hint at a mistyped provider name. Returns `undefined` for an
 * empty provider or model part, which the caller reports as a usage error.
 */
function parseModelTarget(
  raw: string,
  currentProvider: string,
  loadedProviders: readonly string[],
): { providerId: string; modelId: string; unknownPrefix?: string } | undefined {
  const slash = raw.indexOf('/')
  if (slash === -1) {
    return { providerId: currentProvider, modelId: raw }
  }
  const prefix = raw.slice(0, slash)
  const rest = raw.slice(slash + 1)
  if (prefix.length === 0 || rest.length === 0) {
    return undefined
  }
  return loadedProviders.includes(prefix)
    ? { providerId: prefix, modelId: rest }
    : { providerId: currentProvider, modelId: raw, unknownPrefix: prefix }
}
