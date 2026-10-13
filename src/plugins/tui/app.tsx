import { useEffect, useRef, useState } from 'react'
import { Box, Static, Text, useApp, useInput } from 'ink'
import type { ReactElement } from 'react'

import type { RunHost } from '../types.js'
import {
  applyEvent,
  applyUser,
  contextUsage,
  initialTranscript,
  type TranscriptLine,
  type TranscriptState,
} from './driver.js'
import { WelcomeArt, WelcomeBox, titleArt } from './welcome.js'

/** Commands that leave the TUI. */
const QUIT_COMMANDS = new Set(['/quit', '/exit', ':q'])

/**
 * Claude Code style fullscreen chat: finished turns in `<Static>`, the
 * streaming answer in a live box below, one-line input at the bottom.
 * Turns submit through the shared agent queue, so typing while busy
 * lines the next turn up instead of blocking.
 */
export function TuiApp({ host }: { host: RunHost }): ReactElement {
  const { exit } = useApp()
  const nextId = useRef(0)
  const makeId = (): string => `line-${(nextId.current += 1)}`
  const [transcript, setTranscript] = useState<TranscriptState>(() =>
    initialTranscript(
      makeId,
      titleArt('MINIAGENT').join('\n'),
      `${host.providerId ?? '?'}/${host.modelId ?? '?'} · ${host.cwd}`,
    ),
  )
  const [input, setInput] = useState('')
  const [hasTyped, setHasTyped] = useState(false)
  const [pending, setPending] = useState(0)

  useEffect(
    () =>
      host.agent.subscribe((event) => {
        setTranscript((previous) => applyEvent(previous, event, makeId))
        if (event.type === 'finish' || event.type === 'error') {
          setPending((count) => Math.max(0, count - 1))
        }
      }),
    [host.agent],
  )

  const submit = (text: string): void => {
    setTranscript((previous) => applyUser(previous, makeId(), text))
    setPending((count) => count + 1)
    host.agent.submit(text)
  }

  useEffect(() => {
    if (host.prompt !== undefined && host.prompt.length > 0) {
      submit(host.prompt)
    }
    // Once: the boot prompt sends as the first turn.
  }, [])

  useInput((chars, key) => {
    if (key.return) {
      const text = input.trim()
      if (text.length === 0) {
        return
      }
      if (QUIT_COMMANDS.has(text)) {
        exit()
        return
      }
      setInput('')
      submit(text)
      return
    }
    if (key.backspace || key.delete) {
      setInput((previous) => previous.slice(0, -1))
      return
    }
    if (key.escape) {
      setInput('')
      return
    }
    if (key.ctrl && chars === 'u') {
      setInput('')
      return
    }
    if (key.ctrl || key.meta || key.tab) {
      return
    }
    if (chars.length > 0) {
      setHasTyped(true)
      setInput((previous) => previous + chars)
    }
  })

  return (
    <Box flexDirection="column">
      <Static items={[...transcript.lines]}>
        {(line: TranscriptLine) => <TranscriptRow key={line.id} line={line} />}
      </Static>
      {transcript.liveText.length > 0 && (
        <Box>
          <Text color="green">● </Text>
          <Text>{transcript.liveText}</Text>
        </Box>
      )}
      <InputBox input={input} hasTyped={hasTyped} pending={pending} />
      <Box paddingX={1}>
        <Text dimColor>
          {contextUsage(host.context)}
          {pending > 0 ? ` · working (${pending})…` : ''}
        </Text>
      </Box>
    </Box>
  )
}

/** One finished transcript row. */
function TranscriptRow({ line }: { line: TranscriptLine }): ReactElement {
  switch (line.kind) {
    case 'user':
      return (
        <Box>
          <Text bold color="cyan">
            {'› '}
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
    case 'art':
      return <WelcomeArt text={line.text} />
    case 'welcome':
      return <WelcomeBox subtitle={line.text} />
  }
}

/** Claude Code style input: rules above and below, prompt row, no box. */
function InputBox({
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
        {'› '}
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
