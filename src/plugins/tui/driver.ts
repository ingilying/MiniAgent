import type { AgentEvent } from '../../agent.js'
import type { CommandInfo } from '../../commands.js'
import type { Context } from '../../context.js'

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

/** One selectable menu row: label, dim hint, and the text Tab/Enter fills. */
export interface MenuItem {
  readonly label: string
  readonly hint: string
  readonly fill: string
}

/** Maximum menu rows; typing narrows beyond it. */
const MAX_MENU_ITEMS = 15

/**
 * Command menu for a slash prefix: canonical names whose name or alias
 * starts with the partial text, case-insensitively, alphabetical.
 * The registry only lists; all filtering lives here.
 */
export function commandMenu(commands: readonly CommandInfo[], partial: string): MenuItem[] {
  const lower = partial.toLowerCase()
  const items: MenuItem[] = []
  const seen = new Set<string>()
  const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name))
  for (const command of sorted) {
    const hit =
      command.name.toLowerCase().startsWith(lower) ||
      command.aliases.some((alias) => alias.toLowerCase().startsWith(lower))
    if (hit && !seen.has(command.name)) {
      seen.add(command.name)
      items.push({
        label: `/${command.name}`,
        hint: command.description,
        fill: `/${command.name} `,
      })
    }
  }
  return items.slice(0, MAX_MENU_ITEMS)
}

/**
 * Model menu for `/model <partial>`: cached `provider/id` entries whose
 * bare id or full form starts with the partial text, case-insensitively.
 * The current provider's models sort first, then alphabetical.
 */
export function modelMenu(ids: readonly string[], provider: string, partial: string): MenuItem[] {
  const lower = partial.toLowerCase()
  const matched = ids.filter((id) => {
    const slash = id.indexOf('/')
    const bare = slash === -1 ? id : id.slice(slash + 1)
    return bare.toLowerCase().startsWith(lower) || id.toLowerCase().startsWith(lower)
  })
  matched.sort((a, b) => {
    const aOurs = a.startsWith(`${provider}/`) ? 0 : 1
    const bOurs = b.startsWith(`${provider}/`) ? 0 : 1
    return aOurs - bOurs || a.localeCompare(b)
  })
  return matched
    .slice(0, MAX_MENU_ITEMS)
    .map((id) => ({ label: id, hint: '', fill: `/model ${id} ` }))
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

/** Compact usage line for below the input box: `0/1M (0%)`. */
export function contextUsage(context: Context): string {
  const used = context.tokenCount
  const window = context.contextWindow
  if (window === undefined || window <= 0) {
    return used > 0 ? compact(used) : '—'
  }
  const percent = Math.round((used / window) * 100)
  return `${compact(used)}/${compact(window)} (${percent}%)`
}

/** Compact token count: 950 stays, 1500 becomes 1.5k, 1000000 becomes 1M. */
function compact(count: number): string {
  if (count >= 999_500) return `${strip(count / 1_000_000)}M`
  if (count >= 1000) return `${strip(count / 1000)}k`
  return `${count}`
}

/** One decimal, trailing .0 dropped: 1 stays 1, 1.05 lands on 1.1. */
function strip(value: number): number {
  return Math.round(value * 10) / 10
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
