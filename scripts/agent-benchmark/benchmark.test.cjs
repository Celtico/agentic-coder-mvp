const assert = require('node:assert/strict');
const test = require('node:test');
const { LocalCodingAgent } = require('../../src/core/assistant/agent-runtime.cjs');
const { runBenchmark, tasks } = require('./run.cjs');

// A scripted engine stands in for the model, so these tests check the benchmark itself (folders,
// tools, checks, scoring), not the quality of any model.
function scriptedEngine(responses) {
  const queue = [...responses];
  return {
    loadModel: async () => {},
    unloadModel: async () => {},
    generateResponse: async () => queue.shift() ?? '{"type":"final","content":"He acabat."}',
    getModelStatus: () => ({ modelId: 'scripted', state: 'ready', cacheDir: '' }),
    getMemoryUsage: () => ({ residentBytes: 0, heapBytes: 0, externalBytes: 0 }),
  };
}

const plan = '{"type":"plan","content":"Llegiré el fitxer, el corregiré i executaré npm test."}';
const fixedSum = JSON.stringify({ type: 'tool_call', name: 'write_file', arguments: { path: 'src/math.cjs', content: 'function sum(a, b) {\n  return a + b;\n}\n\nmodule.exports = { sum };\n' } });

test('every task has an id, a prompt, files and a check', () => {
  const ids = new Set();
  for (const task of tasks) {
    assert.ok(task.id && !ids.has(task.id), `unique id ${task.id}`);
    ids.add(task.id);
    assert.ok(task.prompt.length > 10);
    // Only the app tasks start from an empty folder, and only they may install packages.
    assert.ok(Object.keys(task.files).length > 0 || task.allowInstall === true, `${task.id}: files`);
    assert.equal(typeof task.check, 'function');
    for (const file of task.protected) assert.ok(file in task.files, `${task.id}: protected ${file} exists`);
  }
});

test('a real fix passes: the file is written in the task folder and npm test is run there', async () => {
  const engine = scriptedEngine([plan, fixedSum, '{"type":"tool_call","name":"run_tests"}', '{"type":"final","content":"He corregit sum i npm test passa."}']);
  const { summary, results } = await runBenchmark({ LocalCodingAgent, engine, taskIds: ['fix-failing-test-directed'] });
  assert.equal(results.length, 1);
  assert.equal(results[0].pass, true, results[0].detail);
  assert.deepEqual(results[0].filesChanged, ['src/math.cjs']);
  assert.ok(results[0].toolsByName.write_file >= 1);
  assert.equal(summary.passRate, 1);
});

test('an answer without any change fails and is counted as a run without tools', async () => {
  const engine = scriptedEngine(['He revisat el codi i ja està bé.']);
  const { summary, results } = await runBenchmark({ LocalCodingAgent, engine, taskIds: ['fix-failing-test'] });
  assert.equal(results[0].pass, false);
  assert.match(results[0].detail, /npm test falla/);
  assert.deepEqual(results[0].filesChanged, []);
  assert.equal(summary.passed, 0);
});

test('changing the test to make it pass is a failure', async () => {
  const cheat = JSON.stringify({ type: 'tool_call', name: 'write_file', arguments: { path: 'test/math.test.cjs', content: "require('node:test')('ok', () => {});\n" } });
  const engine = scriptedEngine([plan, cheat, '{"type":"tool_call","name":"run_tests"}', '{"type":"final","content":"Les proves passen."}']);
  const { results } = await runBenchmark({ LocalCodingAgent, engine, taskIds: ['fix-failing-test'] });
  assert.equal(results[0].pass, false);
  assert.deepEqual(results[0].protectedChanged, ['test/math.test.cjs']);
});

test('tools that need the network are refused inside the benchmark', async () => {
  const install = JSON.stringify({ type: 'tool_call', name: 'install_package', arguments: { packageName: 'left-pad', dev: false } });
  const engine = scriptedEngine([plan, install, '{"type":"final","content":"No s’ha pogut instal·lar."}']);
  const { results } = await runBenchmark({ LocalCodingAgent, engine, taskIds: ['create-html-page'] });
  assert.equal(results[0].pass, false);
  assert.ok(results[0].failedToolCalls >= 1);
});

test('unknown task ids are rejected', async () => {
  await assert.rejects(runBenchmark({ LocalCodingAgent, engine: scriptedEngine([]), taskIds: ['nope'] }), /Tasques desconegudes: nope/);
});

