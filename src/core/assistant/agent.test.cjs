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

test('starts the first tool when a small model concatenates multiple JSON actions', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-concatenated-actions-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture"}');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const responses = [
    '{"type":"tool_call","name":"read_file","arguments":{"path":"src/App.vue"}}; {"type":"tool_call","name":"search_text","arguments":{"query":"hello"}}',
    '{"type":"final","content":"He llegit el fitxer i he comprovat la cerca."}',
  ];
  const engine = {
    loadModel: async () => {},
    generateResponse: async () => responses.shift(),
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine });
  agent.historyDir = path.join(tempRoot, 'history');
  const calls = [];

  const answer = await agent.ask('Llegeix el fitxer i després cerca hello', projectRoot, async (tool) => {
    calls.push(tool);
    return { path: 'src/App.vue', content: '<template>hello</template>' };
  });

  assert.deepEqual(calls, [{ name: 'read_file', arguments: { path: 'src/App.vue' } }]);
  assert.match(answer, /he comprovat la cerca/i);
});

test('routes a requested Git commit through the confirmation gated commit tool', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-commit-test-'));
  await fs.writeFile(path.join(tempRoot, 'package.json'), '{"name":"fixture"}');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const responses = [
    '{"type":"plan","content":"Revisaré els canvis de Git i crearé el commit després de la confirmació."}',
    '{"type":"tool_call","name":"create_git_commit","arguments":{"message":"Actualitza el projecte"}}',
    '{"type":"final","content":"El commit s’ha creat després de la confirmació."}',
  ];
  const engine = { loadModel: async () => {}, generateResponse: async () => responses.shift(), getModelStatus: () => ({ modelId: 'test-model' }) };
  const agent = new LocalCodingAgent({ engine });
  agent.historyDir = path.join(tempRoot, 'history');
  const calls = [];

  const answer = await agent.ask('Fes un commit del projecte', tempRoot, async (tool) => {
    calls.push(tool);
    return { committed: true, message: tool.arguments.message };
  });

  assert.deepEqual(calls, [{ name: 'create_git_commit', arguments: { message: 'Actualitza el projecte' } }]);
  assert.match(answer, /commit s’ha creat/i);
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

test('continues after a plan, fixes a failing check and allows the check to run again', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-repair-cycle-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture","scripts":{"test":"node --test"}}');
  await fs.writeFile(path.join(projectRoot, 'src/math.js'), 'function add(a, b) { return a + b; }');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const responses = [
    '{"type":"plan","content":"Llegeix src/math.js; canvia add; executa npm test i corregeix qualsevol error."}',
    '{"type":"tool_call","name":"read_file","arguments":{"path":"src/math.js"}}',
    '{"type":"tool_call","name":"write_file","arguments":{"path":"src/math.js","content":"function add(a, b) { return a + b + 1; }"}}',
    '{"type":"tool_call","name":"run_tests"}',
    '{"type":"tool_call","name":"read_file","arguments":{"path":"src/math.test.js"}}',
    '{"type":"tool_call","name":"write_file","arguments":{"path":"src/math.js","content":"function add(a, b) { return a + b + 1; }\\nmodule.exports = { add };"}}',
    '{"type":"final","content":"La prova ha passat després de corregir el codi."}',
  ];
  const prompts = [];
  const engine = {
    loadModel: async () => {},
    generateResponse: async (messages) => { prompts.push(messages.map((message) => message.content).join('\n')); return responses.shift(); },
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine });
  agent.historyDir = path.join(tempRoot, 'history');
  const calls = [];
  let testRuns = 0;

  const answer = await agent.ask('Corregeix add perquè add(2, 2) retorni 5 i fes passar les proves.', projectRoot, async (tool) => {
    calls.push(tool.name);
    if (tool.name === 'read_file') return { path: tool.arguments.path, content: 'function add(a, b) { return a + b; }' };
    if (tool.name === 'write_file') return { applied: true, path: tool.arguments.path };
    if (tool.name === 'run_tests') {
      testRuns += 1;
      return testRuns === 1 ? { code: 1, output: 'AssertionError: 4 !== 5' } : { code: 0, output: 'tests 1, pass 1, fail 0' };
    }
    return {};
  });

  assert.deepEqual(calls, ['read_file', 'write_file', 'run_tests', 'read_file', 'write_file', 'run_tests']);
  assert.equal(testRuns, 2);
  assert.ok(prompts.some((prompt) => prompt.includes('La comprovació ha fallat') && prompt.includes('corregeix')));
  assert.ok(prompts.some((prompt) => prompt.includes('Revalidació automàtica') && prompt.includes('passat')));
  assert.match(answer, /prova ha passat/);
});

