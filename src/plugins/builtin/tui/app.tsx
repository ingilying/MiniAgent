import { useEffect, useRef, useState } from 'react'
import { Box, Static, Text, useApp, useInput } from 'ink'
import type { ReactElement } from 'react'

import { join } from 'node:path'

import type { RunHost } from '../../types.js'
import type { Agent } from '../../../agent/agent.js'
import { parseCommand, type CommandContext, type ModelSwitch } from '../../../commands/commands.js'
import { listCachedModels } from '../../../models/catalog.js'
import { CandidateMenu, InputBox, TranscriptRow } from './components.js'
import { contextUsage } from './format.js'
import { useMenu } from './menu.js'
import {
  applyEvent,
  applyNotice,
  applyUser,
  initialTranscript,
  type TranscriptLine,
  type TranscriptState,
} from './transcript.js'
import { titleArt } from './welcome.js'

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

  const { menu, selected, selectedItem, setSelected } = useMenu(
    input,
    host.commands.list(),
    modelIds,
    host.context.providerId,
  )

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
    const ctx = buildCommandContext(host, agent, setAgent, notice, exit)
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
      {menu.length > 0 && <CandidateMenu items={menu} selected={selected} />}
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

/** Wires a slash command to this TUI: quit exits, notice prints, model switches agents. */
function buildCommandContext(
  host: RunHost,
  agent: Agent,
  setAgent: (agent: Agent) => void,
  notice: (text: string) => void,
  quit: () => void,
): CommandContext {
  return {
    commands: host.commands.list(),
    current: { providerId: host.context.providerId, modelId: host.context.modelId },
    quit,
    notice,
    switchModel: async (providerId: string, modelId: string): Promise<ModelSwitch> => {
      const { agent: switchedAgent, ...switched } = await host.switchModel(
        host.context,
        providerId,
        modelId,
      )
      setAgent(switchedAgent)
      return switched
    },
  }
}
