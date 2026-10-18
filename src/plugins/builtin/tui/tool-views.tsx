import { Box, Text } from 'ink'
import type { ReactElement, ReactNode } from 'react'

import { useColumns } from './terminal.js'
import { glyph, theme } from './theme.js'
import { truncateToWidth } from './width.js'

/** What a tool view draws: the call, and unless pending, its outcome. */
export interface ToolViewProps {
  readonly toolName: string
  readonly input: unknown
  readonly output: unknown
  readonly isError: boolean
  /** True while the tool runs: no result or detail lines yet. */
  readonly pending: boolean
  /** True when a blank line should separate this block from the row above. */
  readonly spaced: boolean
}

/** Draws one tool call. Specialised per tool name; generic when none exists. */
export type ToolView = (props: ToolViewProps) => ReactElement

/** Lines a read block renders before folding. */
const READ_LINES = 20

/** Lines a write block renders before folding. */
const WRITE_LINES = 10

/** Result lines a shell block renders before folding. */
const SHELL_LINES = 10

/** Rows an edit block renders before folding. */
const EDIT_LINES = 24

/** Command lines a shell block renders before folding. */
const COMMAND_LINES = 6

/** Columns a bordered block spends on borders, padding, and line numbers. */
const BOX_CHROME = 8

/** Columns left as a margin, so a border never lands in the last terminal column. */
const BOX_MARGIN = 4

/** One rendered code line: optional number, optional diff sign, the text. */
interface CodeRow {
  readonly number?: number
  readonly sign?: '-' | '+'
  readonly text: string
}

/** A block of code rows plus how many lines were folded away. */
interface CodeBlock {
  readonly rows: readonly CodeRow[]
  readonly hidden: number
  /** Widest line number in the block, for gutter alignment. */
  readonly lastNumber: number
}

/**
 * Specialised views by tool name. A tool name without an entry falls back to
 * `GenericToolView`, so plugin tools work without registering anything.
 */
const VIEWS = new Map<string, ToolView>([
  ['read', ReadToolView],
  ['write', WriteToolView],
  ['edit', EditToolView],
  ['shell', ShellToolView],
])

/** The view for a tool: its specialised one, or the generic fallback. */
export function toolView(toolName: string): ToolView {
  return VIEWS.get(toolName) ?? GenericToolView
}

/** Fallback: the tool name, its input, its output, and any text output. */
export function GenericToolView({
  toolName,
  input,
  output,
  isError,
  pending,
  spaced,
}: ToolViewProps): ReactElement {
  return (
    <ToolFrame
      pending={pending}
      isError={isError}
      output={output}
      spaced={spaced}
      name={toolName}
      args={`(${summarize(input)})`}
      summary={summarize(output)}
    >
      <DetailLines lines={textOf(output)} />
    </ToolFrame>
  )
}

/** `read(path)`: the returned slice, numbered, in a box. */
export function ReadToolView({
  input,
  output,
  isError,
  pending,
  spaced,
}: ToolViewProps): ReactElement {
  const width = useTextWidth()
  const start = numberField(input, 'offset') ?? 1
  const content = stringField(output, 'content')
  const total = numberField(output, 'lines')
  const truncated = boolField(output, 'truncated')
  const returned = content === undefined ? undefined : lineCountOf(content)
  const block =
    content === undefined ? undefined : numberedBlock(content, start, READ_LINES, width, total)
  return (
    <ToolFrame
      pending={pending}
      isError={isError}
      output={output}
      spaced={spaced}
      name="read"
      args={`(${stringField(input, 'path') ?? summarize(input)})`}
      summary={
        isError || returned === undefined || total === undefined
          ? summarize(output)
          : `${returned} of ${plural(total, 'line')}${truncated ? ' (truncated)' : ''}`
      }
    >
      {block !== undefined && <CodeBox block={block} />}
    </ToolFrame>
  )
}

