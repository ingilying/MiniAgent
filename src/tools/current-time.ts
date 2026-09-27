import { tool } from 'ai'
import { z } from 'zod'

export const getCurrentTimeTool = tool({
  description: 'Get the current date and time, optionally in a specific IANA time zone.',
  inputSchema: z.object({
    timeZone: z
      .string()
      .optional()
      .describe(
        'IANA time zone identifier such as "Asia/Seoul" or "America/New_York". ' +
          'Defaults to the system time zone.',
      ),
  }),
  execute: async ({ timeZone }) => {
    const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const now = new Date()

    let formatted: string
    try {
      formatted = new Intl.DateTimeFormat('en-US', {
        dateStyle: 'full',
        timeStyle: 'long',
        timeZone: zone,
      }).format(now)
    } catch {
      throw new Error(`Unknown IANA time zone: "${timeZone ?? ''}"`)
    }

    return { iso: now.toISOString(), timeZone: zone, formatted }
  },
})
