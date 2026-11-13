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
    assert.ok(Object.keys(task.files).length > 0);
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
