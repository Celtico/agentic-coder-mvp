export type RecoverableHistoryEntry = { prompt: string; answer: string; at?: string };
export type RecoverableChatMessage = { role: 'user' | 'assistant'; text: string; error?: boolean };
export type RecoverableChatSession = {
  id: string;
  title: string;
  updatedAt: string;
  messages: RecoverableChatMessage[];
};

const RECOVERED_SESSION_ID = 'agentic-completed-history-v1';
const MAX_MESSAGES = 100;
const MAX_SESSIONS = 50;

function pairKey(prompt: string, answer: string): string {
  return JSON.stringify([prompt, answer]);
}

function collectSavedPairs(sessions: RecoverableChatSession[]): Set<string> {
  const pairs = new Set<string>();
  for (const session of sessions) {
    let pendingPrompt: string | null = null;
    for (const message of session.messages) {
      if (message.role === 'user') pendingPrompt = message.text;
      else if (message.role === 'assistant' && pendingPrompt !== null) {
        pairs.add(pairKey(pendingPrompt, message.text));
        pendingPrompt = null;
      }
    }
  }
  return pairs;
}

/** Add completed local agent exchanges that are missing from the UI's persisted sessions. */
export function recoverCompletedHistory(
  sessions: RecoverableChatSession[],
  entries: RecoverableHistoryEntry[],
): RecoverableChatSession[] {
  const knownPairs = collectSavedPairs(sessions);
  const recovered: RecoverableChatMessage[] = [];
  let latestAt = '';

  for (const entry of entries) {
    if (!entry || typeof entry.prompt !== 'string' || typeof entry.answer !== 'string') continue;
    const prompt = entry.prompt.trim();
    const answer = entry.answer.trim();
    if (!prompt || !answer || prompt.length > 12000 || answer.length > 30000) continue;
    const key = pairKey(prompt, answer);
    if (knownPairs.has(key)) continue;
    knownPairs.add(key);
    recovered.push({ role: 'user', text: prompt }, { role: 'assistant', text: answer });
    if (typeof entry.at === 'string' && entry.at > latestAt) latestAt = entry.at;
  }

  if (recovered.length === 0) return sessions;

  const previous = sessions.find((session) => session.id === RECOVERED_SESSION_ID);
  const messages = [...(previous?.messages || []), ...recovered].slice(-MAX_MESSAGES);
  const recoveredSession: RecoverableChatSession = {
    id: RECOVERED_SESSION_ID,
    title: 'Historial recuperat',
    updatedAt: latestAt || new Date().toISOString(),
    messages,
  };
  return [recoveredSession, ...sessions.filter((session) => session.id !== RECOVERED_SESSION_ID)].slice(0, MAX_SESSIONS);
}
