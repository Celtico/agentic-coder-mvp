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

test('a tool call is never published as the plan, not even one to a tool that does not exist («plan»)', async (t) => {
  const { statuses } = await run(t, {
    request: 'corregeix el botó de reiniciar de src/App.jsx',
    responses: [
      '{"type":"tool_call","name":"read_file","arguments":{"path":"src/App.jsx"}}',
      '<tool_call>{"name": "plan", "arguments": {}}</tool_call>',
    ],
    tool: async () => ({ path: 'src/App.jsx', content: 'export default function App() { return null }' }),
  });
  const plans = statuses.filter((status) => status.type === 'plan').map((status) => status.message);
  // The planning step answered with a call to «plan» (a tool that does not exist): the default plan is shown.
  assert.deepEqual(plans, ['Inspeccionaré el projecte, aplicaré els canvis demanats i comprovaré el resultat.']);
  for (const plan of plans) {
    assert.doesNotMatch(plan, /<tool_call>|<\/tool_call>|"name"\s*:/);
    assert.ok(plan.trim().length > 0);
  }
});

test('withoutToolCalls keeps the prose and drops every call, tag and action object', () => {
  const { withoutToolCalls } = require('./agent-runtime.cjs');
  assert.equal(withoutToolCalls('<tool_call>{"name": "plan", "arguments": {}}</tool_call>'), '');
  assert.equal(withoutToolCalls('1. Llegir App.jsx\n2. Afegir el botó\n<tool_call>{"name":"read_file","arguments":{"path":"src/App.jsx"}}</tool_call>'), '1. Llegir App.jsx\n2. Afegir el botó');
  assert.equal(withoutToolCalls('Primer miro el projecte. {"type":"tool_call","name":"list_files"}'), 'Primer miro el projecte.');
  assert.equal(withoutToolCalls('Faré servir {"a": 1} com a exemple.'), 'Faré servir {"a": 1} com a exemple.', 'an object that is not a call stays');
});

test('an answer that says it is done before any tool ran is marked «claimed done without tools» in the turn log', () => {
  const { claimedDoneWithoutTools } = require('./agent-runtime.cjs');
  assert.equal(claimedDoneWithoutTools({ toolCallsRun: 0, requestedWork: true, action: null }), true, 'prose, no call');
  assert.equal(claimedDoneWithoutTools({ toolCallsRun: 0, requestedWork: true, action: { type: 'final' } }), true);
  assert.equal(claimedDoneWithoutTools({ toolCallsRun: 0, requestedWork: true, action: { type: 'tool_call' } }), false);
  assert.equal(claimedDoneWithoutTools({ toolCallsRun: 2, requestedWork: true, action: null }), false, 'after doing something it may finish');
  assert.equal(claimedDoneWithoutTools({ toolCallsRun: 0, requestedWork: false, action: null }), false, 'a question needs no tool');
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, 'agent.ts'), 'utf8');
  assert.match(source, /\.\.\.\(claimedWithoutTools \? \{ claimedDoneWithoutTools: true \} : \{\}\)/);
});

test('a call whose arguments are named «parameter» or «parameters» runs with them (MiMo with vision)', async (t) => {
  for (const [response, file] of [['{"type":"tool_call","name":"read_file","parameter":{"path":"a.txt"}}</function></tool_call>', 'a.txt'], ['<tool_call>{"name": "read_file", "parameters": {"path": "b.txt"}}</tool_call>', 'b.txt']]) {
    const { calls } = await run(t, { request: 'quin és el contingut del fitxer?', responses: [response], tool: async () => ({ content: 'hola' }) });
    assert.deepEqual([calls[0]?.name, calls[0]?.arguments?.path], ['read_file', file], response);
  }
});

test('<function=name>{json}</tool_call> without its closing </function> is read as the call it is', async (t) => {
  const { calls } = await run(t, { request: 'busca bg.inverted', responses: ['Vull veure-ho.<tool_call><function=search_text>{"query": "bg.inverted"}</tool_call>'], tool: async () => ({ matches: [] }) });
  assert.deepEqual([calls[0]?.name, calls[0]?.arguments?.query], ['search_text', 'bg.inverted']);
});

