const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { executeProjectChecks } = require('./project-checks.cjs');

test('reports missing package.json as unavailable checks instead of an invocation error', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-project-checks-empty-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let ran = false;
  const result = await executeProjectChecks(root, async () => { ran = true; return { code: 0, output: '' }; });
  assert.equal(result.code, -1);
  assert.equal(result.checksAvailable, false);
  assert.match(result.output, /encara no té package\.json/);
  assert.equal(ran, false);
});

test('runs configured test script, or available lint/typecheck/build checks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-project-checks-scripts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }));
  const called = [];
  const result = await executeProjectChecks(root, async (_root, script) => { called.push(script); return { code: 0, output: 'pass' }; });
  assert.deepEqual(called, ['test']);
  assert.equal(result.code, 0);
  assert.equal(result.checksAvailable, true);

  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .', build: 'vite build' } }));
  called.length = 0;
  const fallback = await executeProjectChecks(root, async (_root, script) => { called.push(script); return { code: 0, output: 'ok' }; });
  assert.deepEqual(called, ['lint', 'build']);
  assert.equal(fallback.code, 0);
});
