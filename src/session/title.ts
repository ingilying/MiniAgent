/** Longest title kept, in characters. */
export const TITLE_MAX_LENGTH = 48

/**
 * Title from the model's answer. Models like to wrap a two-word title in a
 * fence, quotes, or a `Title:` prefix; strip those before taking the first
 * line, so a good answer does not get thrown away as empty.
 */
export function titleFromAnswer(text: string, max = TITLE_MAX_LENGTH): string {
  const cleaned = text
    .replace(/^\s*```[^\n]*$/gm, '')
    .replace(/^\s*(?:title|session title|标题)\s*[:：]\s*/i, '')
    .replace(/^[\s"'`「『“”*]+/, '')
    .replace(/[\s"'`」』“”*]+$/, '')
  return titleFromMessage(cleaned, max)
}

/**
 * Title for a session from its first user message: the first non-empty line,
 * whitespace flattened, Markdown markers dropped, cut to one short line.
 *
 * This is the title stored right away, before the session's model has a
 * chance to write a better one.
 */
export function titleFromMessage(text: string, max = TITLE_MAX_LENGTH): string {
  const firstLine =
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  const flat = firstLine
    .replace(/[`*_~>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length <= max) {
    return flat
  }
  return `${flat.slice(0, max - 1).trimEnd()}…`
}