test('does not accept a premature final answer before requested edits and checks', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-completion-guard-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture"}');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const responses = [
    '{"type":"plan","content":"Inspeccionar, corregir src/math.js y pasar npm test."}',
    '{"type":"tool_call","name":"list_files"}',
    '{"type":"final","content":"La tarea està acabada."}',
    '{"type":"tool_call","name":"write_file","arguments":{"path":"src/math.js","content":"function add(a, b) { return a + b + 1; }"}}',
    '{"type":"tool_call","name":"run_tests"}',
    '{"type":"final","content":"He corregit el fitxer i npm test ha passat."}',
  ];
  const prompts = [];
  const engine = {
    loadModel: async () => {},
    generateResponse: async (messages) => { prompts.push(messages.at(-1)?.content || ''); return responses.shift(); },
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine });
  agent.historyDir = path.join(tempRoot, 'history');
  const calls = [];

  const answer = await agent.ask('Corregeix el bug de src/math.js i executa npm test.', projectRoot, async (tool) => {
    calls.push(tool.name);
    if (tool.name === 'write_file') return { applied: true };
    if (tool.name === 'run_tests') return { code: 0, output: 'pass 1, fail 0' };
    return { files: ['src/math.js'] };
  });

  assert.deepEqual(calls, ['list_files', 'write_file', 'run_tests']);
  assert.ok(prompts.some((prompt) => prompt.includes('Encara no has aplicat cap canvi')));
  assert.match(answer, /npm test ha passat/);
});

test('reports a coding task as incomplete when the model never applies an edit', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-incomplete-task-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture"}');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const responses = [
    '{"type":"plan","content":"Llegir src/math.js, corregir add i passar les proves."}',
    '{"type":"tool_call","name":"read_file","arguments":{"path":"src/math.js"}}',
    '{"type":"final","content":"He acabat; add ja retorna 5."}',
    '{"type":"final","content":"Tot està corregit i validat."}',
    '{"type":"final","content":"La tasca està acabada."}',
  ];
  const prompts = [];
  const engine = {
    loadModel: async () => {},
    generateResponse: async (messages) => { prompts.push(messages.at(-1)?.content || ''); return responses.shift(); },
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine });
  agent.historyDir = path.join(tempRoot, 'history');
  const calls = [];

  const answer = await agent.ask('Corregeix el bug de src/math.js i executa les proves.', projectRoot, async (tool) => {
    calls.push(tool.name);
    return { path: tool.arguments.path, content: 'function add(a, b) { return a + b; }' };
  });

  assert.deepEqual(calls, ['read_file']);
  assert.ok(prompts.some((prompt) => prompt.includes('Encara no has aplicat cap canvi')));
  assert.match(answer, /no s’ha aplicat cap canvi/i);
  assert.doesNotMatch(answer, /he acabat|tot està corregit|tasca està acabada/i);
});

