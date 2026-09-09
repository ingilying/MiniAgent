/** Wire contract for one completed agent response (schema version 1). */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type ResultContent =
  | { type: 'text'; text: string; format: 'plain' | 'markdown' }
  | { type: 'image'; url: string; alt: string }
  | { type: 'file'; url: string; name: string; media_type: string }
  | { type: 'json'; data: JsonValue }

export interface AgentResult {
  schema_version: 1
  id: string
  context_id: string | null
  role: 'assistant'
  content: ResultContent[]
}
