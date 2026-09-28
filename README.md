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

Then set your OpenAI credentials — either in the environment or in a `.env` file
(loaded automatically, see [src/index.ts](src/index.ts)):

```sh
OPENAI_API_KEY=sk-...
# optional, defaults to gpt-6-astra
OPENAI_MODEL=gpt-6-astra
# optional, name of the persisted REPL session, defaults to "default"
MINIAGENT_SESSION=default
# optional, overrides the context window read from the model catalog
MINIAGENT_CONTEXT_WINDOW=128000
```

## Usage

```sh
# interactive REPL (history is persisted and restored across restarts)
pnpm dev

# single-shot mode (ephemeral context)
pnpm dev "What is 17 * 23? Also, what time is it in Seoul right now?"
```

Both modes stream the agent's answer to the terminal, log tool calls, tool
results, and step boundaries, and print the token usage of the conversation:

```
Restored session "default": 6 messages, [tokens] 214 / 128,000 (0.2%).
```

The REPL keeps a `Context` with the full conversation history and saves it to
`.miniagent/contexts/<session>.json` after every turn, so a restart resumes the
conversation.

## The Agent class

`src/agent.ts` exports a small `Agent` class that wraps the AI SDK Core tool loop:

```ts
import { openai } from '@ai-sdk/openai'
import { Agent } from './agent.js'

const agent = new Agent({
  model: openai('gpt-6-astra'), // any AI SDK LanguageModel
  system: 'You are a helpful assistant.',
  tools: { calculator: calculatorTool }, // any AI SDK ToolSet
  maxSteps: 8, // tool-loop step limit
})

// Streaming: async generator of typed events
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
history, and an optional `AbortSignal`.

### Context (conversation history)

`src/context.ts` exports a `Context` class that stores the conversation
history. Pass it as the agent input: the current history is sent to the model
and the messages generated during the run — including tool calls and tool
results — are appended back into the context afterwards.

```ts
import { Context } from './context.js'

const context = new Context()
context.addUser('What is 6 * 7?')

for await (const event of agent.stream(context)) {
  if (event.type === 'text-delta') process.stdout.write(event.text)
}

// context.messages: user, assistant (tool call), tool result, assistant (answer)

// next turn sees the full history:
context.addUser('and in hex?')
for await (const event of agent.stream(context)) {
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

- `FileContextStore` writes one JSON file per context id (holding the messages
  and the last reported usage), atomically (temp file + rename), and sanitizes
  ids so they cannot escape the directory.
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
- The AI SDK does not ship model context-window sizes. The demo reads them from
  the [models.dev](https://models.dev) catalog ([src/model-info.ts](src/model-info.ts)),
  cached in `.miniagent/models.json` for an hour, and falls back to
  `MINIAGENT_CONTEXT_WINDOW` as an override. `remainingTokens` is only available
  when a window is known.

The count is stored together with the history, so a restored session knows its
size before the next run.

The AI SDK does not ship model context-window sizes, so the window is
configured by the caller (the demo reads `MINIAGENT_CONTEXT_WINDOW`).

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
│   ├── agent.ts           # Agent class (stream + run + tool loop)
│   ├── context.ts         # Context class (history, persistence, tokens)
│   ├── model-info.ts      # model limits from the models.dev catalog
│   ├── store.ts           # ContextStore interface + FileContextStore
│   ├── index.ts           # demo entry point (OpenAI provider, REPL)
│   └── tools/             # tool definitions
│       ├── calculator.ts
│       └── current-time.ts
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