/** `write(path)`: the first lines of what landed, numbered, in a box. */
export function WriteToolView({
  input,
  output,
  isError,
  pending,
  spaced,
}: ToolViewProps): ReactElement {
  const width = useTextWidth()
  const bytes = numberField(output, 'bytes')
  const content = stringField(input, 'content')
  const lines = content === undefined ? undefined : lineCountOf(content)
  const block = content === undefined ? undefined : numberedBlock(content, 1, WRITE_LINES, width)
  return (
    <ToolFrame
      pending={pending}
      isError={isError}
      output={output}
      spaced={spaced}
      name="write"
      args={`(${stringField(input, 'path') ?? summarize(input)})`}
      summary={
        isError || bytes === undefined
          ? summarize(output)
          : `${bytes} bytes${lines === undefined ? '' : ` · ${plural(lines, 'line')}`}`
      }
    >
      {block !== undefined && <CodeBox block={block} />}
    </ToolFrame>
  )
}

/** `edit(path)`: the change with its context, removed lines `-`, added `+`. */
export function EditToolView({
  input,
  output,
  isError,
  pending,
  spaced,
}: ToolViewProps): ReactElement {
  const width = useTextWidth()
  const replacements = numberField(output, 'replacements')
  const change = changeOf(output)
  const block = change === undefined ? undefined : editBlock(change, width)
  return (
    <ToolFrame
      pending={pending}
      isError={isError}
      output={output}
      spaced={spaced}
      name="edit"
      args={`(${stringField(input, 'path') ?? summarize(input)})`}
      summary={
        isError || replacements === undefined
          ? summarize(output)
          : `${plural(replacements, 'replacement')}`
      }
    >
      {block !== undefined ? (
        <CodeBox block={block} />
      ) : (
        <DetailLines lines={textOf(output).length > 0 ? textOf(output) : inputDiff(input)} />
      )}
    </ToolFrame>
  )
}

/**
 * `shell(command)`: a box with the command on top, a rule, then the result.
 * The result is shown whole until it passes `SHELL_LINES`, then it folds.
 */
export function ShellToolView({
  input,
  output,
  isError,
  pending,
  spaced,
}: ToolViewProps): ReactElement {
  const width = useTextWidth()
  const boxWidth = useBoxWidth()
  const command = stringField(input, 'command') ?? summarize(input)
  const exitCode = numberField(output, 'exitCode')
  const stdout = stringField(output, 'stdout') ?? ''
  const stderr = stringField(output, 'stderr') ?? ''
  const printed = lineCountOf(`${stdout}${stderr}`)
  const truncated = boolField(output, 'truncated')
  const result = preview(`${stdout}${stderr}`, SHELL_LINES, width)
  const commands = commandLines(command, width)
  return (
    <ToolFrame
      pending={pending}
      isError={isError}
      output={output}
      spaced={spaced}
      name="shell"
      args=""
      summary={
        isError || exitCode === undefined
          ? summarize(output)
          : `exit ${exitCode}${printed === 0 ? '' : ` · ${plural(printed, 'line')}`}${
              truncated ? ' (truncated)' : ''
            }`
      }
    >
      <Box borderStyle="round" borderDimColor flexDirection="column" paddingX={1} width={boxWidth}>
        {commands.map((line, index) => (
          <Text key={index}>
            <Text dimColor>{index === 0 ? '$ ' : '  '}</Text>
            {line}
          </Text>
        ))}
        <Box
          borderStyle="single"
          borderTop
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
          borderDimColor
        />
        {result.lines.length === 0 ? (
          <Text dimColor>(no output)</Text>
        ) : (
          <Box flexDirection="column">
            {result.lines.map((line, index) => (
              <Text key={`${index}:${line}`}>{line}</Text>
            ))}
            {result.hidden > 0 && <Text dimColor>{`… +${result.hidden} more lines`}</Text>}
          </Box>
        )}
      </Box>
    </ToolFrame>
  )
}

