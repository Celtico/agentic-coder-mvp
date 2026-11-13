// The base model of the app is MiMo V2.6 9B; the others stay selectable (src/electron/mlx-models.cjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const mlxModels = require('./mlx-models.cjs');

test('the base model is MiMo V2.6 9B, and Gemma and the Qwen 7B are still offered', () => {
  assert.equal(mlxModels.DEFAULT_MODEL_ID, 'mimo-9b-mlx');
  const ids = mlxModels.builtInModels.map((model) => model.id);
  assert.ok(ids.includes('mimo-9b-mlx') && ids.includes('gemma-4-12b-mlx') && ids.includes('qwen-7b-mlx'));
});

test('it is the model used when none is chosen, found by its id', async () => {
  const root = path.join(os.tmpdir(), 'agentic-no-models');
  assert.equal(mlxModels.defaultModel(await mlxModels.listModels(root)).id, 'mimo-9b-mlx');
  assert.equal((await mlxModels.findModel(root, mlxModels.DEFAULT_MODEL_ID)).id, 'mimo-9b-mlx');
});

test('if the list has no MiMo, the first model is used', () => {
  assert.equal(mlxModels.defaultModel([{ id: 'gemma-4-12b-mlx' }, { id: 'qwen-7b-mlx' }]).id, 'gemma-4-12b-mlx');
  assert.equal(mlxModels.defaultModel([]), undefined);
});
