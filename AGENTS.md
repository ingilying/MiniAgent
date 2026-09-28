# AGENTS.md

Rules for agents that work on this project.

## Hard rules

1. **Do not commit.** Wait until I say you can. Never commit on your own.
2. **Read the official docs first.** If you are not sure how an SDK works, search
   the web for the vendor's own docs and read them. Do not guess an API.
3. **Keep it simple.** Small classes that do one job. No big frameworks.

## Tech

- **TypeScript 7** (the fast native compiler). Use it to check types and build.
- **AI SDK** for model calls.
- Build the agent from plain AI SDK parts: `streamText` / `generateText`, `tools`,
  and a step limit. **Do not** use the SDK's own agent class or agent arrangements.
- pnpm, ESM, ESLint + Prettier, Vitest for tests.

## Before you say you are done

Run `pnpm check` (types, lint, tests). Do not leave it red. Do not commit.