/** The frame every tool view shares: one call line, result line, content. */
function ToolFrame({
  pending,
  isError,
  output,
  spaced,
  name,
  args,
  summary,
  children,
}: {
  pending: boolean
  isError: boolean
  output: unknown
  spaced: boolean
  name: string
  args: string
  summary: string
  children?: ReactNode
}): ReactElement {
  const color = isError ? theme.error : undefined
  // A failure is the message, split over its lines; never the tool's summary.
  const failure = isError ? splitError(output) : undefined
  return (
    <Box flexDirection="column" marginTop={spaced ? 1 : 0}>
      <Text>
        <Text color={isError ? theme.error : theme.agent}>
          {pending ? `${glyph.toolPending} ` : `${glyph.tool} `}
        </Text>
        <Text bold color={color}>
          {name}
        </Text>
        {args.length > 0 && <Text dimColor>{args}</Text>}
      </Text>
      {!pending && (
        <>
          <Box paddingLeft={2}>
            <Text color={isError ? theme.error : theme.agent}>{`${glyph.result} `}</Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text dimColor={!isError} color={color}>
                {failure?.summary ?? summary}
              </Text>
            </Box>
          </Box>
          {failure !== undefined ? <DetailLines lines={failure.details} isError /> : children}
        </>
      )}
    </Box>
  )
}

/** A bordered block of numbered rows. */
function CodeBox({ block }: { block: CodeBlock }): ReactElement {
  const gutter = String(block.lastNumber).length
  return (
    <Box
      borderStyle="round"
      borderDimColor
      flexDirection="column"
      paddingX={1}
      width={useBoxWidth()}
    >
      {block.rows.map((row, index) => (
        <CodeRowView key={`${index}:${row.number ?? ''}`} row={row} gutter={gutter} />
      ))}
      {block.hidden > 0 && <Text dimColor>{`… +${block.hidden} more lines`}</Text>}
    </Box>
  )
}

/** One numbered row: gutter, diff sign, then the line. */
function CodeRowView({ row, gutter }: { row: CodeRow; gutter: number }): ReactElement {
  const color = row.sign === '-' ? theme.error : row.sign === '+' ? theme.added : undefined
  const number = row.number === undefined ? '' : String(row.number)
  return (
    <Box>
      <Text dimColor>{`${number.padStart(gutter)} `}</Text>
      <Text color={color}>{row.sign === undefined ? '  ' : `${row.sign} `}</Text>
      <Box flexGrow={1} flexShrink={1}>
        <Text color={color} dimColor={row.sign === undefined}>
          {row.text}
        </Text>
      </Box>
    </Box>
  )
}

/** Plain pre-wrapped detail lines, indented under a result line. */
function DetailLines({
  lines,
  isError = false,
}: {
  lines: readonly string[]
  isError?: boolean
}): ReactElement | null {
  if (lines.length === 0) {
    return null
  }
  return (
    <Box flexDirection="column" paddingLeft={4}>
      {lines.map((line, index) => (
        <Text
          key={`${index}:${line}`}
          dimColor={!isError}
          color={isError ? theme.error : undefined}
        >
          {line}
        </Text>
      ))}
    </Box>
  )
}

/** Numbered rows for a text slice starting at `start`. */
function numberedBlock(
  text: string,
  start: number,
  max: number,
  width: number,
  total?: number,
): CodeBlock {
  const lines = splitLines(text)
  const rows = lines.slice(0, max).map((line, index) => ({
    number: start + index,
    text: truncateToWidth(line, width),
  }))
  const lastNumber = total ?? start + Math.max(0, lines.length - 1)
  return { rows, hidden: Math.max(0, lines.length - max), lastNumber }
}

interface EditChange {
  readonly line: number
  readonly before: readonly string[]
  readonly removed: readonly string[]
  readonly added: readonly string[]
  readonly after: readonly string[]
}

/** Numbered rows for an edit: context, then `-` removed, `+` added, context. */
function editBlock(change: EditChange, width: number): CodeBlock {
  const rows: CodeRow[] = []
  const beforeStart = change.line - change.before.length
  change.before.forEach((text, index) => {
    rows.push({ number: beforeStart + index, text: truncateToWidth(text, width) })
  })
  change.removed.forEach((text, index) => {
    rows.push({ number: change.line + index, sign: '-', text: truncateToWidth(text, width) })
  })
  change.added.forEach((text, index) => {
    rows.push({ number: change.line + index, sign: '+', text: truncateToWidth(text, width) })
  })
  const afterStart = change.line + change.added.length
  change.after.forEach((text, index) => {
    rows.push({ number: afterStart + index, text: truncateToWidth(text, width) })
  })
  const shown = rows.slice(0, EDIT_LINES)
  return {
    rows: shown,
    hidden: Math.max(0, rows.length - EDIT_LINES),
    lastNumber: Math.max(afterStart + change.after.length - 1, change.line),
  }
}

