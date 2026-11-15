// The app's menu in Catalan (src/electron/app-menu.cjs, text in src/electron/menu-labels.cjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildMenuTemplate, PANES } = require('./app-menu.cjs');
const labels = require('./menu-labels.cjs');

function menu(options = {}) {
  const calls = [];
  const actions = new Proxy({}, { get: (_target, name) => (...args) => calls.push([name, ...args]) });
  return { template: buildMenuTemplate({ labels, actions, ...options }), calls };
}
const items = (template) => template.flatMap((top) => [top, ...(top.submenu || [])]);
const find = (template, predicate) => items(template).find(predicate);

test('on macOS: the app menu, Fitxer, Edició, Visualització, Finestra and Ajuda, in Catalan', () => {
  const { template } = menu({ isMac: true });
  assert.deepEqual(template.map((item) => item.label), ['Agentic Coder', 'Fitxer', 'Edició', 'Visualització', 'Finestra', 'Ajuda']);
  // Every label comes from the labels file: none is left in English.
  for (const item of items(template)) if (item.type !== 'separator') assert.ok(item.label && !/^(File|Edit|View|Window|Help|Undo|Redo|Cut|Copy|Paste|Quit|About)\b/.test(item.label), JSON.stringify(item));
});

test('the native roles are there, with Catalan names', () => {
  const { template } = menu({ isMac: true });
  const roles = Object.fromEntries(items(template).filter((item) => item.role).map((item) => [item.role, item.label]));
  for (const [role, label] of Object.entries({ about: 'Quant a Agentic Coder', services: 'Serveis', hide: 'Amaga Agentic Coder', hideOthers: 'Amaga els altres', unhide: 'Mostra-ho tot', quit: 'Surt d’Agentic Coder', undo: 'Desfés', redo: 'Refés', cut: 'Retalla', copy: 'Copia', paste: 'Enganxa', selectAll: 'Selecciona-ho tot', reload: 'Recarrega', togglefullscreen: 'Pantalla completa', zoomIn: 'Amplia', zoomOut: 'Redueix', resetZoom: 'Mida real', minimize: 'Minimitza', zoom: 'Zoom', front: 'Porta-ho tot al davant', close: 'Tanca la finestra' })) {
    assert.equal(roles[role], label, role);
  }
});

test('the shortcuts: ⌘, ⌘O ⌘N ⌘S and ⇧⌘S, each calling its action', () => {
  const { template, calls } = menu({ isMac: true });
  const byKey = (accelerator) => find(template, (item) => item.accelerator === accelerator);
  for (const [accelerator, label, action] of [['CmdOrCtrl+,', 'Preferències…', 'preferences'], ['CmdOrCtrl+O', 'Obre una carpeta…', 'openFolder'], ['CmdOrCtrl+N', 'Nova conversa', 'newChat'], ['CmdOrCtrl+S', 'Desa', 'save'], ['CmdOrCtrl+Shift+S', 'Desa una captura de la finestra…', 'capture']]) {
    const item = byKey(accelerator);
    assert.equal(item.label, label);
    item.click();
    assert.deepEqual(calls.at(-1), [action]);
  }
  for (const [label, action] of [['Repositori a GitHub', 'repository'], ['README', 'readme'], ['Registre de torns', 'turnLog']]) {
    find(template, (item) => item.label === label).click();
    assert.deepEqual(calls.at(-1), [action]);
  }
});

test('Visualització lists the app’s panes, checked when open; each one toggles its pane', () => {
  const { template, calls } = menu({ isMac: true, panes: { browser: true, terminal: true } });
  const view = template.find((item) => item.label === 'Visualització');
  const panes = view.submenu.filter((item) => item.type === 'checkbox');
  assert.deepEqual(panes.map((item) => [item.label, item.checked]), [['Editor', false], ['Navegador', true], ['Avaluació', false], ['Consola', false], ['Terminal', true], ['Git', false], ['Aprenentatge', false], ['Log del model', false]]);
  panes.forEach((item) => item.click());
  assert.deepEqual(calls.map(([name, pane]) => [name, pane]), PANES.map((pane) => ['togglePane', pane]));
});

test('elsewhere than macOS there is no app menu: Preferències and Surt go to Fitxer', () => {
  const { template } = menu({ isMac: false });
  assert.deepEqual(template.map((item) => item.label), ['Fitxer', 'Edició', 'Visualització', 'Finestra', 'Ajuda']);
  const file = template[0].submenu;
  assert.ok(file.some((item) => item.label === 'Preferències…' && item.accelerator === 'CmdOrCtrl+,'));
  assert.ok(file.some((item) => item.role === 'quit'));
  assert.ok(!items(template).some((item) => item.role === 'front' || item.role === 'services'));
});

test('main.cjs installs this menu, names the app and keeps the data folder; the package declares Catalan', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  assert.match(main, /const userData = app\.getPath\('userData'\);\s*app\.setName\('Agentic Coder'\);\s*app\.setPath\('userData', userData\);/);
  assert.match(main, /Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(buildMenuTemplate\(/);
  assert.doesNotMatch(main, /addPreferencesToMenu|addCaptureToMenu|Menu\.getApplicationMenu\(\)/);
  const info = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).build.mac.extendInfo;
  assert.equal(info.CFBundleDevelopmentRegion, 'ca');
  assert.deepEqual(info.CFBundleLocalizations, ['ca', 'es', 'en']);
  assert.match(info.NSMicrophoneUsageDescription, /micròfon/);
});
