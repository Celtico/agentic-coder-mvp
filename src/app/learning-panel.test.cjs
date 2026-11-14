// The Aprenentatge local panel and its wiring (src/app/App.tsx, src/electron/main.cjs, mlx-models.cjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const mlxModels = require('../electron/mlx-models.cjs');

const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-learning-panel-'));
const out = path.join(dir, 'view-state.cjs');
esbuild.buildSync({ entryPoints: [path.join(__dirname, 'view-state.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
const view = require(out);
const memoryStorage = (initial = {}) => { const data = { ...initial }; return { getItem: (key) => (key in data ? data[key] : null), setItem: (key, value) => { data[key] = String(value); } }; };

test('the panel is three accordion sections, and the open ones are remembered', () => {
  for (const [value, title] of [['cases', 'Casos desats'], ['data', 'Dades preparades'], ['training', 'Entrenament']]) {
    assert.match(app, new RegExp(`<Accordion\\.Item value="${value}">\\s*<Accordion\\.ItemTrigger>\\{rowHeader\\('${title}'`), title);
  }
  assert.match(app, /defaultValue=\{initialView\.learningSections\} onValueChange=\{\(\{ value \}\) => updateViewState\(localStorage, \(state\) => \{ state\.learningSections = value; \}\)\}/);
  assert.deepEqual(view.loadViewState(memoryStorage()).learningSections, ['cases', 'training']);
  const storage = memoryStorage();
  view.updateViewState(storage, (state) => { state.learningSections = ['data', 'nope']; });
  assert.deepEqual(view.loadViewState(storage).learningSections, ['data']);
});

test('the buttons follow the main process’s state: beta, stable, promotion, stop; nothing trains by itself', () => {
  assert.match(app, /disabled=\{!learningVersions\?\.buttons\.beta\.enabled\}[^>]*onClick=\{\(\) => void startVersion\('beta'\)\}><Brain size=\{15\}\/>Entrena la beta/);
  assert.match(app, /disabled=\{!learningVersions\?\.buttons\.stable\.enabled \|\| trainingRunning\}[^>]*onClick=\{\(\) => void startVersion\('stable'\)\}/);
  assert.match(app, /disabled=\{!learningVersions\.buttons\.promote\.enabled \|\| !stableName\.trim\(\)\} onClick=\{\(\) => void promoteStable\(\)\}/);
  assert.match(app, /window\.agentic\.cancelTraining\(\)\}><X size=\{15\}\/>Atura/);
  assert.match(app, /learningVersions\?\.buttons\.beta\.fewCases && /);
  assert.doesNotMatch(app, /window\.agentic\.startTraining|learning:train-start/);
  // The old route that published a model by itself is gone; the new ones only start from the panel.
  assert.doesNotMatch(main, /ipcMain\.handle\('learning:train-start'|runTrainingPipeline\(/);
  for (const channel of ['learning:train-beta', 'learning:prepare-stable', 'learning:promote-stable', 'learning:delete-beta', 'preferences:set-training']) assert.match(main, new RegExp(`ipcMain\\.handle\\('${channel}'`), channel);
  // Training unloads the chat's model first; a beta in the chat is the base with its adapter.
  assert.match(main, /async function startVersionRun\(kind\) \{[\s\S]*?await stopModelWorker\(\);/);
  assert.match(main, /AGENT_MLX_ADAPTER_PATH: \(await currentModel\(\)\)\.adapterPath \|\| ''/);
});

test('the model list has the newest beta of a base, with the base’s weights and its adapter', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-model-list-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); });
  const beta = path.join(root, 'adapters', 'mimo-9b-mlx', 'beta-1-2026-11-14T22-00-00-000Z');
  fs.mkdirSync(beta, { recursive: true });
  fs.writeFileSync(path.join(beta, 'adapters.safetensors'), 'w');
  fs.writeFileSync(path.join(beta, 'manifest.json'), JSON.stringify({ kind: 'beta', number: 1, cases: 1, caseIds: ['a'], createdAt: '2026-11-14T22:00:00.000Z' }));
  const models = await mlxModels.listModels(root);
  const entry = models.find((model) => model.beta);
  assert.equal(entry.id, 'mimo-9b-mlx@beta-1-2026-11-14T22-00-00-000Z');
  assert.equal(entry.label, 'MiMo V2.6 9B · MLX beta · 1 cas');
  assert.equal(entry.adapterPath, beta);
  assert.equal(entry.folder, 'mimo-v2.6-distill-qwen-9b-4bit');
  assert.ok(models.some((model) => model.id === 'mimo-9b-mlx' && !model.adapterPath), 'the base stays available');
});
