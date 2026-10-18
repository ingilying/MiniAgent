import { Box, Text, useStdout } from 'ink'
import { Fragment } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { theme } from './theme.js'

/** One inline run of text with at most one style. */
export interface Span {
  readonly text: string
  readonly bold?: boolean
  readonly italic?: boolean
  readonly code?: boolean
  readonly strike?: boolean
  readonly href?: string
}

/** One block of a Markdown document. */
export type Block =
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'code'; readonly lang: string; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly ListItem[] }
  | { readonly kind: 'quote'; readonly lines: readonly string[] }
  | { readonly kind: 'rule' }
  | {
      readonly kind: 'table'
      readonly header: readonly string[]
      readonly align: readonly TableAlign[]
      readonly rows: readonly (readonly string[])[]
    }

/** Column alignment taken from the table's delimiter row. */
export type TableAlign = 'left' | 'center' | 'right'

/** One list row: its nesting depth, the marker it prints, and its text. */
export interface ListItem {
  readonly depth: number
  readonly marker: string
  readonly text: string
}

/**
 * Renders the model's Markdown answer: headings, paragraphs, lists, quotes,
 * rules, fenced code, and inline emphasis. Deliberately a subset — a chat
 * transcript needs readable text, not a full CommonMark parser.
 */
export function Markdown({
  text,
  prefix,
  suffix,
}: {
  text: string
  /** Marker for the first line, e.g. the answer bullet. */
  prefix?: ReactNode
  /** Trailing marker, e.g. the streaming cursor. */
  suffix?: ReactNode
}): ReactElement {
  const blocks = parseMarkdown(text)
  const first = blocks[0]
  const last = blocks.at(-1)
  // A paragraph or heading carries the markers inline, so their wrapped lines
  // start at the margin. Any other block gets them on their own rows.
  const inlinePrefix =
    first !== undefined && (first.kind === 'paragraph' || first.kind === 'heading')
  const inlineSuffix = last !== undefined && (last.kind === 'paragraph' || last.kind === 'heading')
  return (
    <>
      {prefix !== undefined && !inlinePrefix && <Box>{prefix}</Box>}
      {blocks.map((block, index) => (
        <Box key={index} marginTop={index === 0 ? 0 : 1} flexDirection="column">
          <BlockView
            block={block}
            prefix={index === 0 && inlinePrefix ? prefix : undefined}
            suffix={index === blocks.length - 1 && inlineSuffix ? suffix : undefined}
          />
        </Box>
      ))}
      {suffix !== undefined && !inlineSuffix && <Box>{suffix}</Box>}
    </>
  )
}

