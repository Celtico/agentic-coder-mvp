// The native engine in the app: which models it runs (read from config.json) and the text its worker gives
// the agent (the same as mlx-worker.py: tool calls as <tool_call>{json}</tool_call>, history in the model's format).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runtimeFor, nativeSupported } = require('./mlx-models.cjs');
const text = require('../core/assistant/native-text.cjs');
const { spawnSync } = require('node:child_process');

function modelFolder(config, weights = ['model.layers.0.mlp.gate_proj.weight']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-model-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, 'model.safetensors.index.json'), JSON.stringify({ weight_map: Object.fromEntries(weights.map((name) => [name, 'model.safetensors'])) }));
  return dir;
}
const addon = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'addon-')), 'mlx_node.node');
fs.writeFileSync(addon, '');
const mlx = { runtime: 'mlx' };

test('a Qwen 3.5 text model (MiMo) runs on the native engine, unless Python is chosen', async () => {
  const dir = modelFolder({ model_type: 'qwen3_5', text_config: { model_type: 'qwen3_5_text' } });
  assert.strictEqual(await runtimeFor(mlx, dir, { addon }), 'native');
  assert.strictEqual(await runtimeFor(mlx, dir, { addon, python: true }), 'mlx');
  // Without the built addon, Python.
  assert.strictEqual(await runtimeFor(mlx, dir, { addon: path.join(os.tmpdir(), 'missing.node') }), 'mlx');
  // On Linux the model's own runtime.
  assert.strictEqual(await runtimeFor({ runtime: 'cuda' }, dir, { addon }), 'cuda');
});

test('other families, MoE and models with a vision tower keep the Python worker', async () => {
  assert.strictEqual(await nativeSupported(modelFolder({ model_type: 'gemma4' }), addon), false);
  assert.strictEqual(await nativeSupported(modelFolder({ model_type: 'qwen2' }), addon), false);
  assert.strictEqual(await nativeSupported(modelFolder({ model_type: 'qwen3_5', text_config: { model_type: 'qwen3_5_text', num_experts: 64 } }), addon), false);
  const vision = modelFolder({ model_type: 'qwen3_5', vision_config: {}, text_config: { model_type: 'qwen3_5_text' } }, ['model.visual.blocks.0.attn.qkv.weight']);
  assert.strictEqual(await nativeSupported(vision, addon), false);
  assert.strictEqual(await nativeSupported(null, addon), false);
});

const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' }, lines: { type: 'integer' } } } } }];

// As mlx_text.py: the XML is read before the parser, so values stay text ("20") unless they are JSON objects or lists.
test('Qwen 3.5 XML tool calls become the agent’s JSON, with Python’s separators', () => {
  const raw = 'Ara el llegeixo.\n<tool_call>\n<function=read_file>\n<parameter=path>\nsrc/a.js\n</parameter>\n<parameter=lines>\n20\n</parameter>\n</function>\n</tool_call>';
  assert.strictEqual(text.normalizeToolCalls(raw, tools, '<tool_call>', '</tool_call>', text.qwen3CoderParser),
    'Ara el llegeixo.\n<tool_call>{"name": "read_file", "arguments": {"path": "src/a.js", "lines": "20"}}</tool_call>');
  // Already JSON: left as JSON; not a call: left as it was.
  assert.strictEqual(text.normalizeToolCalls('<tool_call>{"name": "x", "arguments": {}}</tool_call>', tools), '<tool_call>{"name": "x", "arguments": {}}</tool_call>');
  assert.strictEqual(text.normalizeToolCalls('<tool_call>no</tool_call>', tools, '<tool_call>', '</tool_call>', text.qwen3CoderParser), '<tool_call>no</tool_call>');
});

test('the agent’s history goes back as tool_calls and tool messages; reasoning is removed', () => {
  const history = text.nativeHistory([
    { role: 'user', content: 'Llegeix a.js' },
    { role: 'assistant', content: 'Miro.<tool_call>{"name": "read_file", "arguments": {"path": "a.js"}}</tool_call>' },
    { role: 'user', content: 'contingut' },
  ]);
  assert.deepStrictEqual(history, [
    { role: 'user', content: 'Llegeix a.js' },
    { role: 'assistant', content: 'Miro.', tool_calls: [{ type: 'function', function: { name: 'read_file', arguments: { path: 'a.js' } } }] },
    { role: 'tool', name: 'read_file', content: 'contingut' },
  ]);
  assert.strictEqual(text.stripThinking('<think>pensa</think>Resposta', '<think>', '</think>'), 'Resposta');
  assert.strictEqual(text.stripThinking('pensa</think>Resposta', '<think>', '</think>'), 'Resposta');
});