test('the app tasks start empty, may install, and their check spots Chakra v2 code without building', async (t) => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { appTasks, appCheck } = require('./app-tasks.cjs');
  const { createSandboxExecutor } = require('./sandbox-tools.cjs');
  assert.equal(appTasks.length, 23, 'three apps and twenty Chakra UI v3 tasks');
  for (const task of appTasks) { assert.deepEqual(task.files, {}); assert.equal(task.allowInstall, true); assert.doesNotMatch(task.prompt, /package\.json|vite|npm|\.jsx/i); }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-bench-app-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.match((await appCheck({ chakra: true })(root)).detail, /package\.json/);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@chakra-ui/react': '^2.8.0' } }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'main.jsx'), 'import { ChakraProvider, extendTheme } from "@chakra-ui/react";\n<ChakraProvider theme={extendTheme({})}><Button colorScheme="blue"/></ChakraProvider>');
  const result = await appCheck({ chakra: true })(root);
  assert.equal(result.pass, false);
  assert.match(result.detail, /no la v3/);
  // A Chakra task also asks for the components the request names, as v3 writes them.
  assert.match((await appCheck({ chakra: true, uses: [[/Dialog\.Root/, 'Dialog']] })(root)).detail, /no fa servir Dialog/);
  assert.match(result.detail, /extendTheme/);
  assert.match(result.detail, /no hi ha script build/);
  // Without allowInstall the installs answer with an error; a dev server is never started.
  const closed = createSandboxExecutor(root);
  await assert.rejects(closed.execute({ name: 'install_package', arguments: { packageName: 'react', dev: false } }), /no està disponible/);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  await assert.rejects(createSandboxExecutor(root, { allowInstall: true }).execute({ name: 'run_project_script', arguments: { script: 'dev' } }), /no s’acaba mai/);
  await assert.rejects(createSandboxExecutor(root, { allowInstall: true }).execute({ name: 'install_package', arguments: { packageName: 'bad name; rm', dev: false } }), /no vàlid/);
});

test('after a task runs out of time the model is stopped, so the next task finds it free', async () => {
  let busy = false; let unloaded = 0; let first = true;
  const engine = {
    loadModel: async () => {}, getModelStatus: () => ({ modelId: 'scripted', state: 'ready', cacheDir: '' }), getMemoryUsage: () => ({}),
    unloadModel: async () => { unloaded += 1; busy = false; },
    generateResponse: async () => {
      if (busy) throw new Error('El runtime MLX ja està generant una resposta.');
      const slow = first; first = false;
      if (!slow) return '{"type":"final","content":"Amb npm start, que arrenca server.cjs."}';
      busy = true;
      return new Promise((resolve) => setTimeout(() => { if (busy) busy = false; resolve('{"type":"final","content":"tard"}'); }, 2000));
    },
  };
  const { results } = await runBenchmark({ LocalCodingAgent, engine, taskIds: ['answer-without-editing'], repeat: 2, timeoutMs: 100 });
  assert.match(results[0].error, /Temps esgotat/);
  assert.equal(unloaded, 1);
  assert.equal(results[1].error, undefined, 'the second run did not find the model busy');
  assert.equal(results[1].pass, true);
});

test('each result keeps what the model saw and answered at every turn', async () => {
  const engine = scriptedEngine(['{"type":"final","content":"Amb npm start, que arrenca server.cjs."}']);
  const { results } = await runBenchmark({ LocalCodingAgent, engine, taskIds: ['answer-without-editing'] });
  assert.equal(results[0].transcript.length, 1);
  assert.equal(results[0].transcript[0].input.role, 'user');
  assert.match(results[0].transcript[0].input.content, /arrenc|start/i);
  assert.match(results[0].transcript[0].output, /npm start/);
});

test('kept projects go to AGENT_BENCHMARK_WORKDIR, to be opened from the app', async (t) => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-bench-keep-'));
  t.after(() => { delete process.env.AGENT_BENCHMARK_WORKDIR; return fs.rm(workdir, { recursive: true, force: true }); });
  process.env.AGENT_BENCHMARK_WORKDIR = path.join(workdir, 'projectes');
  const engine = scriptedEngine(['{"type":"final","content":"Amb npm start, que arrenca server.cjs."}']);
  const { results } = await runBenchmark({ LocalCodingAgent, engine, taskIds: ['answer-without-editing'], keep: true });
  const real = await fs.realpath(path.join(workdir, 'projectes'));
  assert.ok(results[0].folder.startsWith(real + path.sep), results[0].folder);
  assert.ok((await fs.readdir(results[0].folder)).includes('package.json'));
});
