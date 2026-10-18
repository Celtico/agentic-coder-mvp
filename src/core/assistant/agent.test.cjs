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

test('shows a plan before requesting a package installation', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-plan-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture"}');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const responses = [
    '{"type":"plan","content":"Comprovar Playwright i preparar una prova de navegador."}',
    '{"type":"tool_call","name":"install_package","arguments":{"packageName":"@playwright/test","dev":true}}',
    'La instal·lació s’ha cancel·lat; no s’ha canviat cap dependència.',
  ];
  const engine = {
    loadModel: async () => {},
    generateResponse: async () => responses.shift(),
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const statuses = [];
  const agent = new LocalCodingAgent({ engine, onStatus: (status) => statuses.push(status.message) });
  agent.historyDir = path.join(tempRoot, 'history');
  const calls = [];

  const answer = await agent.ask('Afegeix comprovacions de navegador amb Playwright', projectRoot, async (tool) => {
    calls.push(tool);
    return { approved: false, cancelled: true, packageName: '@playwright/test' };
  });

  assert.ok(statuses.some((status) => status.includes('Pla: Comprovar Playwright')));
  assert.deepEqual(calls, [{ name: 'install_package', arguments: { packageName: '@playwright/test', dev: true } }]);
  assert.match(answer, /cancel·lat/i);
  assert.match(answer, /Comprovar Playwright/);
});

test('rejects package names that contain shell arguments', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-package-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture"}');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const responses = [
    '{"type":"tool_call","name":"install_package","arguments":{"packageName":"vite; rm -rf .","dev":true}}',
    'El nom no és vàlid i no s’ha intentat instal·lar cap paquet.',
  ];
  const engine = {
    loadModel: async () => {},
    generateResponse: async () => responses.shift(),
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine });
  agent.historyDir = path.join(tempRoot, 'history');
  let calls = 0;
  const answer = await agent.ask('Instal·la vite', projectRoot, async () => { calls += 1; return {}; });

  assert.equal(calls, 0);
  assert.match(answer, /no s’ha intentat/i);
});

test('routes project startup through its confirmation-gated tool', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-start-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture","scripts":{"dev":"vite"}}');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const responses = [
    '{"type":"tool_call","name":"start_project","arguments":{"script":"dev"}}',
    'L’inici s’ha cancel·lat; no s’ha iniciat cap servidor.',
  ];
  const engine = {
    loadModel: async () => {},
    generateResponse: async () => responses.shift(),
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine });
  agent.historyDir = path.join(tempRoot, 'history');
  const calls = [];

  const answer = await agent.ask('Inicia l’app', projectRoot, async (tool) => {
    calls.push(tool);
    return { started: false, approved: false, cancelled: true, script: 'dev' };
  });

  assert.deepEqual(calls, [{ name: 'start_project', arguments: { script: 'dev' } }]);
  assert.match(answer, /no s’ha iniciat cap servidor/);
});
