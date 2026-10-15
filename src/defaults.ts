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
