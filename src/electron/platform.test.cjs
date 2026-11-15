// The app on Linux (and anywhere else than macOS): the Mac-only parts stay on the Mac, the rest is the same.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Mac-only window parts only on darwin: title bar, vibrancy, dock icon, microphone prompt', () => {
  const main = read('src/electron/main.cjs');
  assert.match(main, /\.\.\.\(process\.platform === 'darwin' \? \{ titleBarStyle: 'hiddenInset', trafficLightPosition: \{ x: 14, y: 11 \} \} : \{\}\)/);
  assert.match(main, /\.\.\.\(process\.platform === 'darwin' \? \{ visualEffectState: 'active' \} : \{\}\)/);
  assert.match(main, /if \(process\.platform !== 'darwin' \|\| !win \|\| win\.isDestroyed\(\)\) return false;\n\s*win\.setVibrancy/);
  assert.match(main, /if \(process\.platform === 'darwin' && app\.dock\)/);
  assert.match(main, /process\.platform === 'darwin' \? systemPreferences\.askForMediaAccess\('microphone'\) : true/);
  const app = read('src/app/App.tsx');
  assert.match(app, /const ownTitleBar = isMacPlatform && /);
  assert.match(app, /const translucent = isMacPlatform && appearance\.windowBg === 'translucent';/);
  assert.match(app, /\{isMacPlatform && <>\n\s*<Text mt="4" mb="1\.5" fontSize="sm" fontWeight="medium">Fons general<\/Text>/);
});

test('the menu elsewhere than macOS: no app menu, Preferències and Surt in Fitxer', () => {
  const { buildMenuTemplate } = require('./app-menu.cjs');
  const labels = require('./menu-labels.cjs');
  const template = buildMenuTemplate({ labels: labels.ca || labels, actions: new Proxy({}, { get: () => () => {} }), isMac: false });
  assert.equal(template[0].label, (labels.ca || labels).file);
});

test('packages: a Linux AppImage and deb next to the Mac dmg, with every Python file of the engine', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['dist:linux'], 'npm run check && electron-builder --linux AppImage deb --x64');
  assert.deepEqual(pkg.build.linux.target, ['AppImage', 'deb']);
  assert.ok(pkg.build.files.includes('src/core/assistant/*.py'), 'mlx_trace.py and mlx_download.py too');
});

