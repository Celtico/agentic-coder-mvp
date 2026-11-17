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

test('the Mac dmg carries the native engine (Node without Python), built before packaging', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['build:native'], 'npm --prefix native install && npm --prefix native run build');
  assert.match(pkg.scripts['dist:mac'], /npm run build:native && electron-builder --mac dmg/);
  // Its tokenizer and chat template come from the app's own dependencies, at the versions the engine was tested with.
  assert.equal(pkg.dependencies['@huggingface/jinja'], JSON.parse(read('native/package.json')).dependencies['@huggingface/jinja']);
  assert.equal(pkg.dependencies['@huggingface/tokenizers'], JSON.parse(read('native/package.json')).dependencies['@huggingface/tokenizers']);
  for (const file of ['src/core/assistant/native-worker.cjs', 'src/core/assistant/native-text.cjs', 'native/index.js', 'native/chat.js', 'native/lora.js', 'native/build/Release/agentic_mlx.node', 'native/build/Release/libmlx.dylib', 'native/build/Release/mlx.metallib', 'scripts/evaluate-engines.cjs']) {
    assert.ok(pkg.build.files.includes(file), file);
  }
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
  // The evaluation picks the engine as the chat does (mlx-models.cjs runtimeFor: native or the model's own).
  assert.match(read('scripts/evaluate-agent.cjs'), /const runtime = await mlxModels\.runtimeFor\(model, modelDirectory, [^\n]*\);[\s\S]*const engine = createEngine\(runtime\);/);
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

