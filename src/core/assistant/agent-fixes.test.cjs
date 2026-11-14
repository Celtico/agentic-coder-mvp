// How the agent tells the model about a bad call, when the reviewer runs, what the window keeps when the
// work is stopped, and which requests and answers count as «do something» / «only a plan».
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LocalCodingAgent } = require('./agent-runtime.cjs');

async function run(t, { request, responses, tool = async () => ({}), review = false, fallback = '{"type":"final","content":"Fet."}' }) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-fixes-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const inputs = [];
  const systems = [];
  const statuses = [];
  const engine = {
    loadModel: async () => {},
    generateResponse: async (messages) => { inputs.push(messages[messages.length - 1].content); systems.push(messages[0].content); return responses.length ? responses.shift() : fallback; },
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine, onStatus: (status) => statuses.push(status), experienceRanker: { rank: async () => [] } });
  agent.historyDir = path.join(tempRoot, 'history');
  agent.reviewChanges = review;
  const calls = [];
  const answer = await agent.ask(request, tempRoot, async (call) => { calls.push(call); return tool(call, tempRoot); });
  return { answer, inputs, systems, statuses, calls };
}

test('a known tool called without its arguments is asked again, never called «not available»', async (t) => {
  const { inputs, calls } = await run(t, {
    request: 'executa exactament: npm i @chakra-ui/react @emotion/react',
    responses: ['<tool_call>{"name": "install_package", "arguments": {}}</tool_call>', '{"type":"tool_call","name":"run_npx","arguments":{"packageName":"npm","args":["i","x"]}}'],
    tool: async (call) => (call.name === 'run_npx' ? { code: 0, output: 'ok' } : {}),
  });
  assert.match(inputs[1], /l'eina existeix, però els arguments no són correctes o falten/);
  assert.match(inputs[1], /No diguis que l'eina no està disponible/);
  assert.doesNotMatch(inputs[1], /no existeix\./);
  assert.deepEqual(calls.map((call) => call.name), ['run_npx']);
});

test('a tool that does not exist is named as such, with the list of the tools that do', async (t) => {
  const { inputs } = await run(t, {
    request: 'executa npm test',
    responses: ['{"type":"tool_call","name":"run_shell","arguments":{"command":"npm test"}}', '{"type":"tool_call","name":"run_tests"}'],
    tool: async () => ({ code: 0, output: 'ok' }),
  });
  assert.match(inputs[1], /L'eina «run_shell» no existeix/);
  assert.match(inputs[1], /run_npx/);
  assert.match(inputs[1], /run_tests/);
  assert.doesNotMatch(inputs[1], /els arguments no són correctes/);
});

test('the reviewer does not run after an install or a command that wrote no file', async (t) => {
  const { systems, answer } = await run(t, {
    request: 'executa exactament: npx @chakra-ui/cli snippet add',
    review: true,
    responses: ['{"type":"tool_call","name":"run_npx","arguments":{"packageName":"@chakra-ui/cli","args":["snippet","add"]}}', '{"type":"final","content":"L’ordre ha acabat amb codi 0."}'],
    tool: async (call) => (call.name === 'run_npx' ? { code: 0, output: 'done' } : {}),
  });
  assert.equal(systems.filter((system) => /Ets el REVISOR/.test(system)).length, 0);
  assert.match(answer, /codi 0/);
});

test('a finished answer the reviewer sends back reaches the window as a draft', async (t) => {
  const { statuses, systems } = await run(t, {
    request: 'Crea un index.html amb un títol i un botó',
    review: true,
    responses: [
      '{"type":"plan","content":"Crear index.html."}',
      '{"type":"tool_call","name":"write_file","arguments":{"path":"index.html","content":"<h1>Hola</h1>"}}',
      '{"type":"final","content":"He creat index.html."}',
      '{"ok":false,"problems":["index.html: falta el botó"]}',
      '{"type":"tool_call","name":"write_file","arguments":{"path":"index.html","content":"<h1>Hola</h1><button>Suma</button>"}}',
      '{"type":"final","content":"He creat index.html amb el botó."}',
    ],
    tool: async (call, root) => {
      if (call.name !== 'write_file') return {};
      await fs.writeFile(path.join(root, call.arguments.path), call.arguments.content);
      return { applied: true, path: call.arguments.path };
    },
  });
  assert.equal(systems.filter((system) => /Ets el REVISOR/.test(system)).length, 1, 'files were written, so the reviewer runs');
  assert.deepEqual(statuses.filter((status) => status.type === 'draft').map((status) => status.message), ['He creat index.html.']);
});

test('Catalan and Spanish verbs ask for action: an answer that is only a plan is sent back', async (t) => {
  for (const request of ['posa un Button de Chakra a App.tsx', 'embolica l’App amb el Provider', 'envuelve la App con el Provider', 'añade un botón a App.tsx', 'arrenca el servidor', 'mueve el fichero', 'reanomena main.js a main.tsx']) {
    const { inputs } = await run(t, { request, responses: ['Ho faré així: primer llegiré el fitxer, després el modificaré.'] });
    // A request to change code gets the stronger reminder that nothing was changed yet; either way it is sent back.
    assert.ok(inputs.some((input) => /Això és només el pla|Encara no has aplicat cap canvi al codi/.test(input)), request);
  }
});

test('an answer with a «Pla:» heading or that ends with «Començo.» is a plan, whatever the request', async (t) => {
  for (const answer of ['Entesos.\n\n**Pla:**\n1. Obre src/main.tsx.', 'Plan: leer el fichero.', 'Entesos, embolicaré l’App amb el Provider. Començo.', 'Lo hago ahora. Empiezo.', 'D’acord. Vaig.', 'Perfecto. Comienzo.']) {
    const { inputs } = await run(t, { request: 'si', responses: [answer] });
    assert.ok(inputs.some((input) => /Això és només el pla/.test(input)), answer);
  }
  // A plain answer to a plain message is not one.
  const plain = await run(t, { request: 'hola', responses: ['Hola! En què et puc ajudar?'] });
  assert.ok(!plain.inputs.some((input) => /Això és només el pla/.test(input)));
  assert.match(plain.answer, /Hola!/);
});

test('«posa’l en marxa» is a request to start, not a change to the code', async (t) => {
  const { inputs } = await run(t, {
    request: 'Posa’l en marxa i digues-me si la pàgina es veu.',
    responses: ['{"type":"tool_call","name":"run_tests"}', '{"type":"final","content":"Les proves passen."}'],
    tool: async () => ({ code: 0, output: 'ok' }),
  });
  assert.ok(!inputs.some((input) => /Encara no has aplicat cap canvi al codi/.test(input)));
});

test('Preferències › Model: the answer length and the steps of a task come from the agent’s settings', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-limits-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const tokens = [];
  let calls = 0;
  const engine = {
    loadModel: async () => {},
    generateResponse: async (_messages, options) => { calls += 1; tokens.push(options.max_new_tokens); return '{"type":"tool_call","name":"list_files"}'; },
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine, onStatus: () => {}, experienceRanker: { rank: async () => [] } });
  agent.historyDir = path.join(tempRoot, 'history');
  agent.answerTokens = 900;
  agent.maxIterations = 3;
  await agent.ask('llista els fitxers', tempRoot, async () => ({ files: [] }));
  assert.ok(tokens.every((value) => value === 900), JSON.stringify(tokens));
  assert.ok(calls <= 3 + 3, `a task of 3 steps stops early (${calls} generations)`);
});

test('images go with the current request’s message to the programmer only, never with the next request', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-agent-images-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const seen = [];
  const responses = ['{"type":"tool_call","name":"list_files"}', '{"type":"final","content":"És una captura del formulari."}', '{"type":"final","content":"Hola."}'];
  const engine = {
    loadModel: async () => {},
    generateResponse: async (messages, options) => { seen.push({ images: options.images, at: options.images ? messages[options.images.message] : null }); return responses.shift() ?? '{"type":"final","content":"Fet."}'; },
    getModelStatus: () => ({ modelId: 'test-model' }),
  };
  const agent = new LocalCodingAgent({ engine, onStatus: () => {}, experienceRanker: { rank: async () => [] } });
  agent.historyDir = path.join(tempRoot, 'history');
  await agent.ask('què hi ha a la captura?', tempRoot, async () => ({ files: [] }), [{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'Hola!' }], { images: ['/tmp/a.png', '/tmp/b.png'] });
  assert.ok(seen.length >= 2);
  for (const call of seen) {
    assert.deepEqual(call.images.paths, ['/tmp/a.png', '/tmp/b.png']);
    assert.deepEqual(call.at, { role: 'user', content: 'què hi ha a la captura?' }, 'the images point at this request’s message');
  }
  const before = seen.length;
  await agent.ask('i ara?', tempRoot, async () => ({ files: [] }), [{ role: 'user', content: 'què hi ha a la captura?\n\n[Imatges adjuntes: a.png]' }, { role: 'assistant', content: 'És una captura del formulari.' }]);
  assert.ok(seen.slice(before).every((call) => call.images === undefined), 'a later request carries no image');
});
