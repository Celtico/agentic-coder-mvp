// Preferències › Aparença and the accent of the theme (src/app/preferences.ts, src/theme/accent.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-preferences-'));
const bundle = (file) => { const out = path.join(dir, `${path.basename(file, '.ts')}.cjs`); esbuild.buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent', jsx: 'automatic' }); return require(out); };
const prefs = bundle(path.join(__dirname, 'preferences.ts'));
const view = bundle(path.join(__dirname, 'view-state.ts'));
const accent = bundle(path.join(__dirname, '..', 'theme', 'accent.ts'));
const theme = bundle(path.join(__dirname, '..', 'theme', 'system.ts'));
fs.rmSync(dir, { recursive: true, force: true });

const memoryStorage = (initial = {}) => { const data = { ...initial }; return { getItem: (key) => (key in data ? data[key] : null), setItem: (key, value) => { data[key] = String(value); } }; };

test('the default appearance is the app as it was: dark, normal sizes, its own green', () => {
  assert.deepEqual(prefs.defaultAppearance(), { colorMode: 'dark', chatFontSize: 'sm', editorFontSize: 11, accent: 'agentic', paneTone: 'brand' });
});

test('a saved appearance keeps only valid values', () => {
  assert.deepEqual(prefs.normalizeAppearance({ colorMode: 'system', chatFontSize: 'lg', editorFontSize: 14, accent: 'blue', paneTone: 'tinted' }), { colorMode: 'system', chatFontSize: 'lg', editorFontSize: 14, accent: 'blue', paneTone: 'tinted' });
  assert.deepEqual(prefs.normalizeAppearance({ colorMode: 'sepia', chatFontSize: '3xl', editorFontSize: 15, accent: '#ff0000', paneTone: 'neon' }), prefs.defaultAppearance());
  assert.deepEqual(prefs.normalizeAppearance(null), prefs.defaultAppearance());
});

test('«system» follows the operating system; sizes move one step and stay in their list', () => {
  assert.equal(prefs.resolveColorMode('system', true), 'dark');
  assert.equal(prefs.resolveColorMode('system', false), 'light');
  assert.equal(prefs.resolveColorMode('light', true), 'light');
  assert.equal(prefs.stepSize(prefs.CHAT_FONT_SIZES, 'sm', 1), 'md');
  assert.equal(prefs.stepSize(prefs.CHAT_FONT_SIZES, 'xs', -1), 'xs');
  assert.equal(prefs.stepSize(prefs.EDITOR_FONT_SIZES, 18, 1), 18);
  assert.equal(prefs.stepSize(prefs.EDITOR_FONT_SIZES, 11, -1), 10);
});

test('the appearance is kept with the view state', () => {
  const storage = memoryStorage();
  view.updateViewState(storage, (state) => { state.appearance = { colorMode: 'light', chatFontSize: 'md', editorFontSize: 13, accent: 'purple', paneTone: 'mono' }; });
  assert.deepEqual(view.loadViewState(storage).appearance, { colorMode: 'light', chatFontSize: 'md', editorFontSize: 13, accent: 'purple', paneTone: 'mono' });
  assert.deepEqual(view.loadViewState(memoryStorage()).appearance, prefs.defaultAppearance());
});

test('an accent points the «agentic» palette at a Chakra palette; «agentic» is the app’s own green', () => {
  assert.deepEqual([...accent.ACCENTS], ['agentic', 'gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'cyan', 'purple', 'pink']);
  assert.deepEqual(accent.accentTokens('agentic'), accent.BRAND_TOKENS);
  assert.equal(accent.accentTokens('blue')['500'].value, '#3b82f6');
  assert.equal(Object.keys(accent.accentTokens('red')).length, 11);
  assert.equal(accent.accentSemantic('agentic').solid.value, '{colors.agentic.500}');
  assert.deepEqual(accent.accentSemantic('blue').fg.value, { _light: '{colors.blue.700}', _dark: '{colors.blue.300}' });
  // Yellow keeps Chakra's dark text on it.
  assert.deepEqual(accent.accentSemantic('yellow').contrast.value, { _light: 'black', _dark: 'black' });
  assert.equal(accent.isAccent('blue'), true);
  assert.equal(accent.isAccent('#00ff00'), false);
});

test('the theme built for an accent gives «agentic» that palette, and «brand» stays green', () => {
  const blue = theme.buildSystem('blue');
  const green = theme.buildSystem('agentic');
  assert.equal(blue.token('colors.agentic.500'), '#3b82f6');
  assert.equal(green.token('colors.agentic.500'), '#10a37f');
  assert.equal(blue.token('colors.brand.500'), '#10a37f');
  assert.ok(blue.token('colors.agentic.solid'), 'the semantic token the components use exists');
});
