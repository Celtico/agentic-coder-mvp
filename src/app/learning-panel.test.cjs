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

test('the panel is two groups (Casos, Models) of accordion sections, and the open ones are remembered', () => {
  for (const [value, title] of [['cases', 'Casos desats'], ['manual', 'Dades manuals'], ['training', 'Entrenament']]) {
    assert.match(app, new RegExp(`<Accordion\\.Item value="${value}">\\s*<Accordion\\.ItemTrigger>\\{rowHeader\\('${title}'`), title);
  }
  // Each group's accordion remembers its own sections without dropping the other group's (cel, 17-11-2026).
  assert.match(app, /rowHeader\('Casos', undefined, ListChecks\)[\s\S]*?keepLearningSections\(LEARNING_CASE_SECTIONS, value\)[\s\S]*?rowHeader\('Models', undefined, Brain\)[\s\S]*?keepLearningSections\(LEARNING_MODEL_SECTIONS, value\)/);
  assert.match(app, /state\.learningSections = \[\.\.\.\(state\.learningSections \|\| \[\]\)\.filter\(\(item\) => !group\.includes\(item\)\), \.\.\.value\]/);
  assert.deepEqual(view.loadViewState(memoryStorage()).learningSections, ['cases', 'training']);
  const storage = memoryStorage();
  view.updateViewState(storage, (state) => { state.learningSections = ['manual', 'data', 'nope']; });
  assert.deepEqual(view.loadViewState(storage).learningSections, ['manual']);
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
  assert.equal(entry.label, 'MiMo V2.6 9B · MLX beta 1 · 1 cas');
  assert.equal(entry.adapterPath, beta);
  assert.equal(entry.folder, 'mimo-v2.6-distill-qwen-9b-4bit');
  assert.ok(models.some((model) => model.id === 'mimo-9b-mlx' && !model.adapterPath), 'the base stays available');
});

test('Dades manuals: its own accordion with «Crea un cas» and only the cases written by hand', () => {
  const app = require('node:fs').readFileSync(require('node:path').join(__dirname, 'App.tsx'), 'utf8');
  const manual = app.slice(app.indexOf('<Accordion.Item value="manual">'), app.indexOf('</Accordion.Item>', app.indexOf('<Accordion.Item value="manual">')));
  assert.match(manual, /rowHeader\('Dades manuals', learningCases\?\.cases\.filter\(\(item\) => item\.source === 'manual'\)\.length \?\? 0, Pencil\)/);
  // «Crea un cas» is in Dades manuals; the dataset's buttons at the top of the «Casos» group (cel, 17-11-2026).
  assert.match(manual, /<Plus size=\{14\}\/>Crea un cas/);
  assert.match(app, /rowHeader\('Casos', undefined, ListChecks\)[\s\S]*?data-learning-actions>[\s\S]*?Mostra les dades<\/Button>[\s\S]*?Descarrega \(\.jsonl\)<\/Button>/);
  assert.match(manual, /learningCases\?\.cases\.filter\(\(item\) => item\.source === 'manual'\)\.map\(caseRow\)/);
  // The order: Casos desats, Dades manuals, Entrenament; Dades preparades is now the «Dades» block of Entrenament.
  const order = ['cases', 'manual', 'training'].map((value) => app.indexOf(`<Accordion.Item value="${value}">`));
  assert.ok(order.every((index) => index > -1), String(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal(app.indexOf('<Accordion.Item value="data">'), -1);
  const training = app.slice(app.indexOf('<Accordion.Item value="training">'));
  assert.ok(training.indexOf("rowHeader('Dataset'") > -1 && training.indexOf("rowHeader('Dataset'") < training.indexOf("rowHeader('Beta'"), 'Dataset just above Beta');
  // The open sections are remembered, «manual» too.
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, 'view-state.ts'), 'utf8'), /\["cases", "manual", "imports", "training", "models"\]/);
});

test('a function the running main process does not have yet says «restart the app» instead of nothing', () => {
  const helper = require('node:fs').readFileSync(require('node:path').join(__dirname, 'ipc-errors.ts'), 'utf8');
  assert.match(helper, /export const missingInMain = \(error: unknown\) => error instanceof TypeError && \/is not a function\/\.test\(error\.message\) \|\| \/No handler registered\/i/);
  assert.match(app, /async function showPreparedData\(\) \{[\s\S]*?catch \(error\) \{ learningError\(error\); \}/);
  assert.match(app, /async function downloadPreparedData\(\) \{[\s\S]*?catch \(error\) \{ learningError\(error\); \}/);
  assert.match(helper, /Cal reiniciar l’app per activar aquesta funció: tanca-la \(⌘Q\) i torna-la a obrir\./);
  assert.match(app, /missingInMain\(error\) \? RESTART_NOTICE : errorText\(error\)/);
});

test('Entrenament: its sections Dataset, Beta and Estable are accordion items, open by default, like Aparença', () => {
  assert.match(app, /<Accordion\.Root multiple collapsible defaultValue=\{\['dataset', 'beta', 'stable'\]\} size="sm" variant=\{PANE_ACCORDION\} data-training-sections>/);
  for (const [value, label, icon] of [['dataset', 'Dataset', 'Database'], ['beta', 'Beta', 'FlaskConical'], ['stable', 'Estable', 'BadgeCheck']]) {
    assert.match(app, new RegExp(`<Accordion\\.Item value="${value}">\\n\\s*<Accordion\\.ItemTrigger>\\{rowHeader\\('${label}', undefined, ${icon}\\)\\}</Accordion\\.ItemTrigger>`), label);
  }
  assert.doesNotMatch(app, /data-training-separator/, 'the accordion replaces the separators');
});
