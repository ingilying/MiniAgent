import { Box, Text } from 'ink'
import type { ReactElement } from 'react'

import { theme } from './theme.js'

/** 5x5 block glyphs for the title art. Unknown chars render blank. */
const GLYPHS: Record<string, readonly string[]> = {
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  G: [' ████', '█    ', '█  ██', '█   █', ' ████'],
  I: ['█████', '  █  ', '  █  ', '  █  ', '█████'],
  M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
  N: ['█   █', '██  █', '█ █ █', '█  ██', '█   █'],
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
}

const BLANK = '     '
const ROWS = 5

/** Renders a title in block letters, one string per row. */
export function titleArt(title: string): string[] {
  const rows: string[] = Array.from({ length: ROWS }, () => '')
  for (const char of title.toUpperCase()) {
    const glyph = GLYPHS[char] ?? BLANK
    for (let row = 0; row < ROWS; row += 1) {
      const piece = typeof glyph === 'string' ? glyph : (glyph[row] ?? BLANK)
      rows[row] = rows[row] === '' ? piece : `${rows[row] as string} ${piece}`
    }
  }
  return rows
}

/** Big title art, pinned as the first transcript row. */
export function WelcomeArt({ text }: { text: string }): ReactElement {
  return <Text color={theme.accent}>{text}</Text>
}

/** Welcome box, pinned as the second transcript row. */
export function WelcomeBox({ subtitle }: { subtitle: string }): ReactElement {
  return (
    <Box
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      flexDirection="column"
      marginTop={1}
    >
      <Text>✻ Welcome to MiniAgent!</Text>
      <Text dimColor>{subtitle}</Text>
      <Text dimColor>Type a message and press Enter to send. /quit to exit.</Text>
    </Box>
  )
}
