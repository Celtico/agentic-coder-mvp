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