/** Parses the Markdown subset the transcript renders. */
export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let index = 0
  let paragraph: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
      paragraph = []
    }
  }

  while (index < lines.length) {
    const line = lines[index] ?? ''

    if (line.trim().length === 0) {
      flushParagraph()
      index += 1
      continue
    }

    // A fence is closed by the next fence; an unterminated one still renders
    // as code, so a half-streamed block does not flash as prose.
    if (line.trimStart().startsWith('```')) {
      flushParagraph()
      const lang = line.trim().slice(3).trim()
      const body: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').trimStart().startsWith('```')) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      blocks.push({ kind: 'code', lang, text: body.join('\n') })
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flushParagraph()
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: heading[2] ?? '' })
      index += 1
      continue
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph()
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }

    if (line.trimStart().startsWith('>')) {
      flushParagraph()
      const quoted: string[] = []
      while (index < lines.length && (lines[index] ?? '').trimStart().startsWith('>')) {
        quoted.push((lines[index] ?? '').replace(/^\s*>\s?/, ''))
        index += 1
      }
      blocks.push({ kind: 'quote', lines: quoted })
      continue
    }

    if (isTableStart(lines, index)) {
      flushParagraph()
      const header = splitCells(line)
      const align = splitCells(lines[index + 1] ?? '').map(alignmentOf)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && isTableRow(lines[index] ?? '')) {
        rows.push(fitCells(splitCells(lines[index] ?? ''), header.length))
        index += 1
      }
      blocks.push({ kind: 'table', header, align, rows })
      continue
    }

    if (listItemOf(line) !== undefined) {
      flushParagraph()
      const items: ListItem[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        const item = listItemOf(current)
        if (item === undefined) {
          // An indented line continues the previous item.
          const previous = items.at(-1)
          if (previous !== undefined && /^\s+\S/.test(current)) {
            items[items.length - 1] = { ...previous, text: `${previous.text} ${current.trim()}` }
            index += 1
            continue
          }
          break
        }
        items.push(item)
        index += 1
      }
      blocks.push({ kind: 'list', items })
      continue
    }

    paragraph.push(line.trim())
    index += 1
  }
  flushParagraph()
  return blocks
}

/** One list row from a line, when the line is a list item. */
function listItemOf(line: string): ListItem | undefined {
  const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
  if (match === null) {
    return undefined
  }
  const indent = (match[1] ?? '').length
  const marker = match[2] ?? '-'
  return {
    depth: Math.floor(indent / 2),
    marker: /^\d/.test(marker) ? marker : '•',
    text: match[3] ?? '',
  }
}

/** Whether a line opens a table: a header row and a delimiter row under it. */
function isTableStart(lines: readonly string[], index: number): boolean {
  const head = lines[index] ?? ''
  const delimiter = lines[index + 1] ?? ''
  return (
    head.includes('|') &&
    delimiter.includes('-') &&
    /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/.test(delimiter) &&
    splitCells(head).length === splitCells(delimiter).length
  )
}

/** Whether a line can be a table body row. */
function isTableRow(line: string): boolean {
  return line.includes('|') && !isTableStart([line], 0) && line.trim().length > 0
}

/** Cells of a table row, honouring `\|` escapes. */
function splitCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  for (let at = 0; at < trimmed.length; at += 1) {
    const char = trimmed[at]
    if (char === '\\' && trimmed[at + 1] === '|') {
      current += '|'
      at += 1
      continue
    }
    if (char === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim())
  return cells
}

/** Pads or trims a row to the header's column count. */
function fitCells(cells: readonly string[], count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => cells[index] ?? '')
}

/** Alignment of one delimiter cell. */
function alignmentOf(cell: string): TableAlign {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  return left && right ? 'center' : right ? 'right' : 'left'
}

/** Smallest column width a table shrinks to. */
const MIN_COLUMN = 3

/**
 * Column widths from the widest cell per column, shrunk one column at a time
 * until the grid fits the terminal.
 */
function columnWidths(block: Extract<Block, { kind: 'table' }>, available: number): number[] {
  const widths = block.header.map((cell, index) =>
    Math.max(
      MIN_COLUMN,
      displayWidth(plainOf(cell)),
      ...block.rows.map((row) => displayWidth(plainOf(row[index] ?? ''))),
    ),
  )
  let total = widths.reduce((sum, width) => sum + width + 3, 0) + 1
  while (total > available) {
    const widest = widths.indexOf(Math.max(...widths))
    if ((widths[widest] ?? 0) <= MIN_COLUMN) {
      break
    }
    widths[widest] = (widths[widest] ?? MIN_COLUMN) - 1
    total -= 1
  }
  return widths
}

/** A bordered table: header, delimiter rule, body rows, footer. */
function TableView({
  block,
  available,
}: {
  block: Extract<Block, { kind: 'table' }>
  available: number
}): ReactElement {
  const widths = columnWidths(block, available)
  const rule = (left: string, cross: string, right: string): string =>
    `${left}${widths.map((width) => '─'.repeat(width + 2)).join(cross)}${right}`
  return (
    <Box flexDirection="column">
      <Text dimColor>{rule('┌', '┬', '┐')}</Text>
      <TableRow cells={block.header} widths={widths} align={block.align} bold />
      <Text dimColor>{rule('├', '┼', '┤')}</Text>
      {block.rows.map((row, index) => (
        <TableRow key={index} cells={row} widths={widths} align={block.align} />
      ))}
      <Text dimColor>{rule('└', '┴', '┘')}</Text>
    </Box>
  )
}

/** One table row: each cell padded and aligned inside its column. */
function TableRow({
  cells,
  widths,
  align,
  bold = false,
}: {
  cells: readonly string[]
  widths: readonly number[]
  align: readonly TableAlign[]
  bold?: boolean
}): ReactElement {
  return (
    <Box>
      {widths.map((width, index) => (
        <Fragment key={index}>
          {/* A border-only box stretches to the row height, so every line of a
              wrapped row keeps a separator instead of leaving a gap. */}
          <Box
            borderStyle="single"
            borderTop={false}
            borderBottom={false}
            borderRight={false}
            borderDimColor
          />
          <Box
            width={width + 2}
            paddingX={1}
            justifyContent={
              align[index] === 'right'
                ? 'flex-end'
                : align[index] === 'center'
                  ? 'center'
                  : 'flex-start'
            }
          >
            <Text bold={bold}>
              <Spans spans={inlineSpans(cells[index] ?? '')} />
            </Text>
          </Box>
        </Fragment>
      ))}
      <Box
        borderStyle="single"
        borderTop={false}
        borderBottom={false}
        borderRight={false}
        borderDimColor
      />
    </Box>
  )
}

/** Text of a cell with its Markdown markers removed, for width math. */
function plainOf(cell: string): string {
  return inlineSpans(cell)
    .map((span) => span.text)
    .join('')
}

/** Terminal columns a string takes: wide characters count two. */
function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    if (/[\u0300-\u036F]/.test(char)) {
      continue
    }
    width += WIDE.test(char) ? 2 : 1
  }
  return width
}

/** East Asian wide and emoji ranges: two columns each. */
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}]|[\u{20000}-\u{3FFFD}]/u

/** Splits inline Markdown into styled spans. */
export function inlineSpans(text: string): Span[] {
  const spans: Span[] = []
  const pattern =
    /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`]+`|~~[^~]+~~|\[[^\]]+\]\([^)\s]+\))/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0
    if (at > last) {
      spans.push({ text: text.slice(last, at) })
    }
    spans.push(inlineOf(match[0]))
    last = at + match[0].length
  }
  if (last < text.length) {
    spans.push({ text: text.slice(last) })
  }
  return spans
}

/** One inline token as a span. */
function inlineOf(token: string): Span {
  if (token.startsWith('**') || token.startsWith('__')) {
    return { text: token.slice(2, -2), bold: true }
  }
  if (token.startsWith('`')) {
    return { text: token.slice(1, -1), code: true }
  }
  if (token.startsWith('~~')) {
    return { text: token.slice(2, -2), strike: true }
  }
  if (token.startsWith('[')) {
    const split = token.indexOf('](')
    return { text: token.slice(1, split), href: token.slice(split + 2, -1) }
  }
  return { text: token.slice(1, -1), italic: true }
}