// The rule that stops a model stuck repeating itself (native-text.cjs and mlx_text.py, the same).
const imports = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { suma } from './suma.js'\n\n";
const repetitionCases = [
  // 16-11-2026: «Dades de prova» hundreds of times inside a test file.
  ['stuck', imports + 'Dades de prova\n\n'.repeat(60), true],
  // Normal code: similar lines that differ, a dozen identical short lines, a table, a long but varied file.
  ['similar assertions', imports + Array.from({ length: 40 }, (_, i) => `test('suma ${i}', () => assert.equal(suma(${i}, 1), ${i + 1}))\n`).join(''), false],
  ['identical short lines', imports + '  assert.ok(true)\n'.repeat(12), false],
  ['a table', '| a | b |\n|---|---|\n' + Array.from({ length: 30 }, (_, i) => `| ${i} | ${i * 2} |\n`).join(''), false],
  ['a short run of one character', 'x'.repeat(599), false],
];

test('a model repeating the same text is stopped; normal code is not', () => {
  for (const [name, value, stuck] of repetitionCases) assert.strictEqual(text.repeatingTail(value), stuck, name);
});

test('the Python worker uses the same rule (mlx_text.repeating_tail)', { skip: spawnSync('python3', ['--version']).status !== 0 && 'no python3' }, () => {
  const dir = path.join(__dirname, '..', 'core', 'assistant');
  const result = spawnSync('python3', ['-I', '-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(dir)})\nimport mlx_text\nprint(json.dumps([mlx_text.repeating_tail(v) for v in json.load(sys.stdin)]))`], { input: JSON.stringify(repetitionCases.map(([, value]) => value)), encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(JSON.parse(result.stdout), repetitionCases.map(([, , stuck]) => stuck));
});

test('Preferències › Agent: «Motor» Automàtic (native where it can) or Python, kept as pythonEngine', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
  assert.match(app, />Motor<\/Text>[\s\S]*?value=\{agentPreferences\.values\.pythonEngine \? 'python' : 'auto'\}[\s\S]*?changeAgentPreferences\(\{ pythonEngine: value === 'python' \}\)[\s\S]*?\{ value: 'auto', label: 'Automàtic' \}, \{ value: 'python', label: 'Python' \}/);
  assert.doesNotMatch(app, /'Motor Python'/);
});

test('LoRA without Python: native-lora.cjs takes the app’s mlx_lm lora command line, and the app reads its lines', () => {
  const { parseArgs } = require('../core/assistant/native-lora.cjs');
  const args = parseArgs(['lora', '--model', '/m', '--train', '--data', '/d', '--adapter-path', '/a', '--iters', '30', '--batch-size', '1', '--num-layers', '8', '--learning-rate', '1e-05', '--max-seq-length', '2048', '--grad-checkpoint', '--mask-prompt', '--seed', '0', '--steps-per-report', '5', '--steps-per-eval', '30', '--save-every', '50']);
  assert.deepStrictEqual(args, { model: '/m', data: '/d', adapterPath: '/a', train: true, iters: 30, batchSize: 1, numLayers: 8, learningRate: 1e-5, maxSeqLength: 2048, gradCheckpoint: true, maskPrompt: true, seed: 0, stepsPerReport: 5, stepsPerEval: 30, saveEvery: 50 });
  const { parseTrainingLine } = require('./learning-versions.cjs');
  assert.deepStrictEqual(parseTrainingLine('Iter 5: Train loss 3.136, Learning Rate 1.000e-5, It/sec 0.412, Tokens/sec 141.176, Trained Tokens 65, Peak mem 7.800 GB'), { iteration: 5, loss: 3.136, itPerSec: 0.412, tokensPerSec: 141.176 });
  // The app trains with it when the native engine runs the base model and the engine is «Automàtic».
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  assert.match(main, /const native = mlxModels\.engineFor\(\) === 'mlx' && !agentPreferences\.pythonEngine && await mlxModels\.nativeSupported\(base\.directory\);/);
  assert.match(main, /\.\.\.await trainingCommand\(base\)/);
});
