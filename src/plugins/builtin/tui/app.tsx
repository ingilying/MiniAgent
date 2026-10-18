import { useEffect, useRef, useState } from 'react'
import { Box, Static, Text, useApp, useInput } from 'ink'
import type { ReactElement } from 'react'

import { join } from 'node:path'

import type { RunHost } from '../../types.js'
import type { Agent } from '../../../agent/agent.js'
import { parseCommand, type CommandContext, type ModelSwitch } from '../../../commands/commands.js'
import { listCachedModels } from '../../../models/catalog.js'
import { titleFromMessage } from '../../../session/title.js'
import {
  CandidateMenu,
  InputBox,
  LiveAnswer,
  LiveReasoning,
  LiveToolCall,
  TranscriptRow,
} from './components.js'
import { contextUsage } from './format.js'
import { DEFAULT_TERMINAL_TITLE, useTerminalTitle } from './terminal.js'
import { useMenu } from './menu.js'
import {
  appendHistory,
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
  const [context, setContext] = useState(host.context)
  const [sessionId, setSessionId] = useState(host.sessionId)
  const [modelIds, setModelIds] = useState<string[]>(() => [...host.declaredModelIds])
  /** Sessions this frontend already asked a title for. */
  const titled = useRef(new Set<string>())
  const setTerminalTitle = useTerminalTitle()

  /** Stored title of a session, when it has one. */
  const titleOf = (id: string | undefined): string | undefined =>
    id === undefined
      ? undefined
      : host.sessions.listHistory().find((session) => session.id === id)?.title

  // The terminal carries the session name, like a browser tab.
  useEffect(() => {
    setTerminalTitle(titleOf(host.sessionId) ?? DEFAULT_TERMINAL_TITLE)
    // Once, at mount: later updates come from /resume, /new, and the first message.
  }, [])

  // Effect dependencies compare arrays by identity, so these keys carry the
  // content: a frontend that rebuilds the host per render must not refetch.
  const providerKey = host.providerIds.join(',')
  const declaredKey = host.declaredModelIds.join(',')

  /**
   * Cached catalog ids for model completion; file cache only, no network.
   * The providers' own declarations survive a missing or stale cache.
   */
  useEffect(() => {
    let live = true
    void listCachedModels(join(host.dataDirectory, 'models.json'), {
      providers: host.providerIds,
    }).then((ids) => {
      if (live) {
        setModelIds(mergeModelIds(host.declaredModelIds, ids))
      }
    })
    return () => {
      live = false
    }
  }, [host.dataDirectory, providerKey, declaredKey])

  const { menu, above, below, selected, selectedItem, move } = useMenu(
    input,
    host.commands.list(),
    modelIds,
    context.providerId,
    host.sessions.listHistory(),
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
    setTranscript((previous) => applyUser(previous, makeId, text))
    setPending((count) => count + 1)
    // The first message names the session: store a title before the run.
    if (context.messageCount === 0 && !titled.current.has(context.id)) {
      titled.current.add(context.id)
      const local = titleFromMessage(text) || DEFAULT_TERMINAL_TITLE
      setTerminalTitle(local)
      // The model title lands later and replaces it in the tab as well.
      void host
        .titleSession(context.id, text)
        .then(() => setTerminalTitle(titleOf(context.id) ?? local))
        .catch(() => {})
    }
    agent.submit(text)
  }

  const notice = (text: string): void => {
    setTranscript((previous) => applyNotice(previous, makeId, text))
  }

  /**
   * Attaches the frontend to a stored session: its context becomes current,
   * its agent is built on its own model, and its history is replayed into the
   * transcript so the conversation continues where it stopped.
   */
  const openSession = async (id: string): Promise<void> => {
    const target = await host.sessions.get(id)
    if (target === undefined) {
      throw new Error(`Unknown session "${id}".`)
    }
    const next = host.agents.get(target.id) ?? host.agentFor(target)
    host.agents.set(target, next)
    setAgent(next)
    setContext(target)
    setSessionId(target.id)
    setTerminalTitle(titleOf(target.id) ?? DEFAULT_TERMINAL_TITLE)
    setTranscript((previous) => appendHistory(previous, target.messages, makeId))
  }

  /**
   * Opens a fresh session and points the frontend at it. Rows already printed
   * stay: Ink's `<Static>` only ever appends, so the transcript cannot shrink
   * without silently swallowing every later row. The command's own notice
   * marks where the new session starts.
   */
  const startSession = async (): Promise<string> => {
    const context = await host.sessions.createSession()
    const next = host.agentFor(context)
    host.agents.set(context, next)
    setAgent(next)
    setContext(context)
    setSessionId(context.id)
    setTerminalTitle(DEFAULT_TERMINAL_TITLE)
    return context.id
  }

  const runCommand = (text: string): void => {
    setTranscript((previous) => applyUser(previous, makeId, text))
    const parsed = parseCommand(text)
    const command = parsed === undefined ? undefined : host.commands.find(parsed.name)
    if (parsed === undefined || command === undefined) {
      notice(`Unknown command "${text}". /help lists commands.`)
      return
    }
    const ctx = buildCommandContext(host, {
      context,
      sessionId,
      knownModels: modelIds,
      agent,
      setAgent,
      openSession,
      startSession,
      notice,
      quit: exit,
    })
    void Promise.resolve(command.run(parsed.args, ctx)).catch((error: unknown) =>
      notice(error instanceof Error ? error.message : String(error)),
    )
  }

  useInput((chars, key) => {
    if (key.upArrow || key.downArrow) {
      move(key.downArrow ? 1 : -1)
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
      // Menu open: Enter selects the highlight into the input box, unless the
      // input already spells that selection out (a typed-out id): then send.
      if (
        selectedItem !== undefined &&
        !(selectedItem.submit === true && selectedItem.fill.trim() === text)
      ) {
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
    // One column of right padding: a bordered row must not end in the last
    // terminal column, where autowrap breaks the frame.
    <Box flexDirection="column" paddingRight={1}>
      <Static items={[...transcript.lines]}>
        {(line: TranscriptLine) => <TranscriptRow key={line.id} line={line} />}
      </Static>
      {transcript.liveReasoning.length > 0 && <LiveReasoning text={transcript.liveReasoning} />}
      {transcript.liveText.length > 0 && <LiveAnswer text={transcript.liveText} />}
      {transcript.liveTools.map((tool) => (
        <LiveToolCall key={tool.toolCallId} tool={tool} />
      ))}
      <InputBox input={input} hasTyped={hasTyped} pending={pending} />
      {above > 0 && (
        <Box paddingX={1}>
          <Text dimColor>{`  ↑ ${above} more`}</Text>
        </Box>
      )}
      {menu.length > 0 && <CandidateMenu items={menu} selected={selected} />}
      {below > 0 && (
        <Box paddingX={1}>
          <Text dimColor>{`  ↓ ${below} more. Keep typing to narrow.`}</Text>
        </Box>
      )}
      <Box paddingX={1} justifyContent="space-between">
        <Text dimColor>
          {contextUsage(context)}
          {pending > 0 ? ` · working (${pending})…` : ''}
        </Text>
        <Text dimColor>{context.modelId ?? '?'}</Text>
      </Box>
    </Box>
  )
}

/** Catalog ids plus the providers' own declarations, deduplicated and sorted. */
function mergeModelIds(declared: readonly string[], cached: readonly string[]): string[] {
  return [...new Set([...declared, ...cached])].sort()
}

/** What the command context needs from the TUI's current session. */
interface CommandWiring {
  context: RunHost['context']
  sessionId: string | undefined
  knownModels: readonly string[]
  agent: Agent
  setAgent: (agent: Agent) => void
  openSession: (id: string) => Promise<void>
  startSession: () => Promise<string>
  notice: (text: string) => void
  quit: () => void
}

/** Wires a slash command to this TUI: quit exits, notice prints, model and session switch. */
function buildCommandContext(host: RunHost, wiring: CommandWiring): CommandContext {
  return {
    commands: host.commands.list(),
    current: { providerId: wiring.context.providerId, modelId: wiring.context.modelId },
    sessionId: wiring.sessionId,
    sessions: host.sessions.listHistory(),
    providers: host.providerIds,
    knownModels: wiring.knownModels,
    quit: wiring.quit,
    notice: wiring.notice,
    resume: wiring.openSession,
    newSession: wiring.startSession,
    switchModel: async (providerId: string, modelId: string): Promise<ModelSwitch> => {
      const { agent: switchedAgent, ...switched } = await host.switchModel(
        wiring.context,
        providerId,
        modelId,
      )
      wiring.setAgent(switchedAgent)
      return switched
    },
  }
}
