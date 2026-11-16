// The native engine in the app: which models it runs (read from config.json) and the text its worker gives
// the agent (the same as mlx-worker.py: tool calls as <tool_call>{json}</tool_call>, history in the model's format).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runtimeFor, nativeSupported } = require('./mlx-models.cjs');
const text = require('../core/assistant/native-text.cjs');

function modelFolder(config, weights = ['model.layers.0.mlp.gate_proj.weight']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-model-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, 'model.safetensors.index.json'), JSON.stringify({ weight_map: Object.fromEntries(weights.map((name) => [name, 'model.safetensors'])) }));
  return dir;
}
const addon = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'addon-')), 'agentic_mlx.node');
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
