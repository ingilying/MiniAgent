import { useRef, useState, type Dispatch, type SetStateAction } from 'react'

import type { CommandInfo } from '../../../commands/commands.js'

/** One selectable menu row: label, dim hint, and the text Tab/Enter fills. */
export interface MenuItem {
  readonly label: string
  readonly hint: string
  readonly fill: string
}

/** Maximum menu rows; typing narrows beyond it. */
const MAX_MENU_ITEMS = 15

/** Rows a menu offers. `hidden` counts matches past the cap, so a frontend can say so. */
export interface MenuList {
  readonly items: MenuItem[]
  readonly hidden: number
}

/** Caps a matched list and counts the rows beyond the cap. */
function capMenu(items: MenuItem[]): MenuList {
  return {
    items: items.slice(0, MAX_MENU_ITEMS),
    hidden: Math.max(0, items.length - MAX_MENU_ITEMS),
  }
}

/**
 * Command menu for a slash prefix: canonical names whose name or alias
 * starts with the partial text, case-insensitively, alphabetical.
 * The registry only lists; all filtering lives here.
 */
export function commandMenu(commands: readonly CommandInfo[], partial: string): MenuList {
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
  return capMenu(matched)
}

/**
 * Model menu for `/model <partial>`: cached `provider/id` entries whose
 * bare id or full form starts with the partial text, case-insensitively.
 * The current provider's models sort first, then alphabetical.
 */
export function modelMenu(ids: readonly string[], provider: string, partial: string): MenuList {
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
  return capMenu(matched.map((id) => ({ label: id, hint: '', fill: `/model ${id} ` })))
}

export interface MenuSelection {
  readonly menu: MenuItem[]
  /** Matches past the cap, when the menu is truncated. */
  readonly hidden: number
  readonly selected: number
  readonly selectedItem: MenuItem | undefined
  readonly setSelected: Dispatch<SetStateAction<number>>
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
): MenuSelection {
  const commandPartial = /^\/(\S*)$/.exec(input)?.[1]
  const modelPartial = /^\/model\s+(\S*)$/.exec(input)?.[1]
  const list: MenuList =
    commandPartial !== undefined
      ? commandMenu(commands, commandPartial)
      : modelPartial !== undefined
        ? modelMenu(modelIds, provider, modelPartial)
        : { items: [], hidden: 0 }
  const menu = list.items

  const [selected, setSelected] = useState(0)
  const menuKey = `${commandPartial ?? ''}|${modelPartial ?? ''}|${menu.map((item) => item.label).join(',')}`
  const lastMenuKey = useRef(menuKey)
  if (lastMenuKey.current !== menuKey) {
    lastMenuKey.current = menuKey
    setSelected(0)
  }
  const selectedItem = menu.length === 0 ? undefined : menu[selected % menu.length]
  return {
    menu,
    hidden: list.hidden,
    selected: menu.length === 0 ? 0 : selected % menu.length,
    selectedItem,
    setSelected,
  }
}
