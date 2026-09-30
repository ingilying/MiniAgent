# MiniAgent

A minimal agent built with Node.js, TypeScript 7, and the [AI SDK](https://ai-sdk.dev) —
using plain SDK primitives (`streamText` / `generateText` + tools + a step loop)
rather than the SDK's own `ToolLoopAgent` abstraction.

## Requirements

- [Node.js](https://nodejs.org) >= 20
- [pnpm](https://pnpm.io) (`corepack enable` or `npm i -g pnpm`)

## Setup

```sh
pnpm install
```

Then set your credentials. `App.run()` reads `config.json` from the data
directory (`$HOME/.config/miniagent/config.json` in a release build,
`.miniagent/config.json` in the checkout) and always merges `.env` from the
current directory into the environment (see [src/app.ts](src/app.ts)); variables
already set in the environment win, and a missing file is not an error.

```jsonc
// <dataDirectory>/config.json — every field is optional
{
  "provider": "openai",
  "model": "gpt-6-astra",
  "apiKeys": { "openai": "sk-..." },
}
```

```sh
# equivalent environment fallbacks
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-6-astra
# optional, session name used when MINIAGENT_SESSION is unset, defaults to "default"
MINIAGENT_SESSION=default
# optional, overrides the context window read from the model catalog
MINIAGENT_CONTEXT_WINDOW=128000
```

For a fresh session the config file wins over the environment: provider =
`config.provider` else `openai`; model = `config.model` else `OPENAI_MODEL` else
`gpt-6-astra`; API key = `config.apiKeys[provider]` else the provider's env var
(`OPENAI_API_KEY`). A stored session keeps the provider and model it was created
with, whatever the config file now says.

## Usage

```sh
pnpm dev
```

`App.run()` only loads the configuration and builds the agent: it merges `.env`,
reads `config.json`, restores the session's `Context` (which keeps its stored
provider and model), lets it resolve its context window from the
[models.dev](https://models.dev) catalog, and constructs the `Agent` through the
provider registry. The resolved values are then exposed for whatever drives the
conversation:

```ts
const app = new App()
const code = await app.run()

app.prompt // first positional argument, if any
app.session // MINIAGENT_SESSION, or the default session name
app.providerId // provider id the session runs on
app.modelId // model id the session runs on
app.context // the session's Context, window resolved
app.agent // the built Agent (or the injected one), bound to app.context
app.dataDirectory // .miniagent, or $HOME/.config/miniagent in a release build
app.version // version stamped into this build
```

Providers live in [src/providers.ts](src/providers.ts): a table keyed by
provider id, each entry holding the env var for its key and a factory.
`openai`, `anthropic`, and `google` are built in; any other id with a
`baseUrl` becomes an OpenAI-compatible provider. Adding another built-in is
one entry.

It prints the `[model] ...` context-window diagnostics as it resolves them, and
returns exit code `1` when the provider is unknown or its key is missing. The
model cache, the config file, and any persisted sessions live in
`app.dataDirectory`: `.miniagent` in a development build,
`$HOME/.config/miniagent` in a release build. Talking to the user (REPL,
web server, ...) is a layer on top of `app.agent`, not part of `App`.

### Development vs release builds

TypeScript has no build-time `define`, so the release sign is passed as an
environment variable to a small generator that writes it into a source file
before `tsc` runs:

```sh
MINIAGENT_RELEASE=1 pnpm build   # release build
pnpm build                       # development build
```

`scripts/build-info.mjs` writes `src/build-info.ts` (gitignored) holding
`RELEASE` and the `VERSION` from `package.json`; `src/app.ts` imports them and
picks the data directory from `RELEASE`. `build`, `dev`, `typecheck`, and `test`
all run the generator first, and `postinstall` covers a fresh clone.

## The Agent class

`src/agent.ts` exports a small `Agent` class that wraps the AI SDK Core tool loop:

```ts
import { openai } from '@ai-sdk/openai'
import { Agent } from './agent.js'

const agent = new Agent({
  model: openai('gpt-6-astra'), // any AI SDK LanguageModel
  system: 'You are a helpful assistant.',
  tools: { calculator: calculatorTool }, // any AI SDK ToolSet
  context, // optional member conversation (see below)
  maxSteps: 8, // tool-loop step limit
})

// With a member context, call it with no input to continue that conversation:
for await (const event of agent.stream()) {
  /* ... */
}

// Or pass input explicitly; a string is added to the member context:
for await (const event of agent.stream('What is 6 * 7?')) {
  if (event.type === 'text-delta') process.stdout.write(event.text)
  if (event.type === 'tool-result') console.log(event.output)
}

// Non-streaming: full result incl. steps, tool calls, usage, responseMessages
const result = await agent.run('What is 6 * 7?')
```

`stream()` event types:

| Event             | Emitted when                                   |
| ----------------- | ---------------------------------------------- |
| `start`           | the run starts                                 |
| `step-start`      | a step (model call) begins                     |
| `text-delta`      | a chunk of answer text arrives                 |
| `reasoning-delta` | a chunk of model reasoning arrives             |
| `tool-call`       | the model requests a tool call                 |
| `tool-result`     | a tool finished and returned its output        |
| `step-finish`     | a step finished (with finish reason and usage) |
| `finish`          | the whole run finished (with total usage)      |
| `error`           | something failed; the run stays alive          |

`run()` returns `text`, `finishReason`, `usage`, `steps`, `toolCalls`,
`toolResults`, and `responseMessages` (append the latter to your message
history to continue a conversation across runs).

Both methods accept either a plain prompt string or a `ModelMessage[]`
history, and an optional `AbortSignal`. On an `Agent` built with a `context`
member, calling them with no input continues that conversation, and a string
input is added to it as a user message.

### Context (conversation history)

`src/context.ts` exports a `Context` class that stores the conversation
history. Pass it as the agent input, or hand it to the `Agent` as its `context`
member: the current history is sent to the model and the messages generated
during the run — including tool calls and tool results — are appended back into
the context afterwards.

```ts
import { Context } from './context.js'

const context = new Context()
context.addUser('What is 6 * 7?')

const agent = new Agent({ model, context })

// no input: the member context is the conversation
for await (const event of agent.stream()) {
  if (event.type === 'text-delta') process.stdout.write(event.text)
}

// context.messages: user, assistant (tool call), tool result, assistant (answer)

// next turn sees the full history:
context.addUser('and in hex?')
for await (const event of agent.stream()) {
  /* ... */
}
```

The `Context` API: `add(message)`, `addUser(text)`, `addAssistant(text)`,
`append(messages)`, `clear()`, `clone()`, plus `messages` (defensive snapshot)
and `messageCount`. Failed runs do not corrupt the history — nothing is
appended when the run errors.

### Persistence

A `Context` can be bound to a `ContextStore` and an id. The agent then
auto-saves the history after every run, and `Context.load()` restores it:

```ts
import { Context } from './context.js'
import { FileContextStore } from './store.js'

const store = new FileContextStore('.miniagent/contexts')

// empty if nothing stored for this id yet
const context = await Context.load(store, 'user-123')

// or let the context generate its own id
const fresh = new Context([], { store })
console.log(fresh.id) // generated UUID

context.addUser('What is 6 * 7?')
for await (const event of agent.stream(context)) {
  /* ... */
}
// → auto-saved to .miniagent/contexts/user-123.json

// later, in another process:
const resumed = await Context.load(store, 'user-123')
console.log(resumed.messageCount) // history is back
```

- `FileContextStore` writes one JSON file per context id (holding the messages,
  the last reported usage, and the provider and model the session runs on),
  atomically (temp file + rename), and sanitizes ids so they cannot escape the
  directory.
- `Context.load()` prefers the stored provider and model; it only falls back to
  the passed options for a fresh or legacy file. That is how a restored session
  keeps working after the config file changes.
- Auto-save is on by default when a store is bound; disable it per context
  with `new Context([], { store, id, autoSave: false })` and call
  `await context.save()` yourself.
- `save()` throws if the context is not bound to a store; `delete(id)` removes
  a stored history. Omit `id` and the context generates one.
- Any backend works — implement the `ContextStore` interface
  (`load` / `save` / `delete`) for a database, Redis, object storage, ...

### Token counting

Token counts come from the provider — there is no local tokenizer. After every
run the agent records the usage the model reported for its last step, and the
context reports it:

```ts
const context = new Context([], { contextWindow: 128_000 })

context.tokenCount // input + output tokens of the last response
context.usage // { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
context.remainingTokens // contextWindow - tokenCount
```

Things worth knowing:

- `tokenCount` is `0` until the first response has been recorded.
- It counts what was sent, so a message you just added is not part of the
  number until the next run.
- `inputTokens` already includes tokens served from the provider's prompt
  cache, so `cacheReadTokens` / `cacheWriteTokens` are reported alongside it
  and not added to `tokenCount` again.
- Providers that do not report usage leave the count at `0`.
- The AI SDK does not ship model context-window sizes. `Context.initRemote()`
  reads them from the [models.dev](https://models.dev) catalog
  ([src/model-info.ts](src/model-info.ts)), caches them in
  `<dataDirectory>/models.json` for an hour, and honours
  `MINIAGENT_CONTEXT_WINDOW` as an override. The method is optional and never
  throws; without a window, `remainingTokens` stays `undefined` and the context
  still works.

```ts
const context = new Context([], { modelId: 'gpt-6-astra' })
await context.initRemote() // fills in context.contextWindow
```

The count is stored together with the history, so a restored session knows its
size before the next run.

### Tools

Tools live in `src/tools/` and are plain AI SDK `tool()` definitions with zod
`inputSchema`s:

- `calculator` — safely evaluates arithmetic expressions (no `eval`), via a
  small recursive-descent parser
- `getCurrentTime` — current date/time for an optional IANA time zone

Add a tool by creating a `tool({ description, inputSchema, execute })` and
adding it to the agent's `tools` object. Tool errors (thrown in `execute`)
are surfaced to the model as `tool-error` parts so it can react to them.

### Tests

Tests run against `MockLanguageModelV4` from `ai/test`, so no API key or
network access is needed:

```sh
pnpm test
```

## Scripts

| Command             | Description                          |
| ------------------- | ------------------------------------ |
| `pnpm dev`          | Run the demo agent with tsx (watch)  |
| `pnpm build`        | Compile to `dist/` (type check + JS) |
| `pnpm start`        | Run the built output                 |
| `pnpm build-info`   | Regenerate `src/build-info.ts`       |
| `pnpm test`         | Run tests once (Vitest)              |
| `pnpm test:watch`   | Run tests in watch mode              |
| `pnpm typecheck`    | Type check without emitting          |
| `pnpm lint`         | Lint with ESLint                     |
| `pnpm format`       | Format with Prettier                 |
| `pnpm format:check` | Check formatting without writing     |
| `pnpm check`        | typecheck + lint + test in one go    |

## Project layout

```
├── src/
│   ├── app.ts             # config load + agent construction
│   ├── agent.ts           # Agent class (stream + run + tool loop)
│   ├── build-info.ts      # generated release sign + version (gitignored)
│   ├── config.ts          # config.json (provider, model, api keys)
│   ├── context.ts         # Context class (history, persistence, tokens)
│   ├── model-info.ts      # model limits from the models.dev catalog
│   ├── providers.ts       # provider table (openai, anthropic, google, compatible)
│   ├── store.ts           # ContextStore interface + FileContextStore
│   ├── index.ts           # entry point (boots the app)
│   └── tools/             # tool definitions
│       ├── calculator.ts
│       └── current-time.ts
├── scripts/
│   └── build-info.mjs     # writes src/build-info.ts from the environment
├── tests/                 # Vitest tests (mock language model, no network)
├── tsconfig.json          # editor + type checking config
└── tsconfig.build.json    # build (emit) config
```

Imports use ESM with explicit `.js` extensions (`import { Agent } from './agent.js'`),
which is required by `moduleResolution: NodeNext`.

## TypeScript 7 (native compiler)

This project uses the native TypeScript 7 compiler for `tsc` (build/typecheck).
Because TS 7 does not yet expose a programmatic API (planned for 7.1), tools that
need the old compiler API — notably typescript-eslint — still rely on TypeScript 6.
This is handled with npm aliases, per the
[official recommendation](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0):

| devDependency        | Aliased to                    | Purpose                                    |
| -------------------- | ----------------------------- | ------------------------------------------ |
| `@typescript/native` | `npm:typescript@^7`           | Native TS 7; provides the `tsc` binary     |
| `typescript`         | `npm:@typescript/typescript6` | TS 6 API for typescript-eslint; `tsc6` bin |

Notes:

- `tsc` runs TypeScript 7 (the ~10x faster native port).
- `tsc6` is available if a tool ever needs the TS 6 CLI directly.
- Once typescript-eslint supports the TS 7.1+ API, you can drop the `typescript`
  alias and use `typescript@^7` as a regular dependency.
