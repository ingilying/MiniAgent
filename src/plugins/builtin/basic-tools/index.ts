import { createBasicTools } from './tools.js'

import type { Plugin } from '../../types.js'

export { createBasicTools }

/** Basic tools plugin: read, write, edit files and run shell commands. */
export const basicToolsPlugin: Plugin = {
  name: 'basic-tools',
  setup: (host) => {
    host.addTools(createBasicTools(host.cwd))
  },
}
