import { homedir } from 'node:os'
import { join } from 'node:path'

import { RELEASE } from '../build-info.js'

/** Data directory used when running from source (`src/`), e.g. under `tsx`. */
export const DEV_DATA_DIRECTORY = '.miniagent'

/**
 * Whether this build is a release. The value is stamped at build time
 * (`MINIAGENT_RELEASE=1`) into `src/build-info.ts` by scripts/build-info.mjs.
 */
export function isReleaseBuild(): boolean {
  return RELEASE
}

/**
 * Default directory holding the model cache and persisted sessions:
 * `$HOME/.config/miniagent` in a release build, `.miniagent` in the checkout.
 */
export function defaultDataDirectory(): string {
  return isReleaseBuild() ? join(homedir(), '.config', 'miniagent') : DEV_DATA_DIRECTORY
}
