const { LocalCodingAgent } = require('./agent.cjs');

const agent = new LocalCodingAgent({ onStatus: (value) => process.send?.({ type: 'status', value }) });
process.on('message', async (message) => {
  if (!message || typeof message.id !== 'number') return;
  try {
    const answer = await agent.ask(String(message.prompt || ''), String(message.projectRoot || ''));
    process.send?.({ id: message.id, answer });
  } catch (error) {
    process.send?.({ id: message.id, error: error?.message || String(error) });
  }
});
