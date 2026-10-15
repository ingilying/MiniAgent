import type { AgentEvent } from '../../../agent/agent.js'

/** One rendered transcript row. Banner rows pin the welcome to the top. */
export interface TranscriptLine {
  readonly id: string
  readonly kind: 'user' | 'assistant' | 'tool' | 'error' | 'system' | 'art' | 'welcome'
  readonly text: string
}

/**
 * What the TUI shows: finished rows plus the assistant text still
 * streaming. Finished rows go to Ink's `<Static>` (never re-rendered);
 * the live text sits in a plain box below it. A `finish` or `error`
 * event flushes the live text into a finished assistant row.
 */
export interface TranscriptState {
  readonly lines: readonly TranscriptLine[]
  readonly liveText: string
}

/** Empty transcript. */
export function emptyTranscript(): TranscriptState {
  return { lines: [], liveText: '' }
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
    lines: [
      { id: makeId(), kind: 'art', text: art },
      { id: makeId(), kind: 'welcome', text: subtitle },
    ],
    liveText: '',
  }
}

/** Appends a user turn. Flushes any live assistant text first. */
export function applyUser(state: TranscriptState, id: string, text: string): TranscriptState {
  return {
    lines: [...flushLive(state.lines, state.liveText, id), { id, kind: 'user', text }],
    liveText: '',
  }
}

/** Appends a command output row. Flushes any live assistant text first. */
export function applyNotice(state: TranscriptState, id: string, text: string): TranscriptState {
  return {
    lines: [...flushLive(state.lines, state.liveText, id), { id, kind: 'system', text }],
    liveText: '',
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
    case 'text-delta':
      return { lines: state.lines, liveText: state.liveText + event.text }
    case 'tool-call':
      return {
        lines: [
          ...flushLive(state.lines, state.liveText, makeId()),
          { id: makeId(), kind: 'tool', text: `◌ ${event.toolName} ${summarize(event.input)}` },
        ],
        liveText: '',
      }
    case 'tool-result':
      return {
        lines: [
          ...flushLive(state.lines, state.liveText, makeId()),
          { id: makeId(), kind: 'tool', text: `✔ ${event.toolName} → ${summarize(event.output)}` },
        ],
        liveText: '',
      }
    case 'error':
      return {
        lines: [
          ...flushLive(state.lines, state.liveText, makeId()),
          { id: makeId(), kind: 'error', text: messageOf(event.error) },
        ],
        liveText: '',
      }
    case 'finish':
      return { lines: flushLive(state.lines, state.liveText, makeId()), liveText: '' }
    default:
      return state
  }
}

/** Moves pending live text into a finished assistant row, or no rows when empty. */
function flushLive(
  lines: readonly TranscriptLine[],
  liveText: string,
  id: string,
): readonly TranscriptLine[] {
  return liveText.length === 0 ? lines : [...lines, { id, kind: 'assistant', text: liveText }]
}

/** One-line preview of a tool input or output. */
function summarize(value: unknown): string {
  const flat = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  const single = flat.replace(/\s+/g, ' ').trim()
  return single.length > 120 ? `${single.slice(0, 119)}…` : single
}

/** Readable message out of anything a run can fail with. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
