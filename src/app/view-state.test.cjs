// The app opens as it was left (src/app/view-state.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-view-state-'));
const out = path.join(dir, 'view-state.cjs');
esbuild.buildSync({ entryPoints: [path.join(__dirname, 'view-state.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
const view = require(out);
fs.rmSync(dir, { recursive: true, force: true });

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { getItem: (key) => (key in data ? data[key] : null), setItem: (key, value) => { data[key] = String(value); }, data };
}

test('nothing saved gives the app as it opens the first time', () => {
  const state = view.loadViewState(memoryStorage());
  assert.deepEqual(state, view.defaultViewState());
  assert.equal(state.panels.navigation, true);
  assert.equal(state.panels.browser, false);
});

test('panels, evaluation sections and the history window come back as they were saved', () => {
  const storage = memoryStorage();
  view.updateViewState(storage, (state) => {
    state.panels.browser = true; state.panels.evaluation = true; state.panels.navigation = false;
    state.evaluationSections = ['comparison', 'runs'];
    state.history = { position: { x: 80, y: 120 }, size: { width: 900, height: 600 }, stage: 'maximized' };
  });
  const state = view.loadViewState(storage);
  assert.equal(state.panels.browser, true);
  assert.equal(state.panels.evaluation, true);
  assert.equal(state.panels.navigation, false);
  assert.equal(state.panels.git, false);
  assert.deepEqual(state.evaluationSections, ['comparison', 'runs']);
  assert.deepEqual(state.history, { position: { x: 80, y: 120 }, size: { width: 900, height: 600 }, stage: 'maximized' });
});

test('the layout of the left bar comes back, made safe for icons it does not know', () => {
  const storage = memoryStorage();
  view.updateViewState(storage, (state) => { state.rail = { top: ['terminal'], bottom: ['browser', 'git'] }; });
  assert.deepEqual(view.loadViewState(storage).rail, { top: ['conversations', 'files', 'terminal', 'evaluation'], bottom: ['browser', 'git', 'console', 'learning'] });
  const withEditor = memoryStorage({ [view.VIEW_STATE_KEY]: JSON.stringify({ rail: { top: ['x', 'editor', 'git'], bottom: 7 } }) });
  assert.deepEqual(view.loadViewState(withEditor).rail, { top: ['conversations', 'files', 'git', 'browser', 'evaluation'], bottom: ['console', 'terminal', 'learning'] });
});

test('Converses and Fitxers are shown unless hidden, also with a state saved before they had icons', () => {
  assert.equal(view.loadViewState(memoryStorage()).panels.conversations, true);
  assert.equal(view.loadViewState(memoryStorage()).panels.files, true);
  const old = memoryStorage({ [view.VIEW_STATE_KEY]: JSON.stringify({ panels: { navigation: false, browser: true } }) });
  assert.deepEqual([view.loadViewState(old).panels.conversations, view.loadViewState(old).panels.files], [true, true]);
  const storage = memoryStorage();
  view.updateViewState(storage, (state) => { state.panels.conversations = false; });
  assert.deepEqual([view.loadViewState(storage).panels.conversations, view.loadViewState(storage).panels.files], [false, true]);
});

test('each project keeps its own page, file and history; empty values are forgotten', () => {
  const storage = memoryStorage();
  view.updateViewState(storage, (state) => {
    view.setProjectView(state, '/p/a', { browserUrl: 'http://localhost:5173/', editorPath: 'src/App.tsx', historyPath: 'AGENTS.md' });
    view.setProjectView(state, '/p/b', { browserUrl: 'about:blank' });
  });
  const state = view.loadViewState(storage);
  assert.deepEqual(state.projects['/p/a'], { browserUrl: 'http://localhost:5173/', editorPath: 'src/App.tsx', historyPath: 'AGENTS.md' });
  assert.equal(state.projects['/p/b'], undefined, 'about:blank is not a page to reopen');
  view.setProjectView(state, '/p/a', {});
  assert.equal(state.projects['/p/a'], undefined);
});

test('only web pages are reopened, and broken saved data takes the defaults', () => {
  assert.equal(view.reopenableUrl('https://chakra-ui.com/docs'), 'https://chakra-ui.com/docs');
  assert.equal(view.reopenableUrl('file:///etc/passwd'), undefined);
  assert.equal(view.reopenableUrl('javascript:alert(1)'), undefined);
  assert.deepEqual(view.loadViewState(memoryStorage({ [view.VIEW_STATE_KEY]: '{not json' })), view.defaultViewState());
  const odd = view.loadViewState(memoryStorage({ [view.VIEW_STATE_KEY]: JSON.stringify({
    panels: { browser: 'yes', git: true, unknown: true },
    evaluationSections: ['tasks', 3],
    history: { position: { x: 'a', y: 1 }, size: { width: -5, height: 10 }, stage: 'huge' },
    projects: { '/p': { browserUrl: 'file:///x', editorPath: 'a.js' }, '/q': null },
  }) }));
  assert.equal(odd.panels.browser, false);
  assert.equal(odd.panels.git, true);
  assert.equal('unknown' in odd.panels, false);
  assert.deepEqual(odd.evaluationSections, ['tasks']);
  assert.deepEqual(odd.history, { stage: 'default' });
  assert.deepEqual(odd.projects, { '/p': { editorPath: 'a.js' } });
});

test('the app wires it: panels, the evaluation sections and the history window are saved and read back', () => {
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  for (const piece of ['loadViewState(localStorage)', 'initialView.panels.browser', 'initialView.panels.evaluation', 'initialView.evaluationSections', 'initialView.history.position', 'initialView.history.size', '<RestoreWindowStage', 'onPositionChangeEnd', 'onSizeChangeEnd', 'setProjectView(state, projectPath']) assert.ok(app.includes(piece), piece);
});

test('a floating window is kept inside the app, below its title bar', () => {
  const area = { x: 0, y: 36, width: 1440, height: 884 };
  // Dragged or saved above the top (over the title bar and the macOS buttons): moved down to it.
  assert.deepEqual(view.clampWindowRect({ x: 100, y: -50, width: 800, height: 500 }, area), { x: 100, y: 36, width: 800, height: 500 });
  // Off the left, or past the right and the bottom: brought back in.
  assert.deepEqual(view.clampWindowRect({ x: -300, y: 100, width: 800, height: 500 }, area), { x: 0, y: 100, width: 800, height: 500 });
  assert.deepEqual(view.clampWindowRect({ x: 1300, y: 800, width: 800, height: 500 }, area), { x: 640, y: 420, width: 800, height: 500 });
  // Saved bigger than the window now is: it is as big as the area, no bigger.
  assert.deepEqual(view.clampWindowRect({ x: 0, y: 0, width: 3000, height: 2000 }, area), { x: 0, y: 36, width: 1440, height: 884 });
});

test('the history window opens, moves and grows only inside the area below the app title bar', () => {
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  assert.match(app, /getBoundaryEl=\{\(\) => appAreaRef\.current\}/);
  assert.match(app, /<Grid ref=\{appAreaRef\}/);
  assert.match(app, /h="appTitleBar"/);
  assert.match(app, /clampWindowRect\(saved, \{ x: 0, y: top/);
  const theme = fs.readFileSync(path.join(__dirname, '..', 'theme', 'system.ts'), 'utf8');
  assert.ok(theme.includes('appTitleBar: { value: "36px" }'));
});
