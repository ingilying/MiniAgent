import type { Logger } from 'pino'

import { type AppConfig, loadConfig } from './config.js'

/**
 * Merges the `.env` file into `process.env`. Values already present win, and
 * a missing file is fine; any other read failure is reported so it does not
 * masquerade as a missing credential.
 */
export function mergeEnvFile(path: string | false, logger: Logger): void {
  if (path === false) {
    return
  }
  try {
    process.loadEnvFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.info(`could not read ${path}: ${String(error)}`)
    }
  }
}

/** Reads the config file. A missing one is fine; a broken one is reported and ignored. */
export async function readConfigFile(path: string | false, logger: Logger): Promise<AppConfig> {
  if (path === false) {
    return {}
  }
  try {
    return await loadConfig(path)
  } catch (error) {
    logger.warn(`could not read ${path}: ${String(error)}`)
    return {}
  }
}
