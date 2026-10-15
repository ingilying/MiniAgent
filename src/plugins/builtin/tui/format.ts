import type { Context } from '../../../session/context.js'

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
