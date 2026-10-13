import type { Plugin } from '../types.js'
import { setConsoleEnabled } from '../../logger.js'

/**
 * Claude Code style fullscreen TUI, built on Ink.
 *
 * Ink's alternate screen buffer hides the console log while the TUI runs
 * and restores it on exit (the vim/htop/less mechanism). Raw `stdout`
 * writes from the diagnostics logger would corrupt Ink frames — Ink only
 * intercepts `console.*` — so the console stream detaches while the TUI
 * owns the screen. The log file tee keeps every line either way.
 * Skipped without a TTY, where the run stays headless.
 */
export const tuiPlugin: Plugin = {
  name: 'tui',
  run: async (host) => {
    if (process.stdout.isTTY !== true) {
      return
    }
    setConsoleEnabled(false)
    try {
      const { render } = await import('ink')
      const React = await import('react')
      const { TuiApp } = await import('./app.js')
      const app = render(React.createElement(TuiApp, { host }), { alternateScreen: true })
      await app.waitUntilExit()
    } finally {
      setConsoleEnabled(true)
    }
  },
}
