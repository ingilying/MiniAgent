import type { Plugin } from '../../types.js'

/**
 * Claude Code style fullscreen TUI, built on Ink.
 *
 * Ink's alternate screen buffer hides the console log while the TUI runs
 * and restores it on exit (the vim/htop/less mechanism). The diagnostics
 * logger is already file-only on a TTY (see `defaultLogger`), so raw
 * `stdout` writes never corrupt Ink frames — Ink only intercepts
 * `console.*`. Skipped without a TTY, where the run stays headless.
 */
export const tuiPlugin: Plugin = {
  name: 'tui',
  run: async (host) => {
    if (process.stdout.isTTY !== true) {
      return
    }
    const { render } = await import('ink')
    const React = await import('react')
    const { TuiApp } = await import('./app.js')
    const app = render(React.createElement(TuiApp, { host }), { alternateScreen: true })
    await app.waitUntilExit()
  },
}
