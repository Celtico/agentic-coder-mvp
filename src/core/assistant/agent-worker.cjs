const { LocalCodingAgent } = require('./agent-runtime.cjs');

const agent = new LocalCodingAgent({ onStatus: (value) => process.send?.({ type: 'status', value }) });
const pendingTools = new Map();
let nextToolId = 0;

process.once('SIGTERM', () => {
  void agent.unloadModel().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});

process.on('message', async (message) => {
  if (message?.type === 'tool-result' && typeof message.id === 'number' && typeof message.toolId === 'number') {
    const key = `${message.id}:${message.toolId}`;
    const pending = pendingTools.get(key);
    if (pending) { pendingTools.delete(key); pending.resolve(message.result); }
    return;
  }
  if (!message || typeof message.id !== 'number') return;
  // Preferències › Model and Agent, already checked by the main process (src/electron/preferences.cjs).
  const settings = message.settings && typeof message.settings === 'object' ? message.settings : {};
  if (Number.isInteger(settings.answerTokens)) agent.answerTokens = settings.answerTokens;
  if (Number.isInteger(settings.maxIterations)) agent.maxIterations = settings.maxIterations;
  if (typeof settings.review === 'boolean') agent.reviewChanges = settings.review;
  if (typeof settings.webSearch === 'boolean') agent.webSearch = settings.webSearch;
  try {
    const executeTool = (tool) => new Promise((resolve, reject) => {
      const toolId = ++nextToolId;
      const key = `${message.id}:${toolId}`;
      pendingTools.set(key, { resolve, reject });
      process.send?.({ type: 'tool-call', id: message.id, toolId, tool, projectRoot: String(message.projectRoot || '') }, (error) => {
        if (!error) return;
        pendingTools.delete(key);
        reject(error);
      });
    });
    // Images of this request: files the main process wrote and checked (src/electron/chat-images.cjs).
    const images = Array.isArray(message.images) ? message.images.filter((item) => typeof item === 'string').slice(0, 4) : [];
    const answer = await agent.ask(String(message.prompt || ''), String(message.projectRoot || ''), executeTool, Array.isArray(message.history) ? message.history : [], images.length ? { images } : {});
    process.send?.({ id: message.id, answer, trajectory: agent.lastTrajectory });
  } catch (error) {
    process.send?.({ id: message.id, error: error?.message || String(error) });
  }
});