/** Draws one parsed block. */
function BlockView({
  block,
  prefix,
  suffix,
}: {
  block: Block
  prefix?: ReactNode
  suffix?: ReactNode
}): ReactElement {
  const { stdout } = useStdout()
  const columns = (stdout as { columns?: number }).columns ?? 80
  switch (block.kind) {
    case 'paragraph':
      return (
        <Text>
          {prefix}
          <Spans spans={inlineSpans(block.text)} />
          {suffix}
        </Text>
      )
    case 'heading':
      return (
        <Text
          bold
          underline={block.level === 1}
          color={block.level <= 2 ? theme.accent : undefined}
          dimColor={block.level > 3}
        >
          {prefix}
          <Spans spans={inlineSpans(block.text)} />
          {suffix}
        </Text>
      )
    case 'code':
      return (
        <Box borderStyle="round" borderDimColor flexDirection="column" paddingX={1}>
          {block.lang.length > 0 && <Text dimColor>{block.lang}</Text>}
          <Text color={theme.code}>{block.text}</Text>
        </Box>
      )
    case 'quote':
      return (
        <Box flexDirection="column">
          {block.lines.map((line, index) => (
            <Box key={index} paddingLeft={1}>
              <Text dimColor>{'│ '}</Text>
              <Box flexGrow={1} flexShrink={1}>
                <Text italic dimColor>
                  {line}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
      )
    case 'rule':
      return <Text dimColor>{'─'.repeat(Math.max(10, columns - 10))}</Text>
    case 'table':
      return <TableView block={block} available={Math.max(20, columns - 10)} />
    case 'list':
      return (
        <Box flexDirection="column">
          {block.items.map((item, index) => (
            <Box key={index} paddingLeft={item.depth * 2}>
              <Text color={theme.agent}>{`${item.marker} `}</Text>
              <Box flexGrow={1} flexShrink={1}>
                <Text>
                  <Spans spans={inlineSpans(item.text)} />
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
      )
  }
}

/** Draws inline spans inside one Text. */
function Spans({ spans }: { spans: readonly Span[] }): ReactElement {
  return (
    <>
      {spans.map((span, index) => {
        if (span.code) {
          return (
            <Text key={index} color={theme.code}>
              {span.text}
            </Text>
          )
        }
        if (span.bold) {
          return (
            <Text key={index} bold>
              {span.text}
            </Text>
          )
        }
        if (span.italic) {
          return (
            <Text key={index} italic>
              {span.text}
            </Text>
          )
        }
        if (span.strike) {
          return (
            <Text key={index} strikethrough>
              {span.text}
            </Text>
          )
        }
        if (span.href !== undefined) {
          return (
            <Text key={index}>
              <Text underline color={theme.agent}>
                {span.text}
              </Text>
              {span.href === span.text ? null : <Text dimColor>{` (${span.href})`}</Text>}
            </Text>
          )
        }
        return <Text key={index}>{span.text}</Text>
      })}
    </>
  )
}
