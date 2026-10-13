import { editTool } from './edit.js'
import { readTool } from './read.js'
import { shellTool } from './shell.js'
import { writeTool } from './write.js'

import type { Plugin } from '../types.js'

/** Basic tools plugin: read, write, edit files and run shell commands. */
export const basicToolsPlugin: Plugin = {
  name: 'basic-tools',
  setup: (host) => {
    host.tools.read = readTool
    host.tools.write = writeTool
    host.tools.edit = editTool
    host.tools.shell = shellTool
  },
}
