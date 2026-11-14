// Messages of the window itself in a chat (a stopped generation, an error, checks run from the
// toolbar): shown, but not sent to the model as history and not offered as a verified case. New ones
// carry `notice: true`; chats saved before that flag are recognised by their text. The same list is in
// src/electron/chat-notices.cjs (the main process); a test checks they agree.

import type { ChatMessage } from "../types"

export const LEGACY_NOTICES = [
  /^Generació cancel·lada\. El model local es tornarà a carregar/,
  /^Error: [\s\S]*\n\nLa resposta no s’ha pogut generar\./,
  /^No s’ha pogut obrir el fitxer: /,
  /^No s’han pogut executar les comprovacions: /,
  /^Executant les comprovacions del projecte…$/,
]

export function isWindowNotice(message: Pick<ChatMessage, "role" | "text" | "error" | "notice">): boolean {
  if (message.notice === true || message.error === true) return true
  return message.role === "assistant" && LEGACY_NOTICES.some((pattern) => pattern.test(message.text.trim()))
}
