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
    const answer = await agent.ask(String(message.prompt || ''), String(message.projectRoot || ''), executeTool, Array.isArray(message.history) ? message.history : []);
    process.send?.({ id: message.id, answer, trajectory: agent.lastTrajectory });
  } catch (error) {
    process.send?.({ id: message.id, error: error?.message || String(error) });
  }
});
