// Aprenentatge local › Gestiona els models (src/electron/model-manager.cjs): the switches of the selector,
// what may be removed, and which Hugging Face repositories can be added.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const manager = require('./model-manager.cjs');
const mlxModels = require('./mlx-models.cjs');

const chat = [
  { id: 'mimo', label: 'MiMo' },
  { id: 'gemma', label: 'Gemma' },
  { id: 'mimo@beta-2', label: 'MiMo beta 2', beta: true, latest: true },
  { id: 'mimo@beta-1', label: 'MiMo beta 1', beta: true, latest: false },
];

test('the selector offers every model and the newest beta, unless a switch says otherwise; the chosen one always', () => {
  const shown = (visibility, selected = 'mimo') => chat.filter((model) => manager.shownInSelector(model, visibility, selected)).map((model) => model.id);
  assert.deepEqual(shown({}), ['mimo', 'gemma', 'mimo@beta-2']);
  assert.deepEqual(shown({ gemma: false, 'mimo@beta-1': true }), ['mimo', 'mimo@beta-2', 'mimo@beta-1']);
  assert.deepEqual(shown({ mimo: false }), ['mimo', 'gemma', 'mimo@beta-2'], 'the chosen model even if it was switched off');
  assert.deepEqual(manager.normalizeVisibility({ a: true, b: 'yes', c: false, [`${'x'.repeat(201)}`]: true }), { a: true, c: false });
  assert.deepEqual(manager.normalizeVisibility(null), {});
});

test('switching off: not the chosen model, and never the last one the selector offers', () => {
  const state = { selectedId: 'mimo', models: chat };
  assert.deepEqual(manager.setShown({}, 'gemma', false, state), { gemma: false });
  assert.throws(() => manager.setShown({}, 'mimo', false, state), /triat al xat/);
  assert.throws(() => manager.setShown({}, 'nope', true, state), /no és en aquest Mac/);
  // With only one model on the Mac, it is the chosen one: it cannot be switched off.
  assert.throws(() => manager.setShown({}, 'solo', false, { selectedId: 'solo', models: [{ id: 'solo' }] }), /triat al xat/);
  // A selection that is not on the Mac any more: the last offered model cannot go.
  assert.throws(() => manager.setShown({ gemma: false, 'mimo@beta-2': false }, 'mimo', false, { selectedId: 'gone', models: chat }), /almenys un model/);
});

test('removing: refused while loaded, chosen, default, base of betas or in use; dictation only while loaded', () => {
  const state = { selectedId: 'mimo', loadedId: 'gemma', defaultId: 'mimo', betaBases: new Set(['qwen']), busyIds: new Set(['bench']), dictationLoadedId: 'whisper' };
  const block = (row) => manager.removalBlock({ installed: true, kind: 'text', ...row }, state);
  assert.match(block({ id: 'gemma' }), /carregat ara/);
  assert.match(block({ id: 'mimo' }), /triat al xat/);
  assert.match(block({ id: 'mimo', }), /triat/);
  assert.match(manager.removalBlock({ id: 'mimo', installed: true, kind: 'text' }, { ...state, selectedId: 'other' }), /per defecte/);
  assert.match(block({ id: 'qwen' }), /betes entrenades/);
  assert.match(block({ id: 'bench' }), /avaluació o un entrenament/);
  assert.match(block({ id: 'x', installed: false }), /No és en aquest Mac/);
  assert.equal(block({ id: 'free' }), null);
  assert.equal(block({ id: 'qwen@beta-1', kind: 'beta' }), null, 'a beta that is not chosen nor loaded');
  assert.match(block({ id: 'gemma', kind: 'beta' }), /carregat ara/);
  assert.match(block({ id: 'whisper', kind: 'dictat' }), /dictat el té carregat/);
  assert.equal(block({ id: 'whisper-small', kind: 'dictat' }), null);
});

const listing = (files, extra = {}) => ({ library_name: 'mlx', tags: ['mlx'], siblings: files.map(([rfilename, size]) => ({ rfilename, size })), ...extra });

test('a repository is added only when it is an MLX chat model with its weights, and small enough', () => {
  const ok = manager.checkRepository(listing([['config.json', 1000], ['model.safetensors', 4_000_000_000], ['tokenizer.json', 5_000_000], ['README.md', 10], ['modeling.py', 99_000]]), 'mlx-community/x-4bit');
  assert.deepEqual(ok, { ok: true, bytes: 4_005_001_000, vision: false }, 'only what is downloaded counts, never code');
  assert.equal(manager.checkRepository(listing([['config.json', 1], ['model.safetensors', 1], ['preprocessor_config.json', 1]]), 'a/b').vision, true);
  assert.equal(manager.checkRepository(listing([['config.json', 1], ['model.safetensors', 1]], { pipeline_tag: 'image-text-to-text' }), 'a/b').vision, true);
  assert.match(manager.checkRepository(null, 'a/b').problem, /No s’ha trobat/);
  assert.match(manager.checkRepository(listing([['config.json', 1], ['model.bin', 1]]), 'a/b').problem, /safetensors/);
  assert.match(manager.checkRepository(listing([['config.json', 1], ['model.safetensors', 1]], { library_name: 'transformers', tags: [] }), 'meta/llama').problem, /No és un model MLX/);
  assert.equal(manager.checkRepository(listing([['config.json', 1], ['model.safetensors', 1]], { library_name: 'transformers', tags: [] }), 'org/Model-MLX-4bit').ok, true, 'the name says MLX');
  assert.match(manager.checkRepository(listing([['config.json', 1], ['weights.safetensors', 1]]), 'mlx-community/whisper-tiny').problem, /dictat/);
  assert.match(manager.checkRepository(listing([['config.json', 1], ['model.safetensors', 13e9]]), 'a/b').problem, /no hi cap/);
});

