import { useEffect, useRef, useState } from 'react'
import { Box, Static, Text, useApp, useInput } from 'ink'
import type { ReactElement } from 'react'

import { join } from 'node:path'

import type { RunHost } from '../types.js'
import { parseCommand } from '../../commands.js'
import { listCachedModels } from '../../model-info.js'
import {
  applyEvent,
  applyNotice,
  applyUser,
  commandMenu,
  contextUsage,
  initialTranscript,
  modelMenu,
  type MenuItem,
  type TranscriptLine,
  type TranscriptState,
} from './driver.js'
import { WelcomeArt, WelcomeBox, titleArt } from './welcome.js'

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
  const [agent, setAgent] = useState(host.agent)
  const [modelIds, setModelIds] = useState<string[]>([])
  const [selected, setSelected] = useState(0)

  /** Cached catalog ids for model completion; file cache only, no network. */
  useEffect(() => {
    let live = true
    void listCachedModels(join(host.dataDirectory, 'models.json')).then((ids) => {
      if (live) {
        setModelIds(ids)
      }
    })
    return () => {
      live = false
    }
  }, [host.dataDirectory])

  /**
   * Open menu: command names for a slash prefix, model ids for
   * `/model <partial>`. Empty everywhere else.
   */
  const commandPartial = /^\/(\S*)$/.exec(input)?.[1]
  const modelPartial = /^\/model\s+(\S*)$/.exec(input)?.[1]
  const menu: MenuItem[] =
    commandPartial !== undefined
      ? commandMenu(host.commands.list(), commandPartial)
      : modelPartial !== undefined
        ? modelMenu(modelIds, host.context.providerId, modelPartial)
        : []

  /** Restart the highlight whenever the menu contents change. */
  const menuKey = `${commandPartial ?? ''}|${modelPartial ?? ''}|${menu.map((item) => item.label).join(',')}`
  const lastMenuKey = useRef(menuKey)
  if (lastMenuKey.current !== menuKey) {
    lastMenuKey.current = menuKey
    setSelected(0)
  }
  const selectedItem = menu.length === 0 ? undefined : menu[selected % menu.length]

  useEffect(
    () =>
      agent.subscribe((event) => {
        setTranscript((previous) => applyEvent(previous, event, makeId))
        if (event.type === 'finish' || event.type === 'error') {
          setPending((count) => Math.max(0, count - 1))
        }
      }),
    [agent],
  )

  const submit = (text: string): void => {
    setTranscript((previous) => applyUser(previous, makeId(), text))
    setPending((count) => count + 1)
    agent.submit(text)
  }

  const notice = (text: string): void => {
    setTranscript((previous) => applyNotice(previous, makeId(), text))
  }

  const runCommand = (text: string): void => {
    setTranscript((previous) => applyUser(previous, makeId(), text))
    const parsed = parseCommand(text)
    const command = parsed === undefined ? undefined : host.commands.find(parsed.name)
    if (parsed === undefined || command === undefined) {
      notice(`Unknown command "${text}". /help lists commands.`)
      return
    }
    const ctx = {
      commands: host.commands.list(),
      current: { providerId: host.context.providerId, modelId: host.context.modelId },
      quit: (): void => exit(),
      notice,
      switchModel: async (
        providerId: string,
        modelId: string,
      ): Promise<{ providerId: string; modelId: string; contextWindow: number | undefined }> => {
        const switched = await host.switchModel(host.context, providerId, modelId)
        setAgent(switched.agent)
        return {
          providerId: switched.providerId,
          modelId: switched.modelId,
          contextWindow: switched.contextWindow,
        }
      },
    }
    void Promise.resolve(command.run(parsed.args, ctx)).catch((error: unknown) =>
      notice(error instanceof Error ? error.message : String(error)),
    )
  }

  useInput((chars, key) => {
    if ((key.upArrow || key.downArrow) && menu.length > 0) {
      const step = key.downArrow ? 1 : menu.length - 1
      setSelected((index) => (index + step) % menu.length)
      return
    }
    if (key.tab && selectedItem !== undefined) {
      setInput(selectedItem.fill)
      return
    }
    if (key.return) {
      const text = input.trim()
      if (text.length === 0) {
        return
      }
      // Menu open: Enter selects the highlight into the input box.
      // Menu closed: Enter sends.
      if (selectedItem !== undefined) {
        setInput(selectedItem.fill)
        return
      }
      setInput('')
      if (text.startsWith('/')) {
        runCommand(text)
        return
      }
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
    if (key.ctrl || key.meta) {
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
      {menu.length > 0 && <CandidateMenu items={menu} selected={selected % menu.length} />}
      <Box paddingX={1} justifyContent="space-between">
        <Text dimColor>
          {contextUsage(host.context)}
          {pending > 0 ? ` · working (${pending})…` : ''}
        </Text>
        <Text dimColor>{host.context.modelId ?? '?'}</Text>
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
function CandidateMenu({ items, selected }: { items: MenuItem[]; selected: number }): ReactElement {
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
