import { Box, Text } from 'ink'
import type { ReactElement } from 'react'

import { Markdown } from './markdown.js'
import type { MenuItem } from './menu.js'
import { glyph, theme } from './theme.js'
import { toolView } from './tool-views.js'
import type { LiveTool, TranscriptLine } from './transcript.js'
import { WelcomeArt, WelcomeBox } from './welcome.js'

/**
 * One finished transcript row. Each event kind has its own component, so a
 * reasoning block, a tool call, and an error never share a glyph or layout.
 */
export function TranscriptRow({ line }: { line: TranscriptLine }): ReactElement {
  switch (line.kind) {
    case 'user':
      return <UserMessage text={line.text} />
    case 'assistant':
      return <AssistantMessage text={line.text} />
    case 'reasoning':
      return <ReasoningMessage text={line.text} />
    case 'tool':
      return (
        <ToolMessage
          toolName={line.toolName}
          input={line.input}
          output={line.output}
          isError={line.isError}
          spaced={line.spaced}
        />
      )
    case 'error':
      return <ErrorMessage text={line.text} />
    case 'system':
      return <NoticeMessage text={line.text} />
    case 'art':
      return <WelcomeArt text={line.text} />
    case 'welcome':
      return <WelcomeBox subtitle={line.text} />
  }
}

/**
 * A submitted prompt. The text sits in its own box, so wrapped lines line up
 * under the first one instead of running back to the left margin.
 */
export function UserMessage({ text }: { text: string }): ReactElement {
  return (
    <Box marginTop={1}>
      <Text bold color={theme.accent}>
        {`${glyph.prompt} `}
      </Text>
      <Box flexGrow={1} flexShrink={1}>
        <Text>{text}</Text>
      </Box>
    </Box>
  )
}

/**
 * Answer text of one phase, once it stopped streaming: rendered Markdown.
 * The answer bullet rides on the first line, so code fences and lists below
 * it keep the full width instead of inheriting a hanging indent.
 */
export function AssistantMessage({ text }: { text: string }): ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      <Markdown text={text} prefix={<Text color={theme.answer}>{`${glyph.answer} `}</Text>} />
    </Box>
  )
}

/** Provider reasoning, kept visually apart from the answer it led to. */
export function ReasoningMessage({ text }: { text: string }): ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor italic>
        {`${glyph.reasoning} Thinking`}
      </Text>
      <Box paddingLeft={2} flexShrink={1}>
        <Text dimColor italic>
          {text}
        </Text>
      </Box>
    </Box>
  )
}

/**
 * One tool call with its details below it. The tool's own view draws it when
 * one exists; otherwise the generic input/output view does.
 */
export function ToolMessage({
  toolName,
  input,
  output,
  isError,
  spaced,
}: {
  toolName: string
  input: unknown
  output: unknown
  isError: boolean
  spaced: boolean
}): ReactElement {
  const View = toolView(toolName)
  return (
    <View
      toolName={toolName}
      input={input}
      output={output}
      isError={isError}
      pending={false}
      spaced={spaced}
    />
  )
}

/** A failed run. */
export function ErrorMessage({ text }: { text: string }): ReactElement {
  return (
    <Box marginTop={1}>
      <Text color={theme.error}>{`${glyph.error} `}</Text>
      <Box flexGrow={1} flexShrink={1}>
        <Text color={theme.error}>{text}</Text>
      </Box>
    </Box>
  )
}

/** Output of a slash command. */
export function NoticeMessage({ text }: { text: string }): ReactElement {
  return (
    <Box paddingLeft={1} marginTop={1}>
      <Text dimColor>{text}</Text>
    </Box>
  )
}

/**
 * Answer text still streaming: Markdown as it arrives, with the cursor riding
 * on the last line. An unfinished fence or emphasis renders literally until
 * its closing marker shows up, which is the honest thing to show mid-stream.
 */
export function LiveAnswer({ text }: { text: string }): ReactElement {
  return (
    <Box marginTop={1} flexDirection="column">
      <Markdown
        text={text}
        prefix={<Text color={theme.answer}>{`${glyph.answer} `}</Text>}
        suffix={<Text dimColor>{glyph.cursor}</Text>}
      />
    </Box>
  )
}

/**
 * Reasoning still streaming. Only the tail shows: a long thinking block
 * would otherwise push the input box off screen.
 */
export function LiveReasoning({ text }: { text: string }): ReactElement {
  return (
    <Box marginTop={1}>
      <Text dimColor italic>
        {`${glyph.reasoning} ${tail(text)}`}
      </Text>
    </Box>
  )
}

/** A tool call the run has not answered yet. */
export function LiveToolCall({ tool }: { tool: LiveTool }): ReactElement {
  const View = toolView(tool.toolName)
  return (
    <View
      toolName={tool.toolName}
      input={tool.input}
      output={undefined}
      isError={false}
      pending
      spaced={false}
    />
  )
}

/** Selectable candidate list under the input box; the highlight wraps. */
export function CandidateMenu({
  items,
  selected,
}: {
  items: readonly MenuItem[]
  selected: number
}): ReactElement {
  return (
    <Box paddingX={1} flexDirection="column">
      {items.map((item, index) =>
        index === selected ? (
          <Text key={`${index}:${item.label}`} bold color={theme.accent}>
            {`❯ ${item.label}${item.hint.length > 0 ? ` — ${item.hint}` : ''}`}
          </Text>
        ) : (
          <Text key={`${index}:${item.label}`} dimColor>
            {`  ${item.label}${item.hint.length > 0 ? ` — ${item.hint}` : ''}`}
          </Text>
        ),
      )}
    </Box>
  )
}

/** Claude Code style input: rules above and below, prompt row, no box. */
export function InputBox({
  input,
  hasTyped,
  pending,
}: {
  input: string
  hasTyped: boolean
  pending: number
}): ReactElement {
  return (
    <Box
      borderStyle="single"
      borderTop
      borderBottom
      borderLeft={false}
      borderRight={false}
      borderDimColor
      paddingX={1}
    >
      <Text bold color={pending > 0 ? 'yellow' : theme.accent}>
        {`${glyph.prompt} `}
      </Text>
      {input.length > 0 ? (
        <>
          <Text>{input}</Text>
          <Text dimColor>{glyph.cursor}</Text>
        </>
      ) : (
        <>
          <Text dimColor>{glyph.cursor}</Text>
          {!hasTyped && <Text dimColor>Try &quot;explain this project&quot;</Text>}
        </>
      )}
    </Box>
  )
}

/** Last `max` characters of the flattened text, for the live reasoning line. */
function tail(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `…${flat.slice(-max)}` : flat
}
