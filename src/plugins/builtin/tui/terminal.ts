import { useStdout } from 'ink'

/** Fallback used when the stream does not report a width (pipes, tests). */
const FALLBACK_COLUMNS = 80

/** Title used when a session has none yet. */
export const DEFAULT_TERMINAL_TITLE = 'MiniAgent'

/**
 * OSC 0 sequence that names the terminal window or tab. Control characters
 * are stripped, so a title cannot inject escape sequences of its own.
 */
export function terminalTitleSequence(title: string): string {
  const clean = title
    // eslint-disable-next-line no-control-regex -- the point is to strip them
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return `\x1b]0;${clean.length > 0 ? clean : DEFAULT_TERMINAL_TITLE}\x07`
}

/** Writes the terminal title through Ink's writer, so frames stay intact. */
export function useTerminalTitle(): (title: string) => void {
  const { write } = useStdout()
  return (title: string): void => {
    write(terminalTitleSequence(title))
  }
}

/** Columns this frame has to work with. */
export function useColumns(): number {
  const { stdout } = useStdout()
  // Ink types stdout as a bare WritableStream; a terminal carries columns.
  const columns = (stdout as { columns?: number }).columns ?? FALLBACK_COLUMNS
  return Math.max(20, columns)
}
