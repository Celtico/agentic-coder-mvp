// The editor opens files in tabs (src/app/editor-tabs.ts, used by src/app/App.tsx).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-editor-tabs-'));
const bundle = (name) => { const out = path.join(dir, `${name}.cjs`); esbuild.buildSync({ entryPoints: [path.join(__dirname, `${name}.ts`)], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' }); return require(out); };
const tabs = bundle('editor-tabs');
const view = bundle('view-state');
fs.rmSync(dir, { recursive: true, force: true });

test('opening a file adds its tab once, at the end', () => {
  let open = tabs.openTab([], 'src/App.jsx');
  open = tabs.openTab(open, 'AGENTS.md');
  open = tabs.openTab(open, 'src/App.jsx');
  assert.deepEqual(open, ['src/App.jsx', 'AGENTS.md']);
});

test('closing the tab in front brings the next one, or the one before if it was the last', () => {
  const open = ['a.js', 'b.js', 'c.js'];
  assert.deepEqual(tabs.closeTab(open, 'b.js', 'b.js'), { tabs: ['a.js', 'c.js'], active: 'c.js' });
  assert.deepEqual(tabs.closeTab(open, 'c.js', 'c.js'), { tabs: ['a.js', 'b.js'], active: 'b.js' });
  assert.deepEqual(tabs.closeTab(open, 'b.js', 'a.js'), { tabs: ['b.js', 'c.js'], active: 'b.js' }, 'closing another tab keeps the one in front');
  assert.deepEqual(tabs.closeTab(['a.js'], 'a.js', 'a.js'), { tabs: [], active: null });
  assert.deepEqual(tabs.closeTab(open, 'a.js', 'x.js'), { tabs: open, active: 'a.js' });
});

test('renamed or deleted files and folders take their tabs with them', () => {
  const open = ['src/App.jsx', 'src/ui/Button.jsx', 'srcx/a.js', 'README.md'];
  assert.deepEqual(tabs.renameInTabs(open, 'src', 'app'), ['app/App.jsx', 'app/ui/Button.jsx', 'srcx/a.js', 'README.md']);
  assert.deepEqual(tabs.removeFromTabs(open, 'src'), ['srcx/a.js', 'README.md']);
  assert.deepEqual(tabs.removeFromTabs(open, 'README.md'), ['src/App.jsx', 'src/ui/Button.jsx', 'srcx/a.js']);
});

test('a tab shows the file name, with its folder when two open files share a name', () => {
  assert.deepEqual(tabs.tabLabels(['src/App.jsx', 'AGENTS.md', 'docs/AGENTS.md']), { 'src/App.jsx': 'App.jsx', 'AGENTS.md': 'AGENTS.md', 'docs/AGENTS.md': 'docs/AGENTS.md' });
});

test('saved tabs come back; a project saved before tabs existed gets its one file as a tab', () => {
  assert.deepEqual(tabs.savedTabs({ editorTabs: ['a.js', 'b.js', 'a.js'], editorPath: 'b.js' }), { tabs: ['a.js', 'b.js'], active: 'b.js' });
  assert.deepEqual(tabs.savedTabs({ editorPath: 'src/App.jsx' }), { tabs: ['src/App.jsx'], active: 'src/App.jsx' });
  assert.deepEqual(tabs.savedTabs({ editorTabs: ['a.js'] }), { tabs: ['a.js'], active: null }, 'the editor was hidden: tabs, nothing in front');
  assert.deepEqual(tabs.savedTabs({}), { tabs: [], active: null });
});

test('the tabs are saved per project and read back, dropping anything that is not a path', () => {
  const data = {};
  const storage = { getItem: (key) => data[key] ?? null, setItem: (key, value) => { data[key] = value; } };
  view.updateViewState(storage, (state) => view.setProjectView(state, '/p', { editorTabs: ['a.js', 'b.js'], editorPath: 'b.js' }));
  assert.deepEqual(view.loadViewState(storage).projects['/p'], { editorPath: 'b.js', editorTabs: ['a.js', 'b.js'] });
  data[view.VIEW_STATE_KEY] = JSON.stringify({ projects: { '/p': { editorTabs: ['a.js', 3, '', null] } } });
  assert.deepEqual(view.loadViewState(storage).projects['/p'], { editorTabs: ['a.js'] });
});

test('the app restores only the tabs whose file is still there, and closes tabs with their ×', () => {
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  assert.match(app, /for \(const tab of savedList\) if \(await window\.agentic\.fileExists\(tab\)/);
  assert.match(app, /<Tabs\.Root[^>]*value=\{editingPath \?\? ''\}/);
  assert.match(app, /<CloseButton as="span" role="button"[^>]*onClick=\{\(event\) => \{ event\.stopPropagation\(\); closeEditorTab\(tab\); \}\}/);
});
