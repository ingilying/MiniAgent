<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'

import { checkHealth, loadChat, sendChatMessage } from '@/services/api'
import type { ChatMessage } from '@/types/chat'

const messages = ref<ChatMessage[]>([])
const message = ref('')
const isSending = ref(false)
const isLoading = ref(true)
const isOnline = ref(false)
const error = ref('')
const chat = ref<HTMLElement>()

async function scrollToBottom() {
  await nextTick()
  chat.value?.scrollTo({ top: chat.value.scrollHeight, behavior: 'smooth' })
}

async function sendMessage() {
  const content = message.value.trim()
  if (!content || isSending.value) return

  message.value = ''
  error.value = ''
  isSending.value = true

  try {
    const state = await sendChatMessage({ message: content })
    messages.value = state.messages
    isOnline.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Something went wrong.'
    isOnline.value = false
  } finally {
    isSending.value = false
    await scrollToBottom()
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void sendMessage()
  }
}

onMounted(async () => {
  try {
    const [online, state] = await Promise.all([checkHealth(), loadChat()])
    isOnline.value = online
    messages.value = state.messages
    await scrollToBottom()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not load the chat.'
    isOnline.value = false
  } finally {
    isLoading.value = false
  }
})
</script>

<template>
  <main class="page">
    <section class="chat-card">
      <header>
        <div class="agent-avatar">A</div>
        <div>
          <h1>MiniAgent</h1>
          <p><span :class="{ online: isOnline }"></span>{{ isOnline ? 'Online' : 'Offline' }}</p>
        </div>
      </header>

      <div ref="chat" class="messages" aria-live="polite">
        <p v-if="isLoading" class="empty">Loading conversation…</p>
        <p v-else-if="messages.length === 0" class="empty">No messages yet.</p>
        <div v-for="item in messages" :key="item.id" class="message" :class="item.role">
          <span class="label">{{ item.role === 'assistant' ? 'Agent' : 'You' }}</span>
          <p>{{ item.content }}</p>
        </div>

        <div v-if="isSending" class="message assistant">
          <span class="label">Agent</span>
          <div class="typing" aria-label="Agent is responding"><i></i><i></i><i></i></div>
        </div>
      </div>

      <div v-if="error" class="error" role="alert">{{ error }}</div>

      <form class="composer" @submit.prevent="sendMessage">
        <textarea
          v-model="message"
          rows="1"
          placeholder="Message MiniAgent…"
          aria-label="Message MiniAgent"
          @keydown="handleKeydown"
        ></textarea>
        <button type="submit" :disabled="!message.trim() || isSending" aria-label="Send message">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 12 20 4l-5 16-3-6-8-2Zm8 2 2-2" />
          </svg>
        </button>
      </form>
    </section>
  </main>
</template>

<style>
:root {
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif;
  color: #1d2433;
  background: #f3f5f9;
  font-synthesis: none;
}

* {
  box-sizing: border-box;
}
body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
}
button,
textarea {
  font: inherit;
}

.page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: linear-gradient(145deg, #f7f8fb, #edf1f7);
}

.chat-card {
  width: min(720px, 100%);
  height: min(760px, calc(100vh - 48px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #e1e5ec;
  border-radius: 20px;
  background: #fff;
  box-shadow: 0 22px 60px rgb(30 43 67 / 10%);
}

header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 22px;
  border-bottom: 1px solid #edf0f4;
}

.agent-avatar {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 13px;
  color: #fff;
  background: #596ee8;
  font-weight: 700;
}

h1 {
  margin: 0 0 3px;
  font-size: 16px;
}
header p {
  margin: 0;
  color: #8a92a2;
  font-size: 12px;
}
header p span {
  width: 7px;
  height: 7px;
  display: inline-block;
  margin-right: 6px;
  border-radius: 50%;
  background: #b3b8c2;
}
header p span.online {
  background: #35bd79;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 26px 24px;
}

.empty {
  margin: 36px 0;
  color: #929aaa;
  font-size: 13px;
  text-align: center;
}

.message {
  width: fit-content;
  max-width: 78%;
  margin-bottom: 20px;
}

.message.user {
  margin-left: auto;
}
.label {
  display: block;
  margin: 0 6px 6px;
  color: #929aaa;
  font-size: 11px;
}
.message.user .label {
  text-align: right;
}
.message p,
.typing {
  margin: 0;
  padding: 12px 15px;
  border-radius: 5px 16px 16px;
  background: #f0f2f6;
  font-size: 14px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.message.user p {
  border-radius: 16px 5px 16px 16px;
  color: #fff;
  background: #596ee8;
}

.typing {
  display: flex;
  gap: 4px;
  padding: 16px;
}
.typing i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #939bab;
  animation: bounce 1s infinite ease-in-out;
}
.typing i:nth-child(2) {
  animation-delay: 150ms;
}
.typing i:nth-child(3) {
  animation-delay: 300ms;
}

.error {
  margin: 0 22px 10px;
  padding: 9px 12px;
  border-radius: 8px;
  color: #b33d4f;
  background: #fff0f2;
  font-size: 12px;
}

.composer {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  margin: 0 20px 20px;
  padding: 8px 8px 8px 15px;
  border: 1px solid #dfe3ea;
  border-radius: 14px;
  background: #fff;
}

.composer:focus-within {
  border-color: #8b99eb;
  box-shadow: 0 0 0 3px rgb(89 110 232 / 9%);
}
.composer textarea {
  width: 100%;
  max-height: 120px;
  padding: 9px 0;
  resize: none;
  border: 0;
  outline: 0;
  color: #252c3a;
  background: transparent;
  line-height: 1.45;
}
.composer textarea::placeholder {
  color: #9aa1ae;
}
.composer button {
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 10px;
  color: #fff;
  background: #596ee8;
  cursor: pointer;
}
.composer button:disabled {
  color: #aeb4c0;
  background: #eceef2;
  cursor: default;
}
.composer svg {
  width: 19px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

@keyframes bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.45;
  }
  30% {
    transform: translateY(-3px);
    opacity: 1;
  }
}

@media (max-width: 600px) {
  .page {
    padding: 0;
  }
  .chat-card {
    height: 100vh;
    border: 0;
    border-radius: 0;
  }
  .messages {
    padding: 22px 16px;
  }
  .composer {
    margin: 0 12px 12px;
  }
  .message {
    max-width: 88%;
  }
}
</style>