test('keeps duplicate tool calls from bypassing the incomplete task report', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-incomplete-duplicate-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture"}');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const responses = [
    '{"type":"plan","content":"Llegir, corregir i provar src/math.js."}',
    '{"type":"tool_call","name":"read_file","arguments":{"path":"src/math.js"}}',
    '{"type":"tool_call","name":"run_tests"}',
    '{"type":"tool_call","name":"write_file","arguments":{"path":"src/math.js","content":"function add(a,b){return a+b+1;}"}}',
    '{"type":"tool_call","name":"read_file","arguments":{"path":"src/math.js"}}',
    '{"type":"final","content":"La tasca està acabada i les proves han passat."}',
  ];
  const engine = {
    loadModel: async () => {},
    generateResponse: async () => responses.shift(),
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine });
  agent.historyDir = path.join(tempRoot, 'history');
  const calls = [];

  const answer = await agent.ask('Corregeix el bug de src/math.js i executa npm test.', projectRoot, async (tool) => {
    calls.push(tool.name);
    if (tool.name === 'run_tests') return { code: 1, output: 'AssertionError: expected 5, received 4' };
    if (tool.name === 'write_file') return { applied: false, cancelled: true };
    return { path: 'src/math.js', content: 'function add(a,b){return a+b;}' };
  });

  assert.deepEqual(calls, ['read_file', 'run_tests', 'write_file']);
  assert.match(answer, /no s’ha aplicat cap canvi/i);
  assert.doesNotMatch(answer, /tasca està acabada|les proves han passat/i);
});

test('redirects a duplicate failed test request toward reading and repairing the code', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-failed-check-repair-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture"}');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const responses = [
    '{"type":"tool_call","name":"run_tests"}',
    '{"type":"tool_call","name":"run_tests"}',
    '{"type":"tool_call","name":"read_file","arguments":{"path":"src/math.js"}}',
    '{"type":"tool_call","name":"write_file","arguments":{"path":"src/math.js","content":"function add(a, b) { return a + b + 1; }"}}',
    '{"type":"final","content":"He corregit el codi i les proves han passat."}',
  ];
  const prompts = [];
  const engine = {
    loadModel: async () => {},
    generateResponse: async (messages) => { prompts.push(messages.at(-1)?.content || ''); return responses.shift(); },
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine });
  agent.historyDir = path.join(tempRoot, 'history');
  const calls = [];
  let testRuns = 0;

  const answer = await agent.ask('Corregeix el bug a src/math.js i executa npm test.', projectRoot, async (tool) => {
    calls.push(tool.name);
    if (tool.name === 'run_tests') {
      testRuns += 1;
      return testRuns === 1 ? { code: 1, output: 'AssertionError: expected 5, received 4' } : { code: 0, output: 'pass 1, fail 0' };
    }
    if (tool.name === 'read_file') return { path: tool.arguments.path, content: 'function add(a, b) { return a + b; }' };
    return { applied: true };
  });

  assert.deepEqual(calls, ['run_tests', 'read_file', 'write_file', 'run_tests']);
  assert.equal(testRuns, 2);
  assert.ok(prompts.some((prompt) => prompt.includes('No la repeteixis encara')));
  assert.match(answer, /les proves han passat/);
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

test('routes proposed file deletion through the confirmation-gated tool', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-delete-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'unused.txt'), 'safe to remove');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const responses = [
    '{"type":"tool_call","name":"delete_file","arguments":{"path":"unused.txt"}}',
    'He cancel·lat l’eliminació; no s’ha esborrat el fitxer.',
  ];
  const engine = {
    loadModel: async () => {},
    generateResponse: async () => responses.shift(),
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine });
  agent.historyDir = path.join(tempRoot, 'history');
  const calls = [];

  const answer = await agent.ask('Elimina unused.txt', projectRoot, async (tool) => {
    calls.push(tool);
    return { deleted: false, denied: true, path: 'unused.txt' };
  });

  assert.deepEqual(calls, [{ name: 'delete_file', arguments: { path: 'unused.txt' } }]);
  assert.equal(await fs.readFile(path.join(projectRoot, 'unused.txt'), 'utf8'), 'safe to remove');
  assert.match(answer, /no s’ha esborrat el fitxer/);
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
  const agent = new LocalCodingAgent({ engine, verifiedExperiencesPath: experiencesPath, experienceRanker: {
    rank: async (_prompt, values) => values.filter((value) => value.prompt.includes('alias')).map((value) => ({ ...value, score: 0.9 })),
  } });
  agent.historyDir = path.join(tempRoot, 'history');

  await agent.ask('Com configurar alias de Vite en TypeScript', projectRoot, async () => ({}));

  assert.match(systemPrompt, /Cas confirmat: definir paths a tsconfig/);
  assert.doesNotMatch(systemPrompt, /Dada privada d’un altre projecte/);
  assert.doesNotMatch(systemPrompt, /Cas encara no confirmat/);
  assert.doesNotMatch(systemPrompt, /Cas no relacionat/);
});

