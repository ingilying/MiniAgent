# MiniAgent

A minimal Node.js + TypeScript 7 project using pnpm, ESM, ESLint, Prettier, and Vitest.

## Requirements

- [Node.js](https://nodejs.org) >= 20
- [pnpm](https://pnpm.io) (`corepack enable` or `npm i -g pnpm`)

## Setup

```sh
pnpm install
```

## Scripts

| Command             | Description                          |
| ------------------- | ------------------------------------ |
| `pnpm dev`          | Run `src/index.ts` with tsx (watch)  |
| `pnpm build`        | Compile to `dist/` (type check + JS) |
| `pnpm start`        | Run the built output                 |
| `pnpm test`         | Run tests once (Vitest)              |
| `pnpm test:watch`   | Run tests in watch mode              |
| `pnpm typecheck`    | Type check without emitting          |
| `pnpm lint`         | Lint with ESLint                     |
| `pnpm format`       | Format with Prettier                 |
| `pnpm format:check` | Check formatting without writing     |
| `pnpm check`        | typecheck + lint + test in one go    |

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

## Project layout

```
├── src/            # application source
│   ├── index.ts    # entry point
│   └── greet.ts    # example module
├── tests/          # Vitest test files
├── tsconfig.json   # editor + type checking config
└── tsconfig.build.json  # build (emit) config
```

Imports use ESM with explicit `.js` extensions (`import { greet } from './greet.js'`), which is required by `moduleResolution: NodeNext`.
