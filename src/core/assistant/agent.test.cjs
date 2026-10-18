const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LocalCodingAgent } = require('./agent-runtime.cjs');

test('executes a tool call wrapped in an explanatory Markdown response', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture"}');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const responses = [
    'Per inspeccionar el fitxer, faig servir aquesta eina:\n\n```json\n{"type":"tool_call","name":"read_file","arguments":{"path":"src/App.vue"}}\n```',
    'El fitxer defineix un component Vue que mostra un logotip i el component HelloWorld.',
  ];
  const engine = {
    loadModel: async () => {},
    generateResponse: async () => responses.shift(),
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine });
  agent.historyDir = path.join(tempRoot, 'history');
  const calls = [];

  const answer = await agent.ask('Llegeix src/App.vue', projectRoot, async (tool) => {
    calls.push(tool);
    return { content: '<template><img /><HelloWorld /></template>' };
  });

  assert.deepEqual(calls, [{ name: 'read_file', arguments: { path: 'src/App.vue' } }]);
  assert.match(answer, /HelloWorld/);
});