test('the PC’s setup: requirements, a script that builds models/.cuda-venv, and the guide', () => {
  const requirements = read('requirements-linux.txt');
  for (const name of ['transformers', 'accelerate', 'bitsandbytes', 'peft', 'faster-whisper', 'huggingface_hub']) assert.match(requirements, new RegExp(`^${name}>=`, 'm'), name);
  const script = read('scripts/setup-linux.sh');
  assert.match(script, /MODELS="\$\{MODELS_DIR:-models\}"\nVENV="\$MODELS\/\.cuda-venv"/, 'the repository’s models/ or the installed app’s data folder');
  assert.match(script, /python3 -m venv "\$VENV"/);
  assert.match(script, /pip" install torch --index-url/);
  assert.match(script, /pip" install -r requirements-linux\.txt/);
  const guide = read('docs/linux.md');
  assert.match(guide, /encara no s'ha\s+> executat en un PC amb GPU NVIDIA/, 'honest about it being untested on real hardware');
});

test('versions as in GesProd: the count of commits, the commit on hover; a release published by hand from Actions', () => {
  const { appVersion } = require('./app-version.cjs');
  assert.deepEqual(appVersion({ isPackaged: false, git: () => ({ version: '322', commit: 'ea32d30' }) }), { version: '322', commit: 'ea32d30' });
  assert.deepEqual(appVersion({ isPackaged: false, git: () => null }), { version: 'dev', commit: '' }, 'no git: dev');
  assert.deepEqual(appVersion({ isPackaged: true, packageJson: { version: '0.0.322', appCommit: 'ea32d30' } }), { version: '322', commit: 'ea32d30' }, 'the installed app: what it was built with');
  assert.deepEqual(appVersion({ isPackaged: true, packageJson: { version: '0.1.0' } }), { version: '0.1.0', commit: '' });
  const workflow = require('js-yaml').load(read('.github/workflows/release.yml'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'], 'published by hand, nothing on each push');
  assert.deepEqual(workflow.permissions, { contents: 'write' });
  const run = [...workflow.jobs.release.steps, ...workflow.jobs.build.steps].map((step) => step.run || '').join('\n');
  assert.match(run, /git rev-list --count HEAD/);
  assert.match(run, /git log --no-merges --format='- %s' "\$\{previous\}\.\.HEAD"/, 'the notes are the commits since the previous version');
  assert.match(run, /git log --no-merges --format='- %s' -n 30 HEAD/, 'the first version: the latest 30, not the whole history');
  assert.match(run, /gh release create "v\$\{VERSION\}"/);
  assert.match(run, /-c\.extraMetadata\.version=0\.0\.\$\{\{ needs\.release\.outputs\.version \}\} -c\.extraMetadata\.appCommit=/);
  assert.match(run, /gh release upload "v\$\{\{ needs\.release\.outputs\.version \}\}" \$\{\{ matrix\.files \}\} --clobber/);
  assert.equal(workflow.jobs.release.steps[0].with['fetch-depth'], 0, 'the whole history, to count it');
  assert.match(run, /if gh release view "v\$\{VERSION\}" >\/dev\/null 2>&1; then/, 'a rerun reuses the Release');
  // Current runners and actions on Node 24 (macos-14 was retired; checkout@v4 ran on Node 20).
  assert.deepEqual(workflow.jobs.build.strategy.matrix.include.map((item) => item.os), ['macos-15', 'ubuntu-24.04', 'windows-2025']);
  const uses = [...workflow.jobs.release.steps, ...workflow.jobs.build.steps].map((step) => step.uses).filter(Boolean);
  assert.ok(uses.every((action) => /@v\d+\.\d+\.\d+$/.test(action)), 'every action pinned to a full version');
  assert.ok(uses.includes('actions/checkout@v7.0.1') && uses.includes('actions/setup-node@v7.1.0'));
  const app = read('src/app/App.tsx');
  assert.match(app, /<Tip label=\{appVersion\.commit \? `commit \$\{appVersion\.commit\}` : 'dev'\}><Text [^>]*fontSize="2xs" color="fg\.subtle"[^>]*data-app-version>v\{appVersion\.version\}<\/Text><\/Tip>/);
  const pkg = JSON.parse(read('package.json'));
  assert.ok(!pkg.build.files.some((pattern) => /^(models|logs)\b/.test(pattern)), 'no models or local data in the package');
});

test('Windows: the CUDA engine with Scripts\\python.exe, npm/npx through their .cmd (arguments quoted or refused), stopping a whole tree', () => {
  const mlxModels = require('./mlx-models.cjs');
  assert.equal(mlxModels.engineFor('win32'), 'cuda');
  assert.equal(mlxModels.enginePython('C:\\m', 'win32'), 'C:\\m\\.cuda-venv\\Scripts\\python.exe');
  assert.equal(mlxModels.modelsFolder('win32'), 'hf');
  const processes = require('./processes.cjs');
  assert.deepEqual(processes.commandFor('npm', ['run', 'dev'], 'win32'), { command: 'npm.cmd', args: ['run', 'dev'], shell: true });
  assert.deepEqual(processes.commandFor('npx', ['-y', 'create vite'], 'win32').args, ['-y', '"create vite"']);
  assert.throws(() => processes.commandFor('npx', ['x & del /q *'], 'win32'), /no es pot passar a l’ordre a Windows/);
  assert.deepEqual(processes.commandFor('npm', ['run', 'dev'], 'darwin'), { command: 'npm', args: ['run', 'dev'], shell: false }, 'the Mac as before');
  assert.deepEqual(processes.commandFor('git', ['commit', '-m', 'a & b'], 'win32'), { command: 'git', args: ['commit', '-m', 'a & b'], shell: false }, 'not a .cmd: no shell, nothing to quote');
  const calls = [];
  processes.stopTree({ pid: 42 }, 'SIGTERM', 'win32', (...args) => calls.push(args));
  assert.deepEqual(calls, [['taskkill', ['/PID', '42', '/T', '/F'], { stdio: 'ignore' }]]);
  const killed = [];
  processes.stopTree({ pid: 7, kill: (signal) => killed.push(signal) }, 'SIGTERM', 'linux', () => { throw new Error('not used'); });
  assert.ok(killed.length <= 1, 'a group (or the process if there is no group)');
  const main = read('src/electron/main.cjs');
  assert.doesNotMatch(main, /process\.kill\(-child\.pid/, 'every stop goes through processes.stopTree');
  assert.match(read('scripts/agent-benchmark/sandbox-tools.cjs'), /child = processes\.start\(command, args, \{ cwd: root, env, detached: false \}\)/);
});

test('Windows: the lock, links that become copies, the installer, its job in the release and its guide', () => {
  const lock = read('src/core/assistant/mlx_lock.py');
  assert.match(lock, /if os\.name == "nt":\n\s*import msvcrt/);
  assert.match(read('src/core/assistant/mlx_text.py'), /def link_or_copy\(source, target\):[\s\S]*?shutil\.copyfile\(source, target\)/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['dist:win'], 'npm run check && electron-builder --win nsis --x64');
  assert.deepEqual(pkg.build.win.target, ['nsis']);
  assert.match(pkg.scripts['build:ui'], /--define:process\.env\.NODE_ENV=\\"production\\"/, 'quotes both sh and cmd.exe read');
  const workflow = require('js-yaml').load(read('.github/workflows/release.yml'));
  assert.deepEqual(workflow.jobs.build.strategy.matrix.include.map((item) => [item.os, item.files]), [['macos-15', 'dist/*.dmg'], ['ubuntu-24.04', 'dist/*.AppImage dist/*.deb'], ['windows-2025', 'dist/*.exe']]);
  assert.ok(workflow.jobs.build.steps.filter((step) => step.run && /npm run|gh release upload/.test(step.run)).every((step) => step.shell === 'bash'), 'the same shell on the three machines');
  const script = read('scripts/setup-windows.ps1');
  assert.match(script, /Join-Path \$venv 'Scripts\\python\.exe'/);
  assert.match(read('docs/windows.md'), /encara no s'ha\s+> executat en un Windows real/);
});