test('engine per platform: MLX on a Mac as always; on Linux CUDA, its own venv and the models added under models/hf', async (t) => {
  const os = require('node:os');
  const mlxModels = require('./mlx-models.cjs');
  assert.equal(mlxModels.engineFor('darwin'), 'mlx');
  assert.equal(mlxModels.engineFor('linux'), 'cuda');
  assert.equal(mlxModels.enginePython('/m', 'darwin'), path.join('/m', '.mlx-venv', 'bin', 'python'));
  assert.equal(mlxModels.enginePython('/m', 'linux'), path.join('/m', '.cuda-venv', 'bin', 'python'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-linux-models-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const add = (sub, folder, meta) => {
    fs.mkdirSync(path.join(dir, sub, folder), { recursive: true });
    fs.writeFileSync(path.join(dir, sub, folder, 'config.json'), '{}');
    fs.writeFileSync(path.join(dir, sub, folder, 'model.safetensors'), 'w');
    fs.writeFileSync(path.join(dir, sub, folder, 'agentic-model.json'), JSON.stringify(meta));
  };
  add('hf', 'qwen-coder', { id: 'hf-qwen-coder', label: 'Qwen Coder', modelId: 'Qwen/Qwen2.5-Coder-7B-Instruct' });
  add('mlx', 'mac-only', { id: 'hf-mac-only', label: 'Mac', modelId: 'mlx-community/x' });
  const linux = await mlxModels.listModels(dir, 'linux');
  assert.deepEqual(linux.map((model) => [model.id, model.runtime, model.dir]), [['hf-qwen-coder', 'cuda', 'hf']], 'no MLX model on Linux, built-in or added');
  assert.equal(await mlxModels.modelDirectory(linux[0], dir), path.join(dir, 'hf', 'qwen-coder'));
  const mac = await mlxModels.listModels(dir, 'darwin');
  assert.ok(mac.some((model) => model.id === 'mimo-9b-mlx'), 'the Mac keeps its built-in models');
  assert.deepEqual(mac.filter((model) => model.own).map((model) => [model.id, model.runtime]), [['hf-mac-only', 'mlx']]);
});

test('the agent picks the engine from the runtime: cuda → CudaInferenceEngine (cuda-worker.py), else MLX', () => {
  const runtime = require('../core/assistant/agent-runtime.cjs');
  assert.ok(runtime.createEngine('cuda') instanceof runtime.CudaInferenceEngine);
  assert.ok(runtime.createEngine('cuda') instanceof runtime.MlxInferenceEngine, 'the same engine, another worker');
  assert.ok(!(runtime.createEngine('mlx') instanceof runtime.CudaInferenceEngine));
  assert.ok(!(runtime.createEngine(undefined) instanceof runtime.CudaInferenceEngine), 'a Mac without the variable: MLX');
  const engine = read('src/core/assistant/inference-engine.ts');
  assert.match(engine, /export class CudaInferenceEngine extends MlxInferenceEngine \{\n\s*protected readonly workerScript = 'cuda-worker\.py';/);
  const worker = read('src/core/assistant/cuda-worker.py');
  assert.match(worker, /import mlx_text  # noqa: E402/, 'the tool-call reading is shared, not copied');
  assert.match(worker, /"device_map": "auto"/);
  assert.match(worker, /BitsAndBytesConfig\(load_in_4bit=True/);
  assert.match(read('scripts/evaluate-agent.cjs'), /const engine = createEngine\(model\.runtime\);/);
});

test('LoRA on Linux: the same command line as mlx_lm, only the answer learnt, and the adapter where the app looks', () => {
  const { spawnSync } = require('node:child_process');
  const dir = path.join(root, 'src', 'core', 'assistant');
  const result = spawnSync('python3', ['-I', '-c', `import sys, json, importlib.util; sys.path.insert(0, ${JSON.stringify(dir)})
spec = importlib.util.spec_from_file_location('cuda_lora', ${JSON.stringify(path.join(dir, 'cuda-lora.py'))}); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
a = m.arguments(['lora', '--model', '/b', '--train', '--data', '/d', '--adapter-path', '/a', '--iters', '30', '--batch-size', '1', '--num-layers', '8', '--learning-rate', '1e-05', '--max-seq-length', '64', '--grad-checkpoint', '--mask-prompt', '--seed', '0', '--steps-per-report', '5', '--steps-per-eval', '20', '--save-every', '50'])
class T:
    def apply_chat_template(self, messages, tokenize, add_generation_prompt):
        ids = [ord(c) for m in messages for c in m['content']]
        return ids + ([0] if add_generation_prompt else [])
ids, labels = m.encode(T(), [{'role': 'user', 'content': 'ab'}, {'role': 'assistant', 'content': 'cd'}], 64, True)
class C: num_hidden_layers = 32
print(json.dumps([a.command, a.iters, a.num_layers, a.mask_prompt, ids, labels, m.last_layers(C(), 8)[:2], m.ADAPTER_FILE]))`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const [command, iters, layers, mask, ids, labels, last, file] = JSON.parse(result.stdout.trim());
  assert.deepEqual([command, iters, layers, mask], ['lora', 30, 8, true]);
  assert.deepEqual(ids, [97, 98, 99, 100]);
  assert.deepEqual(labels, [-100, -100, -100, 100], 'the prompt (and the generation marker) is not learnt');
  assert.deepEqual(last, [24, 25]);
  assert.equal(file, 'adapters.safetensors');
  const main = read('src/electron/main.cjs');
  assert.match(main, /mlxModels\.engineFor\(\) === 'mlx' \? 'mlx-locked\.py' : 'cuda-lora\.py'/);
  assert.equal((main.match(/launcher: trainingLauncher\(\)/g) || []).length, 2, 'beta and stable');
});
