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
