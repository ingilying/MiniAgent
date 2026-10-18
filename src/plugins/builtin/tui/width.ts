/** East Asian wide and emoji ranges: two terminal columns each. */
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}]|[\u{20000}-\u{3FFFD}]/u

/** Terminal columns one character takes: 0 for combining marks, 2 for wide. */
function charWidth(char: string): number {
  if (/[\u0300-\u036F]/.test(char)) {
    return 0
  }
  return WIDE.test(char) ? 2 : 1
}

/** Terminal columns a string takes: wide characters count two. */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    width += charWidth(char)
  }
  return width
}

/**
 * Cuts a line to `width` columns, marking the cut with an ellipsis. Wide
 * characters are never split in half, so the result fits a bordered row.
 */
export function truncateToWidth(line: string, width: number): string {
  if (width <= 0) {
    return ''
  }
  if (displayWidth(line) <= width) {
    return line
  }
  let kept = ''
  let used = 0
  for (const char of line) {
    const size = charWidth(char)
    if (used + size > width - 1) {
      break
    }
    kept += char
    used += size
  }
  return `${kept}…`
}
