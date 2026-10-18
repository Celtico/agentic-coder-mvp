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

test('allows browser inspection only for local development URLs', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-browser-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture"}');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const responses = [
    '{"type":"tool_call","name":"inspect_browser","arguments":{"url":"http://localhost:5173/preview"}}',
    'La pàgina local s’ha inspeccionat i no ha registrat errors.',
  ];
  const engine = {
    loadModel: async () => {},
    generateResponse: async () => responses.shift(),
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine });
  agent.historyDir = path.join(tempRoot, 'history');
  const calls = [];

  const answer = await agent.ask('Inspecciona la pàgina local', projectRoot, async (tool) => {
    calls.push(tool);
    return { inspected: true, consoleErrors: [], pageErrors: [], requestFailures: [] };
  });

  assert.deepEqual(calls, [{ name: 'inspect_browser', arguments: { url: 'http://localhost:5173/preview' } }]);
  assert.match(answer, /errors de consola: cap/i);
});

test('returns verified browser inspection facts without asking the model to rewrite them', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-browser-result-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture"}');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  let generations = 0;
  const engine = {
    loadModel: async () => {},
    generateResponse: async () => {
      generations += 1;
      return '{"type":"tool_call","name":"inspect_browser","arguments":{"url":"http://localhost:5173/"}}';
    },
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine });
  agent.historyDir = path.join(tempRoot, 'history');
  let calls = 0;

  const answer = await agent.ask('Inspecciona la pàgina local', projectRoot, async () => {
    calls += 1;
    return {
      inspected: true,
      url: 'http://localhost:5173/',
      status: 200,
      title: 'Vite App',
      consoleErrors: [],
      pageErrors: [],
      requestFailures: [],
      screenshotPath: '/tmp/inspection.png',
      capture: 'data:image/png;base64,should-not-be-shown',
    };
  });

  assert.equal(calls, 1);
  assert.equal(generations, 1);
  assert.match(answer, /HTTP 200/);
  assert.match(answer, /Títol: Vite App/);
  assert.match(answer, /Errors de consola: cap/);
  assert.match(answer, /Captura: \/tmp\/inspection\.png/);
  assert.doesNotMatch(answer, /base64|should-not-be-shown/);
});

test('uses only relevant, user-confirmed experiences from the same project', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-learning-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  const otherProject = path.join(tempRoot, 'other-project');
  const experiencesPath = path.join(tempRoot, 'verified-experiences.jsonl');
  await fs.mkdir(projectRoot);
  await fs.mkdir(otherProject);
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture"}');
  const realProjectRoot = await fs.realpath(projectRoot);
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const records = [
    { projectPath: realProjectRoot, verification: 'user-confirmed', prompt: 'Configurar alias Vite per TypeScript', answer: 'Cas confirmat: definir paths a tsconfig.', evidence: 'npm run check correcte' },
    { projectPath: otherProject, verification: 'user-confirmed', prompt: 'Configurar alias Vite per TypeScript', answer: 'Dada privada d’un altre projecte', evidence: 'test correcte' },
    { projectPath: realProjectRoot, verification: 'unconfirmed', prompt: 'Configurar alias Vite per TypeScript', answer: 'Cas encara no confirmat', evidence: 'test correcte' },
    { projectPath: realProjectRoot, verification: 'user-confirmed', prompt: 'Canviar el color del botó verd', answer: 'Cas no relacionat', evidence: 'captura revisada' },
  ];
  await fs.writeFile(experiencesPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');

  let systemPrompt = '';
  const engine = {
    loadModel: async () => {},
    generateResponse: async (messages) => {
      systemPrompt = messages[0].content;
      return '{"type":"final","content":"Tasca completada."}';
    },
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine, verifiedExperiencesPath: experiencesPath });
  agent.historyDir = path.join(tempRoot, 'history');

  await agent.ask('Com configurar alias de Vite en TypeScript', projectRoot, async () => ({}));

  assert.match(systemPrompt, /Cas confirmat: definir paths a tsconfig/);
  assert.doesNotMatch(systemPrompt, /Dada privada d’un altre projecte/);
  assert.doesNotMatch(systemPrompt, /Cas encara no confirmat/);
  assert.doesNotMatch(systemPrompt, /Cas no relacionat/);
});

test('rejects browser inspection for non-local URLs', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-remote-browser-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture"}');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const responses = [
    '{"type":"tool_call","name":"inspect_browser","arguments":{"url":"https://example.com"}}',
    'No s’ha obert cap adreça externa.',
  ];
  const engine = {
    loadModel: async () => {},
    generateResponse: async () => responses.shift(),
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine });
  agent.historyDir = path.join(tempRoot, 'history');
  let calls = 0;

  await agent.ask('Inspecciona la web', projectRoot, async () => { calls += 1; return {}; });
  assert.equal(calls, 0);
});

test('does not repeat an identical browser inspection and asks for a final answer', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-repeat-browser-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture"}');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const responses = [
    '{"type":"tool_call","name":"inspect_browser","arguments":{"url":"http://localhost:5173/"}}',
    '{"type":"tool_call","name":"inspect_browser","arguments":{"url":"http://localhost:5173/"}}',
    '{"type":"final","content":"La pàgina ha respost amb HTTP 200 i no hi ha errors."}',
  ];
  const engine = {
    loadModel: async () => {},
    generateResponse: async () => responses.shift(),
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine });
  agent.historyDir = path.join(tempRoot, 'history');
  const calls = [];

  const answer = await agent.ask('Inspecciona la pàgina local', projectRoot, async (tool) => {
    calls.push(tool);
    return { status: 200, consoleErrors: [], pageErrors: [], requestFailures: [] };
  });

  assert.equal(calls.length, 1);
  assert.match(answer, /HTTP 200/);
});