test('arguments written as text are read in the type their tool declares, from the schema alone', async (t) => {
  const { coerceArguments } = require('./agent-runtime.cjs');
  assert.deepEqual(coerceArguments('install_package', { packageName: 'react', dev: 'false' }), { packageName: 'react', dev: false });
  assert.deepEqual(coerceArguments('install_package', { packageName: 'vite', dev: ' TRUE ' }), { packageName: 'vite', dev: true });
  assert.deepEqual(coerceArguments('install_package', { packageName: 'react', dev: 'nope' }), { packageName: 'react', dev: 'nope' }, 'ambiguous: left for the validation');
  assert.deepEqual(coerceArguments('delegate_tasks', { tasks: '["a", "b"]' }), { tasks: ['a', 'b'] });
  assert.deepEqual(coerceArguments('delegate_tasks', { tasks: '[broken' }), { tasks: '[broken' });
  assert.deepEqual(coerceArguments('write_file', { path: 'a.json', content: '{"x": 1}' }), { path: 'a.json', content: '{"x": 1}' }, 'a string stays a string');
  assert.deepEqual(coerceArguments('no_such_tool', { a: 'true' }), { a: 'true' });
  // The loop of 15-11-2026: the call now runs, with dev as a boolean.
  const { calls } = await run(t, {
    request: 'instal·la react',
    responses: ['<tool_call>{"name": "install_package", "arguments": {"packageName": "react", "dev": "false"}}</tool_call>'],
    tool: async () => ({ code: 0, output: 'ok' }),
  });
  assert.deepEqual([calls[0]?.name, calls[0]?.arguments], ['install_package', { packageName: 'react', dev: false }]);
});

test('«fes una npm run dev» asks to run a command, not to change the code: no reminder to write files (cel, 17-11-2026)', async (t) => {
  const { inputs } = await run(t, {
    request: 'fes una npm run dev',
    responses: ['Vaig a iniciar el servidor de desenvolupament amb `npm run dev`.', '{"type":"tool_call","name":"start_project"}', '{"type":"final","content":"El servidor és en marxa a http://localhost:5173/."}'],
    tool: async () => ({ ok: true, url: 'http://localhost:5173/' }),
  });
  assert.ok(!inputs.some((input) => /Encara no has aplicat cap canvi al codi/.test(input)), 'it was told to write files');
  // Saying it is starting the server is not starting it: sent back once to do it, with no hint of which tool.
  assert.ok(inputs.some((input) => /Encara no has fet res del que t’han demanat/.test(input)), 'the announcement was taken as the answer');
});

test('an answer that says the work is done with no tool run in the turn is sent back once; a plain chat is not (cel, 17-11-2026)', async (t) => {
  const claimed = await run(t, { request: 'fes una npm run dev', responses: ['El servidor de desenvolupament s’ha iniciat correctament a http://localhost:5173/.', 'El servidor ja és en marxa.'] });
  assert.equal(claimed.inputs.filter((input) => /Encara no has fet res del que t’han demanat/.test(input)).length, 1);
  const chat = await run(t, { request: 'què fa aquest projecte?', responses: ['És una app de Vite amb React.'] });
  assert.ok(!chat.inputs.some((input) => /Encara no has fet res/.test(input)));
});

test('«arregla-ho» after a proposal asks for the change: an answer that asks again is sent back (cel, 17-11-2026)', async (t) => {
  const { inputs } = await run(t, {
    request: 'arregla-ho',
    responses: [
      'Proposta: el script build passa a ser només vite build. Vols que ho faci així?',
      '{"type":"tool_call","name":"write_file","arguments":{"path":"package.json","content":"{}"}}',
      '{"type":"final","content":"He canviat el build."}',
    ],
    tool: async (call, root) => {
      if (call.name !== 'write_file') return {};
      await fs.writeFile(path.join(root, call.arguments.path), call.arguments.content);
      return { applied: true, path: call.arguments.path };
    },
  });
  assert.ok(inputs.some((input) => /No demanis confirmació|Encara no has aplicat cap canvi al codi|Això és només el pla/.test(input)), 'the question was taken as the answer');
});

test('the call chosen before the plan is run after it, not thrown away (cel, 17-11-2026)', async (t) => {
  const written = [];
  await run(t, {
    request: 'fes una app de Vite amb React que sumi dos números',
    responses: [
      '{"type":"tool_call","name":"write_file","arguments":{"path":"package.json","content":"{}"}}',
      '{"type":"plan","content":"Crearé package.json, index.html, src/main.jsx i src/App.jsx."}',
      '{"type":"tool_call","name":"write_file","arguments":{"path":"src/App.jsx","content":"export default () => null"}}',
      '{"type":"final","content":"Fet."}',
    ],
    tool: async (call) => { if (call.name === 'write_file') written.push(call.arguments.path); return { applied: true, path: call.arguments.path }; },
  });
  assert.equal(written[0], 'package.json');
});

