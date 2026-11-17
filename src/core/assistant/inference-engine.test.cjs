const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MlxInferenceEngine } = require('./agent-runtime.cjs');

// Stands in for Python + mlx-worker.py: it answers like the worker, and when stopped it takes a moment
// to exit, as a real model process does.
const FAKE_WORKER = `#!/usr/bin/env node
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300));
console.log(JSON.stringify({ type: 'ready' }));
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  setTimeout(() => console.log(JSON.stringify({ type: 'result', text: 'resposta a ' + request.messages[0].content })), 50);
});
`;

test('a stopped model process that exits late does not unload the one loaded after it', { timeout: 15000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-fake-mlx-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'python');
  await fs.writeFile(fake, FAKE_WORKER, { mode: 0o755 });
  const before = { python: process.env.AGENT_MLX_PYTHON, model: process.env.AGENT_MLX_MODEL_PATH };
  process.env.AGENT_MLX_PYTHON = fake;
  process.env.AGENT_MLX_MODEL_PATH = dir;
  t.after(() => { process.env.AGENT_MLX_PYTHON = before.python; process.env.AGENT_MLX_MODEL_PATH = before.model; });
  const engine = new MlxInferenceEngine();
  const options = { max_new_tokens: 10, temperature: 0, do_sample: false };
  await engine.loadModel();
  const abandoned = engine.generateResponse([{ role: 'user', content: 'primera' }], options).catch((error) => error);
  await engine.unloadModel();
  await engine.loadModel();
  await new Promise((resolve) => setTimeout(resolve, 500)); // the old process exits meanwhile
  assert.equal(engine.getModelStatus().state, 'ready');
  assert.equal(await engine.generateResponse([{ role: 'user', content: 'segona' }], options), 'resposta a segona');
  assert.ok((await abandoned) instanceof Error);
  await engine.unloadModel();
});

test('a worker that cannot load says why, and loading fails with that reason', { timeout: 15000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-fake-mlx-busy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'python');
  await fs.writeFile(fake, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: 'result', error: 'Ja hi ha un altre model carregat en aquest Mac (pid 1: prova).' }));\nprocess.exit(1);\n`, { mode: 0o755 });
  const before = { python: process.env.AGENT_MLX_PYTHON, model: process.env.AGENT_MLX_MODEL_PATH };
  process.env.AGENT_MLX_PYTHON = fake;
  process.env.AGENT_MLX_MODEL_PATH = dir;
  t.after(() => { process.env.AGENT_MLX_PYTHON = before.python; process.env.AGENT_MLX_MODEL_PATH = before.model; });
  await assert.rejects(new MlxInferenceEngine().loadModel(), /Ja hi ha un altre model carregat/);
});

test('the answer’s text reaches onToken as it comes, starting again with each call', { timeout: 15000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-fake-stream-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'python');
  await fs.writeFile(fake, `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'ready' }));
require('node:readline').createInterface({ input: process.stdin }).on('line', () => {
  for (const text of ['Hola', ', ', 'món']) console.log(JSON.stringify({ type: 'token', text }));
  console.log(JSON.stringify({ type: 'result', text: 'Hola, món' }));
});
`, { mode: 0o755 });
  const before = { python: process.env.AGENT_MLX_PYTHON, model: process.env.AGENT_MLX_MODEL_PATH };
  process.env.AGENT_MLX_PYTHON = fake;
  process.env.AGENT_MLX_MODEL_PATH = dir;
  t.after(() => { process.env.AGENT_MLX_PYTHON = before.python; process.env.AGENT_MLX_MODEL_PATH = before.model; });
  const engine = new MlxInferenceEngine();
  const seen = [];
  engine.onToken = (text) => seen.push(text);
  await engine.loadModel();
  assert.equal(await engine.generateResponse([{ role: 'user', content: 'hola' }], { max_new_tokens: 10, temperature: 0, do_sample: false }), 'Hola, món');
  assert.deepEqual(seen, [null, 'Hola', ', ', 'món']);
  await engine.unloadModel();
});
