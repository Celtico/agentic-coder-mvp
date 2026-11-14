// The window's own notices in a chat (a stopped generation, an error) are not part of the conversation
// with the model: they are not sent back to it as history, and not kept in the steps of a verified
// case. New ones carry `notice: true`; older chats saved before that flag are recognised by their text.
// The same list is in src/app/chat-notices.ts (the window); a test checks they agree.
const LEGACY_NOTICES = [
  /^Generació cancel·lada\. El model local es tornarà a carregar/,
  /^Error: [\s\S]*\n\nLa resposta no s’ha pogut generar\./,
  /^No s’ha pogut obrir el fitxer: /,
  /^No s’han pogut executar les comprovacions: /,
  /^Executant les comprovacions del projecte…$/,
];

function isChatNotice(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.notice === true || message.error === true) return true;
  const text = typeof message.content === 'string' ? message.content : typeof message.text === 'string' ? message.text : '';
  return message.role === 'assistant' && LEGACY_NOTICES.some((pattern) => pattern.test(text.trim()));
}

module.exports = { isChatNotice, LEGACY_NOTICES };
