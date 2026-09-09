export type ChatRole = 'user' | 'assistant'

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
}

export interface ChatRequest {
  message: string
}

export interface ChatState {
  messages: ChatMessage[]
}