test('respects root and nested gitignore rules when collecting project context', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-gitignore-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(path.join(projectRoot, 'build'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'src', 'generated'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'docs'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, '.gitignore'), 'ignored.json\nbuild/\n**/temp?.ts\nsecret-*.json\n!secret-public.json\ndocs/*.draft.md\n');
  await fs.writeFile(path.join(projectRoot, 'src', '.gitignore'), 'generated/\n');
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture"}');
  await fs.writeFile(path.join(projectRoot, 'ignored.json'), 'PRIVATE_IGNORED_JSON');
  await fs.writeFile(path.join(projectRoot, 'secret-private.json'), 'PRIVATE_SECRET_JSON');
  await fs.writeFile(path.join(projectRoot, 'secret-public.json'), '{"visible":"re-included"}');
  await fs.writeFile(path.join(projectRoot, 'build', 'bundle.ts'), 'PRIVATE_BUILD_OUTPUT');
  await fs.writeFile(path.join(projectRoot, 'src', 'temp1.ts'), 'PRIVATE_TEMP_FILE');
  await fs.writeFile(path.join(projectRoot, 'src', 'temp12.ts'), 'VISIBLE_TEMP12');
  await fs.writeFile(path.join(projectRoot, 'src', 'generated', 'types.ts'), 'PRIVATE_GENERATED_TYPES');
  await fs.writeFile(path.join(projectRoot, 'docs', 'release.draft.md'), 'PRIVATE_DRAFT_DOCUMENT');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  let systemPrompt = '';
  const engine = {
    loadModel: async () => {},
    generateResponse: async (messages) => {
      systemPrompt = messages[0].content;
      return '{"type":"final","content":"Context preparat."}';
    },
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine });
  agent.historyDir = path.join(tempRoot, 'history');

  await agent.ask('Resumeix l’estructura del projecte', projectRoot, async () => ({}));

  assert.match(systemPrompt, /secret-public\.json/);
  assert.match(systemPrompt, /VISIBLE_TEMP12/);
  for (const ignored of ['ignored.json', 'PRIVATE_IGNORED_JSON', 'PRIVATE_SECRET_JSON', 'build/', 'PRIVATE_BUILD_OUTPUT', 'temp1.ts', 'PRIVATE_TEMP_FILE', 'generated/', 'PRIVATE_GENERATED_TYPES', 'release.draft.md', 'PRIVATE_DRAFT_DOCUMENT']) {
    assert.doesNotMatch(systemPrompt, new RegExp(ignored.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('prioritizes project instructions and manifests before alphabetically early filler files', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-context-priority-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(projectRoot);
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"name":"priority-fixture"}');
  await fs.writeFile(path.join(projectRoot, 'AGENTS.md'), 'UNIQUE_AGENT_INSTRUCTIONS_MARKER');
  await fs.writeFile(path.join(projectRoot, 'README.md'), 'UNIQUE_PROJECT_README_MARKER');
  await Promise.all(Array.from({ length: 6 }, (_, index) =>
    fs.writeFile(path.join(projectRoot, `a-filler-${index}.md`), `FILLER_${index}\n${'x'.repeat(5000)}`)));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  let systemPrompt = '';
  const engine = {
    loadModel: async () => {},
    generateResponse: async (messages) => { systemPrompt = messages[0].content; return 'Context preparat.'; },
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine });
  agent.historyDir = path.join(tempRoot, 'history');

  await agent.ask('Resumeix el projecte segons les seves instruccions', projectRoot, async () => ({}));

  assert.match(systemPrompt, /UNIQUE_AGENT_INSTRUCTIONS_MARKER/);
  assert.match(systemPrompt, /UNIQUE_PROJECT_README_MARKER/);
  assert.match(systemPrompt, /priority-fixture/);
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
