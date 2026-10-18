/** Provider used when neither the session nor the config file names one. */
export const DEFAULT_PROVIDER = 'openai'

/** Model used when neither the config file nor `OPENAI_MODEL` names one. */
export const DEFAULT_MODEL = 'gpt-6-astra'

/** Tool-loop step limit for agents the app builds. */
export const APP_MAX_STEPS = 8

/** Base system prompt every agent starts from; plugins append parts after it. */
export const SYSTEM_PROMPT =
  'You are a precise, helpful assistant. ' +
  'Use the available tools to read and change files and run shell commands.'

/**
 * System prompt for the one-shot call that names a session. The user message
 * (cut to 2000 characters) is the prompt; the answer becomes the title.
 */
export const TITLE_PROMPT =
  'Write a title for a conversation that starts with the user message below. ' +
  'Answer with the title only: plain text, at most six words, no quotes, no Markdown, ' +
  'no code fences, no trailing period, same language as the message.'
