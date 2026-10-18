import { useRef, useState } from 'react'

import type { CommandInfo } from '../../../commands/commands.js'
import type { SessionInfo } from '../../../session/manager.js'

/** One selectable menu row: label, dim hint, and the text Tab/Enter fills. */
export interface MenuItem {
  readonly label: string
  readonly hint: string
  readonly fill: string
  /**
   * Enter sends the input when it already spells this row out. True for
   * values (model ids, session ids); false for command names, which are
   * usually followed by arguments.
   */
  readonly submit?: boolean
}

/** Rows a menu shows at once; longer lists scroll with the highlight. */
const VISIBLE_MENU_ITEMS = 8

/**
 * Command menu for a slash prefix: canonical names whose name or alias
 * starts with the partial text, case-insensitively, alphabetical.
 * The registry only lists; all filtering lives here.
 */
export function commandMenu(commands: readonly CommandInfo[], partial: string): MenuItem[] {
  const lower = partial.toLowerCase()
  const matched: MenuItem[] = []
  const seen = new Set<string>()
  const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name))
  for (const command of sorted) {
    const hit =
      command.name.toLowerCase().startsWith(lower) ||
      command.aliases.some((alias) => alias.toLowerCase().startsWith(lower))
    if (hit && !seen.has(command.name)) {
      seen.add(command.name)
      matched.push({
        label: `/${command.name}`,
        hint: command.description,
        fill: `/${command.name} `,
      })
    }
  }
  return matched
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
  return matched.map((id) => ({ label: id, hint: '', fill: `/model ${id} `, submit: true }))
}

/**
 * Session menu for `/resume [partial]`: stored sessions newest first, shown
 * by title, filtered by id prefix or title substring. Selecting one fills the
 * input with the full id, so the command itself stays the single resolver.
 */
export function sessionMenu(sessions: readonly SessionInfo[], partial: string): MenuItem[] {
  const lower = partial.toLowerCase()
  return sessions
    .filter(
      (session) =>
        lower.length === 0 ||
        session.id.toLowerCase().includes(lower) ||
        (session.title ?? '').toLowerCase().includes(lower),
    )
    .map((session) => ({
      label: session.title ?? '(untitled)',
      hint: `${session.id.slice(0, 8)} · ${session.updatedAt.slice(0, 16).replace('T', ' ')}`,
      fill: `/resume ${session.id} `,
      submit: true,
    }))
}

/** The visible slice of a menu: rows, the highlight inside it, and the rest. */
export interface MenuWindow {
  readonly items: readonly MenuItem[]
  /** Highlight index inside `items`. */
  readonly selected: number
  /** Matches above the window. */
  readonly above: number
  /** Matches below the window. */
  readonly below: number
}

/**
 * Slides a window over the matches so the highlight stays visible. The
 * window sits at an edge until the highlight reaches its middle, then
 * follows the highlight one row per step.
 */
export function menuWindow(
  items: readonly MenuItem[],
  selected: number,
  visible = VISIBLE_MENU_ITEMS,
): MenuWindow {
  if (items.length === 0) {
    return { items: [], selected: 0, above: 0, below: 0 }
  }
  const index = ((selected % items.length) + items.length) % items.length
  const start = Math.min(
    Math.max(0, index - Math.floor(visible / 2)),
    Math.max(0, items.length - visible),
  )
  const end = Math.min(items.length, start + visible)
  return {
    items: items.slice(start, end),
    selected: index - start,
    above: start,
    below: items.length - end,
  }
}

export interface MenuSelection {
  /** Visible rows of the open menu. */
  readonly menu: readonly MenuItem[]
  /** Matches hidden above and below the visible rows. */
  readonly above: number
  readonly below: number
  /** Highlight index inside `menu`. */
  readonly selected: number
  /** The highlighted row of the whole list. */
  readonly selectedItem: MenuItem | undefined
  /** Moves the highlight, wrapping at both ends. */
  move(delta: number): void
}

/**
 * Open menu for the current input: command names for a slash prefix,
 * model ids for `/model <partial>`. Empty everywhere else. Restarts the
 * highlight whenever the menu contents change.
 */
export function useMenu(
  input: string,
  commands: readonly CommandInfo[],
  modelIds: readonly string[],
  provider: string,
  sessions: readonly SessionInfo[] = [],
): MenuSelection {
  const resumePartial = /^\/(?:resume|sessions)(?:\s+(\S*))?$/i.exec(input)
  const commandPartial = /^\/(\S*)$/.exec(input)?.[1]
  const modelPartial = /^\/model\s+(\S*)$/.exec(input)?.[1]
  const items =
    resumePartial !== null
      ? sessionMenu(sessions, resumePartial[1] ?? '')
      : commandPartial !== undefined
        ? commandMenu(commands, commandPartial)
        : modelPartial !== undefined
          ? modelMenu(modelIds, provider, modelPartial)
          : []

  const [selected, setSelected] = useState(0)
  // Contents key: partials plus the ends of the list, so a refetch or a new
  // prefix restarts the highlight without hashing every label.
  const menuKey = `${input}|${items.length}|${items[0]?.label ?? ''}|${items.at(-1)?.label ?? ''}`
  const lastMenuKey = useRef(menuKey)
  if (lastMenuKey.current !== menuKey) {
    lastMenuKey.current = menuKey
    setSelected(0)
  }

  const window = menuWindow(items, selected)
  const selectedItem =
    items.length === 0
      ? undefined
      : items[((selected % items.length) + items.length) % items.length]

  return {
    menu: window.items,
    above: window.above,
    below: window.below,
    selected: window.selected,
    selectedItem,
    move: (delta: number): void => {
      if (items.length === 0) {
        return
      }
      setSelected((index) => (index + delta + items.length) % items.length)
    },
  }
}