test('a repeated call is told once to go on with the next step; the work continues (cel, 17-11-2026)', async (t) => {
  const written = [];
  const viteConfig = '{"type":"tool_call","name":"write_file","arguments":{"path":"vite.config.js","content":"export default {}"}}';
  const { inputs } = await run(t, {
    request: 'Crea index.html i vite.config.js',
    responses: [
      '{"type":"plan","content":"Crearé vite.config.js i index.html."}',
      viteConfig, viteConfig,
      '{"type":"tool_call","name":"write_file","arguments":{"path":"index.html","content":"<h1>Hola</h1>"}}',
      '{"type":"final","content":"He creat els dos fitxers."}',
    ],
    tool: async (call) => { if (call.name === 'write_file') written.push(call.arguments.path); return { applied: true, path: call.arguments.path }; },
  });
  assert.ok(inputs.some((input) => /ja s’ha fet amb aquests mateixos arguments/.test(input)));
  assert.deepEqual(written, ['vite.config.js', 'index.html']);
});

test('a page that still fails is not passed on as fixed when nothing changed (cel, 17-11-2026)', async (t) => {
  const broken = { started: true, url: 'http://localhost:5173/', pageVerdict: 'PROBLEMA: la pàgina és en blanc. Errors de consola: Uncaught ReferenceError: React is not defined' };
  const sameApp = '{"type":"tool_call","name":"write_file","arguments":{"path":"src/App.jsx","content":"export default () => <p>Hola</p>"}}';
  const { inputs, answer } = await run(t, {
    request: 'fes una npm run dev',
    responses: [
      '{"type":"tool_call","name":"start_project","arguments":{"script":"dev"}}',
      sameApp,
      '{"type":"final","content":"L’he corregit i ja funciona."}',
      '{"type":"final","content":"Ja està corregit."}',
      '{"type":"final","content":"Funciona."}',
    ],
    tool: async (call) => call.name === 'start_project' ? broken : { applied: false, unchanged: true, path: 'src/App.jsx' },
  });
  assert.ok(inputs.some((input) => /Encara no està arreglat: l’última comprovació de la pàgina/.test(input)), 'the claim was not sent back');
  assert.match(answer, /Atenció: l’última comprovació de la pàgina encara deia/);
});

test('the page hint finds the file in any console error, and explains «React is not defined» (cel, 17-11-2026)', () => {
  const { pageFixHint } = require('./agent-runtime.cjs');
  const hint = pageFixHint({ page: { consoleErrors: [
    'Uncaught ReferenceError: React is not defined',
    'The above error occurred in the <App> component:\n\n    at App (http://localhost:5173/src/App.jsx:3:21)\n',
  ] } });
  assert.match(hint, /src\/App\.jsx, línia 3/);
  assert.match(hint, /@vitejs\/plugin-react/);
  assert.doesNotMatch(hint, /Hi ha un nom que es fa servir sense haver-lo importat/);
});

test('a page that cannot be opened because its server is down: the model is told to start it (cel, 17-11-2026)', async (t) => {
  const tools = [];
  const { inputs } = await run(t, {
    request: 'fes una npm run dev',
    responses: [
      '{"type":"tool_call","name":"inspect_browser","arguments":{"url":"http://localhost:5173/"}}',
      '{"type":"tool_call","name":"start_project","arguments":{"script":"dev"}}',
      '{"type":"final","content":"El servidor és en marxa a http://localhost:5173/."}',
    ],
    tool: async (call) => {
      tools.push(call.name);
      if (call.name === 'inspect_browser') return { error: 'No s’ha pogut obrir la pàgina: ERR_CONNECTION_REFUSED (-102)' };
      return { started: true, url: 'http://localhost:5173/', pageVerdict: 'OK: la pàgina es veu bé.' };
    },
  });
  assert.ok(inputs.some((input) => /el servidor de l’app no està en marxa/.test(input)));
  assert.deepEqual(tools, ['inspect_browser', 'start_project']);
});

test('«fes una npm run dev» starts the app directly, as «engega l’app» does (cel, 17-11-2026)', async (t) => {
  for (const request of ['fes una npm run dev', 'npm start', 'executa npm run dev', 'fes un npm run preview.']) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-npm-dev-'));
    t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
    await fs.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', start: 'vite', preview: 'vite preview' } }));
    const agent = new LocalCodingAgent({ engine: { loadModel: async () => {}, generateResponse: async () => { throw new Error('the model was asked'); }, getModelStatus: () => ({ modelId: 'test-model' }) }, experienceRanker: { rank: async () => [] } });
    agent.historyDir = path.join(tempRoot, '.history');
    const calls = [];
    const answer = await agent.ask(request, tempRoot, async (call) => { calls.push(call); return { started: true, url: 'http://localhost:5173/', pageVerdict: 'La pàgina carrega i mostra contingut.' }; });
    assert.equal(calls[0]?.name, 'start_project', request);
    assert.equal(calls[0].arguments.script, /preview/.test(request) ? 'preview' : /start/.test(request) ? 'start' : 'dev', request);
    assert.match(answer, /localhost:5173/);
  }
});
