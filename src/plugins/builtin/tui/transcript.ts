import type { AgentEvent } from '../../../agent/agent.js'

/**
 * One finished transcript row. Each kind is drawn by its own component in
 * `components.tsx`; the union is what the TUI stores, not what it prints.
 */
export type TranscriptLine =
  | { readonly id: string; readonly kind: 'user'; readonly text: string }
  | { readonly id: string; readonly kind: 'assistant'; readonly text: string }
  | { readonly id: string; readonly kind: 'reasoning'; readonly text: string }
  | {
      readonly id: string
      readonly kind: 'tool'
      readonly toolName: string
      readonly input: unknown
      readonly output: unknown
      readonly isError: boolean
      /** Blank line before this block: it starts a run of tool calls. */
      readonly spaced: boolean
    }
  | { readonly id: string; readonly kind: 'error'; readonly text: string }
  | { readonly id: string; readonly kind: 'system'; readonly text: string }
  | { readonly id: string; readonly kind: 'art'; readonly text: string }
  | { readonly id: string; readonly kind: 'welcome'; readonly text: string }

/** A tool call the model made and the run has not answered yet. */
export interface LiveTool {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: unknown
}

/**
 * What the TUI shows: finished rows plus the run still in flight.
 *
 * Finished rows go to Ink's `<Static>`, which never re-renders them, so a
 * tool row only becomes a row once its result arrives; until then the call
 * sits in `liveTools` and is redrawn as a pending line. Live reasoning and
 * live answer text are separate so each gets its own component, and both
 * are flushed into finished rows when the next event ends that phase.
 */
export interface TranscriptState {
  readonly lines: readonly TranscriptLine[]
  readonly liveText: string
  readonly liveReasoning: string
  readonly liveTools: readonly LiveTool[]
}

/** Empty transcript. */
export function emptyTranscript(): TranscriptState {
  return { lines: [], liveText: '', liveReasoning: '', liveTools: [] }
}

/**
 * Transcript prefilled with the pinned banner rows. Ink renders `<Static>`
 * items above everything live, so the art and welcome box ride along as
 * the first static rows: new turns append below them instead of pushing
 * a live header down.
 */
export function initialTranscript(
  makeId: () => string,
  art: string,
  subtitle: string,
): TranscriptState {
  return {
    ...emptyTranscript(),
    lines: [
      { id: makeId(), kind: 'art', text: art },
      { id: makeId(), kind: 'welcome', text: subtitle },
    ],
  }
}

/** Appends a user turn. Flushes anything the previous run still has live. */
export function applyUser(
  state: TranscriptState,
  makeId: () => string,
  text: string,
): TranscriptState {
  const flushed = flushAll(state, makeId)
  return {
    ...flushed,
    lines: [...flushed.lines, { id: makeId(), kind: 'user', text }],
  }
}

/** Appends a command output row. Flushes anything the previous run still has live. */
export function applyNotice(
  state: TranscriptState,
  makeId: () => string,
  text: string,
): TranscriptState {
  const flushed = flushAll(state, makeId)
  return {
    ...flushed,
    lines: [...flushed.lines, { id: makeId(), kind: 'system', text }],
  }
}

/**
 * Folds one agent event into the transcript. Pure and TTY-free, so tests
 * drive it directly. `makeId` mints row ids; the caller owns the counter.
 */
export function applyEvent(
  state: TranscriptState,
  event: AgentEvent,
  makeId: () => string,
): TranscriptState {
  switch (event.type) {
    case 'reasoning-delta':
      return { ...state, liveReasoning: state.liveReasoning + event.text }

    case 'text-delta': {
      // Reasoning came first; the answer starting ends that phase.
      const flushed = flushReasoning(state, makeId)
      return { ...flushed, liveText: flushed.liveText + event.text }
    }

    case 'tool-call': {
      const flushed = flushAll(state, makeId)
      return {
        ...flushed,
        liveTools: [
          ...flushed.liveTools,
          { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input },
        ],
      }
    }

    case 'tool-result': {
      const called = state.liveTools.find((tool) => tool.toolCallId === event.toolCallId)
      if (called === undefined) {
        // A result without a call: replay order was lost, keep the output.
        return {
          ...state,
          lines: [
            ...state.lines,
            {
              id: makeId(),
              kind: 'tool',
              toolName: event.toolName,
              input: undefined,
              output: event.output,
              isError: event.isError === true,
              spaced: state.lines.at(-1)?.kind !== 'tool',
            },
          ],
        }
      }
      return {
        ...state,
        lines: [
          ...state.lines,
          {
            id: makeId(),
            kind: 'tool',
            toolName: event.toolName,
            input: called.input,
            output: event.output,
            isError: event.isError === true,
            spaced: state.lines.at(-1)?.kind !== 'tool',
          },
        ],
        liveTools: state.liveTools.filter((tool) => tool.toolCallId !== event.toolCallId),
      }
    }

    case 'error': {
      const flushed = flushAll(state, makeId)
      return {
        ...emptyTranscript(),
        lines: [...flushed.lines, { id: makeId(), kind: 'error', text: messageOf(event.error) }],
      }
    }

    case 'finish': {
      // A finished run has nothing pending, even if a step ended early.
      return { ...flushAll(state, makeId), liveTools: [] }
    }

    default:
      return state
  }
}

/** Moves pending reasoning and answer text into finished rows. */
function flushAll(state: TranscriptState, makeId: () => string): TranscriptState {
  const flushed = flushReasoning(state, makeId)
  if (flushed.liveText.length === 0) {
    return flushed
  }
  return {
    ...flushed,
    lines: [...flushed.lines, { id: makeId(), kind: 'assistant', text: flushed.liveText }],
    liveText: '',
  }
}

/** Moves pending reasoning into a finished row, or keeps the state when dry. */
function flushReasoning(state: TranscriptState, makeId: () => string): TranscriptState {
  if (state.liveReasoning.length === 0) {
    return state
  }
  return {
    ...state,
    lines: [...state.lines, { id: makeId(), kind: 'reasoning', text: state.liveReasoning }],
    liveReasoning: '',
  }
}

/** Readable message out of anything a run can fail with. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
