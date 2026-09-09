import type { ChatRequest, ChatState } from '@/types/chat'

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '')

async function getErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: string; message?: string }
    return body.detail ?? body.message ?? `Request failed with status ${response.status}.`
  } catch {
    return `Request failed with status ${response.status}.`
  }
}

export async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/health`, {
      headers: { Accept: 'application/json' },
    })
    return response.ok
  } catch {
    return false
  }
}

function parseChatState(body: unknown): ChatState {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('messages' in body) ||
    !Array.isArray(body.messages)
  ) {
    throw new Error('FastAPI returned an invalid chat state.')
  }
  return body as ChatState
}

export async function loadChat(): Promise<ChatState> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}/chat`, {
      headers: { Accept: 'application/json' },
    })
  } catch {
    throw new Error('Could not reach FastAPI. Make sure it is running on port 8000.')
  }

  if (!response.ok) throw new Error(await getErrorMessage(response))
  return parseChatState(await response.json())
}

export async function sendChatMessage(request: ChatRequest): Promise<ChatState> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}/chat`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
  } catch {
    throw new Error('Could not reach FastAPI. Make sure it is running on port 8000.')
  }

  if (!response.ok) throw new Error(await getErrorMessage(response))
  return parseChatState(await response.json())
}