test('repository ids and the folder and registry entry of an added model', () => {
  assert.equal(manager.validRepoId('mlx-community/Qwen3-8B-4bit'), true);
  for (const bad of ['qwen', 'a/b/c', '../x', 'a/..', 'a /b', '', null, '/a']) assert.equal(manager.validRepoId(bad), false, String(bad));
  assert.equal(manager.slugFor('mlx-community/Qwen3 8B_Instruct.4bit'), 'qwen3-8b_instruct.4bit');
  const added = manager.addedModel({ repo: 'mlx-community/Qwen3-8B-4bit', label: '  Qwen 3  ', modelsRoot: '/m' });
  assert.equal(added.directory, path.join('/m', 'mlx', 'qwen3-8b-4bit'));
  assert.equal(added.partial, path.join('/m', 'mlx', '.qwen3-8b-4bit.partial'));
  assert.deepEqual(added.meta, { id: 'hf-qwen3-8b-4bit', label: 'Qwen 3', modelId: 'mlx-community/Qwen3-8B-4bit', source: 'huggingface' });
  assert.equal(manager.addedModel({ repo: 'a/b', label: '', modelsRoot: '/m' }).meta.label, 'b');
  assert.equal(manager.formatBytes(5_600_000_000), '5,6 GB');
  assert.equal(manager.formatBytes(464_000_000), '464 MB');
});

test('an added model is in the registry the selector reads, and its size is measured on disk', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const added = manager.addedModel({ repo: 'mlx-community/tiny-4bit', label: 'Tiny', modelsRoot: root });
  fs.mkdirSync(added.directory, { recursive: true });
  fs.writeFileSync(path.join(added.directory, 'config.json'), '{}');
  fs.writeFileSync(path.join(added.directory, 'model.safetensors'), Buffer.alloc(2048));
  fs.writeFileSync(path.join(added.directory, 'agentic-model.json'), JSON.stringify(added.meta));
  const models = await mlxModels.listModels(root);
  const entry = models.find((model) => model.id === 'hf-tiny-4bit');
  assert.ok(entry, 'listed without any change to mlx-models.cjs');
  assert.equal(entry.label, 'Tiny');
  assert.equal(await mlxModels.modelDirectory(entry, root), added.directory);
  assert.equal(await manager.folderBytes(added.directory), 2 + 2048 + JSON.stringify(added.meta).length);
  assert.equal(await manager.folderBytes(path.join(root, 'missing')), 0);
});

test('the wiring: the selector reads only the switched-on models; removing goes to the Trash; downloading only from a click', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  assert.match(main, /const selectorModels = async \(\) => \(await getAvailableModels\(\)\)\.filter\(\(model\) => model\.shown\);/);
  assert.match(main, /ipcMain\.handle\('models:list', async \(\) => \(\{ selectedModel, models: await selectorModels\(\) \}\)\);/);
  assert.match(main, /await shell\.trashItem\(row\.folder\);/);
  assert.doesNotMatch(main.slice(main.indexOf("ipcMain.handle('models:remove'"), main.indexOf('async function huggingFaceListing')), /fs\.rm\(/, 'never a permanent delete');
  assert.match(main, /modelVisibility = modelManager\.normalizeVisibility\(saved\.modelVisibility\);/);
  assert.match(main, /training: trainingPreferences, modelVisibility \}/);
  // The download runs huggingface_hub with the file patterns, never code, and is stopped with the app.
  assert.match(main, /mlx_download\.py'\), repo, partial, \.\.\.modelManager\.DOWNLOAD_PATTERNS\]/);
  assert.match(main, /modelDownload\?\.controller\.abort\(\);\n\}\);/);
  assert.ok(!manager.DOWNLOAD_PATTERNS.some((pattern) => pattern.endsWith('.py')));
  const preload = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8');
  for (const channel of ['models:manage', 'models:set-shown', 'models:remove', 'models:check', 'models:add', 'models:add-cancel', 'models:download-progress']) assert.ok(preload.includes(`'${channel}'`), channel);
  const app = fs.readFileSync(path.join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
  assert.match(app, /<Accordion\.Item value="models">/);
  assert.match(app, /rowHeader\('Gestiona els models'/);
  assert.ok(app.indexOf('<Accordion.Item value="training">') < app.indexOf('<Accordion.Item value="models">'), 'after Entrenament');
});

test('Preferències › Aparença: every accordion item has its icon, like the panels’ accordions', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
  for (const [title, icon] of [['Tema', 'SunMoon'], ['Mida de lletra', 'TextSize'], ['Color d’accent', 'Palette'], ['Capçaleres dels panells', 'PanelTop'], ['Estil dels panells', 'LayoutGrid'], ['Fons de les finestres', 'PaintBucket'], ['Diàlegs', 'AppWindow']]) {
    assert.ok(app.includes(`<Accordion.ItemTrigger>{rowHeader('${title}', undefined, ${icon})}</Accordion.ItemTrigger>`), title);
  }
});

test('the rail: an open panel’s icon in the accent’s fg (its paler tone), a closed one muted', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
  assert.match(app, /variant="ghost" colorPalette=\{button\.palette\} color=\{button\.palette === 'agentic' \? 'colorPalette\.fg' : 'fg\.muted'\}/);
});
