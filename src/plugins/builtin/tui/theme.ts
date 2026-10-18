/**
 * Colour and glyph vocabulary of the TUI. One place, so a marker means the
 * same thing in every row: the accent marks what the user drives, cyan what
 * the agent does on its own, and dim what is context rather than content.
 */
export const theme = {
  /** Prompt marker, banner border, selected menu row. */
  accent: '#d97757',
  /** The agent's own voice: answers and tool blocks. */
  agent: 'cyan',
  /** Text the agent produced as an answer. */
  answer: 'green',
  /** Failed runs and failed tool calls, and removed diff lines. */
  error: 'red',
  /** Added diff lines and successful edit markers. */
  added: 'green',
  /** Inline code and fenced code in answers. */
  code: 'yellow',
} as const

/** Glyphs the rows share. */
export const glyph = {
  /** User prompt. */
  prompt: '>',
  /** Assistant answer. */
  answer: '●',
  /** Reasoning block header. */
  reasoning: '✻',
  /** Tool call, finished. */
  tool: '⏺',
  /** Tool call, still running. */
  toolPending: '◌',
  /** Tool result, hanging under its call. */
  result: '⎿',
  /** A failed run. */
  error: '✖',
  /** Cursor after live answer text. */
  cursor: '▍',
} as const
