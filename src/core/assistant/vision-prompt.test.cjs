// A model that sees images gets prompts/vision.md after the instructions; the notice of a reload does not say «the first time».
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', '..', '..', file), 'utf8');

test('prompts/vision.md is only a comment until cel writes the text, and comments never reach the model', () => {
  const text = read('prompts/vision.md');
  assert.equal(text.replace(/<!--[\s\S]*?-->/g, '').trim(), '');
  const agent = read('src/core/assistant/agent.ts');
  assert.match(agent, /process\.env\.AGENT_MODEL_VISION === '1' \? promptText\('vision'\)\.replace\(\/<!--\[\\s\\S\]\*\?-->\/g, ''\)\.trim\(\) : ''/);
  assert.match(agent, /const system = visionText \? `\$\{baseSystem\}\\n\\n\$\{visionText\}` : baseSystem;/);
});

test('main tells the worker whether the model sees images and whether it was already loaded in this session', () => {
  const main = read('src/electron/main.cjs');
  assert.match(main, /loadedModels\.has\(\(await currentModel\(\)\)\.id\) \? \{ AGENT_MODEL_RELOAD: '1' \}/);
  assert.match(main, /mlxModels\.hasVision\([^\n]*\{ AGENT_MODEL_VISION: '1' \}/);
  assert.match(main, /modelWorker = child;\n  modelWorkerModelId = \(await currentModel\(\)\)\.id;\n/);
  assert.match(main, /loadedModels\.add\(modelWorkerModelId\);/);
});

test('«la primera vegada» only on the first load of the session', () => {
  const engine = read('src/core/assistant/inference-engine.ts');
  assert.match(engine, /process\.env\.AGENT_MODEL_RELOAD === '1'\n\s*\? `Carregant \$\{this\.modelId\}…`\n\s*: `Carregant \$\{this\.modelId\} a la memòria unificada; la primera vegada/);
});