/** Diff hint from the call alone, when the output carries no hunk. */
function inputDiff(input: unknown, max = 2): string[] {
  const before = stringField(input, 'oldString')
  const after = stringField(input, 'newString')
  const removed =
    before === undefined ? [] : preview(before, max, 100).lines.map((line) => `- ${line}`)
  const added = after === undefined ? [] : preview(after, max, 100).lines.map((line) => `+ ${line}`)
  return [...removed, ...added]
}

/** One-line preview of a tool input or output. */
export function summarize(value: unknown): string {
  if (value === undefined) {
    return '…'
  }
  const flat =
    value instanceof Error
      ? value.message
      : typeof value === 'string'
        ? value
        : (JSON.stringify(value) ?? String(value))
  const single = flat.replace(/\s+/g, ' ').trim()
  return single.length > 120 ? `${single.slice(0, 119)}…` : single
}

/** Detail lines of a value that carries text of its own. */
function textOf(value: unknown): string[] {
  if (typeof value === 'string') {
    return preview(value, 4).lines
  }
  return value instanceof Error ? preview(value.message, 4).lines : []
}

/** An error as one summary line plus its remaining lines, without repeats. */
function splitError(output: unknown): { summary: string; details: string[] } {
  const [head = '', ...rest] = textOf(output)
  return { summary: summarize(head), details: rest }
}

/**
 * Lines of a text, cut per line, with a count for what was folded away.
 */
function preview(text: string, max: number, width = 100): { lines: string[]; hidden: number } {
  const all = splitLines(text)
  const lines = all.slice(0, max).map((line) => truncateToWidth(line, width))
  return { lines, hidden: Math.max(0, all.length - max) }
}

/** Text as lines, without leading or trailing blank ones. */
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  while (lines.length > 0 && (lines[0] ?? '').trim().length === 0) {
    lines.shift()
  }
  while (lines.length > 0 && (lines.at(-1) ?? '').trim().length === 0) {
    lines.pop()
  }
  return lines
}

/**
 * Command lines laid out for the box: `$ ` on the first, two spaces on the
 * rest, each cut to the box width so the border cannot be pushed off screen.
 */
function commandLines(command: string, width: number): string[] {
  const all = splitLines(command)
  const shown = all.slice(0, COMMAND_LINES).map((line) => truncateToWidth(line, width - 2))
  if (all.length > COMMAND_LINES) {
    shown.push(`… +${all.length - COMMAND_LINES} more lines`)
  }
  return shown.length === 0 ? [''] : shown
}

/** Lines of a text, ignoring trailing newlines. */
function lineCountOf(text: string): number {
  return splitLines(text).length
}

/** `1 line` / `2 lines`. */
function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** Text columns inside a bordered block. */
function useTextWidth(): number {
  return Math.max(20, useColumns() - BOX_CHROME)
}

/** Width of a bordered block itself: never the full terminal. */
export function useBoxWidth(): number {
  return Math.max(24, useColumns() - BOX_MARGIN)
}

function changeOf(output: unknown): EditChange | undefined {
  const change = field(output, 'change')
  if (typeof change !== 'object' || change === null) {
    return undefined
  }
  const line = numberField(change, 'line')
  if (line === undefined) {
    return undefined
  }
  return {
    line,
    before: stringArrayField(change, 'before'),
    removed: stringArrayField(change, 'removed'),
    added: stringArrayField(change, 'added'),
    after: stringArrayField(change, 'after'),
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined
}

function stringField(value: unknown, key: string): string | undefined {
  const found = field(value, key)
  return typeof found === 'string' ? found : undefined
}

function stringArrayField(value: unknown, key: string): string[] {
  const found = field(value, key)
  return Array.isArray(found)
    ? found.filter((item): item is string => typeof item === 'string')
    : []
}

function numberField(value: unknown, key: string): number | undefined {
  const found = field(value, key)
  return typeof found === 'number' ? found : undefined
}

function boolField(value: unknown, key: string): boolean {
  return field(value, key) === true
}
