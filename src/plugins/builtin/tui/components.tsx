import { Box, Text } from 'ink'
import type { ReactElement } from 'react'

import type { MenuItem } from './menu.js'
import type { TranscriptLine } from './transcript.js'
import { WelcomeArt, WelcomeBox } from './welcome.js'

/** One finished transcript row. */
export function TranscriptRow({ line }: { line: TranscriptLine }): ReactElement {
  switch (line.kind) {
    case 'user':
      return (
        <Box>
          <Text bold color="cyan">
            {'> '}
          </Text>
          <Text>{line.text}</Text>
        </Box>
      )
    case 'assistant':
      return (
        <Box>
          <Text color="green">● </Text>
          <Text>{line.text}</Text>
        </Box>
      )
    case 'tool':
      return (
        <Box>
          <Text dimColor>{`  ⎿ ${line.text}`}</Text>
        </Box>
      )
    case 'error':
      return (
        <Box>
          <Text color="red">{`✖ ${line.text}`}</Text>
        </Box>
      )
    case 'system':
      return (
        <Box>
          <Text dimColor>{line.text}</Text>
        </Box>
      )
    case 'art':
      return <WelcomeArt text={line.text} />
    case 'welcome':
      return <WelcomeBox subtitle={line.text} />
  }
}

/** Selectable candidate list under the input box; the highlight wraps. */
export function CandidateMenu({
  items,
  selected,
}: {
  items: MenuItem[]
  selected: number
}): ReactElement {
  return (
    <Box paddingX={1} flexDirection="column">
      {items.map((item, index) =>
        index === selected ? (
          <Text key={item.label} bold color="cyan">
            {`❯ ${item.label}${item.hint.length > 0 ? ` — ${item.hint}` : ''}`}
          </Text>
        ) : (
          <Text key={item.label} dimColor>
            {`  ${item.label}${item.hint.length > 0 ? ` — ${item.hint}` : ''}`}
          </Text>
        ),
      )}
    </Box>
  )
}

/** Claude Code style input: rules above and below, prompt row, no box. */
export function InputBox({
  input,
  hasTyped,
  pending,
}: {
  input: string
  hasTyped: boolean
  pending: number
}): ReactElement {
  return (
    <Box
      borderStyle="single"
      borderTop
      borderBottom
      borderLeft={false}
      borderRight={false}
      borderDimColor
      paddingX={1}
    >
      <Text bold color={pending > 0 ? 'yellow' : '#d97757'}>
        {'> '}
      </Text>
      {input.length > 0 ? (
        <>
          <Text>{input}</Text>
          <Text dimColor>█</Text>
        </>
      ) : (
        <>
          <Text dimColor>█</Text>
          {!hasTyped && <Text dimColor>Try &quot;explain this project&quot;</Text>}
        </>
      )}
    </Box>
  )
}
