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
  assert.deepEqual(prefs.defaultAppearance(), { colorMode: 'dark', chatFontSize: 'sm', editorFontSize: 11, accent: 'agentic', paneTone: 'brand', paneStyle: 'subtle', paneBg: 'auto', dialogs: 'glass' });
});

test('a saved appearance keeps only valid values', () => {
  assert.deepEqual(prefs.normalizeAppearance({ colorMode: 'system', chatFontSize: 'lg', editorFontSize: 14, accent: 'blue', paneTone: 'tinted', paneStyle: 'elevated', paneBg: 'bg.muted', dialogs: 'solid' }), { colorMode: 'system', chatFontSize: 'lg', editorFontSize: 14, accent: 'blue', paneTone: 'tinted', paneStyle: 'elevated', paneBg: 'bg.muted', dialogs: 'solid' });
  assert.deepEqual(prefs.normalizeAppearance({ colorMode: 'sepia', chatFontSize: '3xl', editorFontSize: 15, accent: '#ff0000', paneTone: 'neon', paneStyle: 'glass', dialogs: 'frosted' }), prefs.defaultAppearance());
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
  view.updateViewState(storage, (state) => { state.appearance = { colorMode: 'light', chatFontSize: 'md', editorFontSize: 13, accent: 'purple', paneTone: 'mono', paneStyle: 'outline', paneBg: 'bg.subtle', dialogs: 'solid' }; });
  assert.deepEqual(view.loadViewState(storage).appearance, { colorMode: 'light', chatFontSize: 'md', editorFontSize: 13, accent: 'purple', paneTone: 'mono', paneStyle: 'outline', paneBg: 'bg.subtle', dialogs: 'solid' });
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

test('every semantic colour the recipes and the app use exists in the theme (an undefined one is transparent)', () => {
  // On 14-11-2026 «bg» and «border» were single values, which hid Chakra's whole groups: bg.panel was
  // undefined and the dialogs were see-through; fg.error and fg.warning had no colour either.
  for (const accent of ['agentic', 'blue']) {
    const system = theme.buildSystem(accent);
    for (const token of ['bg', 'bg.panel', 'bg.subtle', 'bg.muted', 'fg', 'fg.muted', 'fg.error', 'fg.warning', 'border', 'border.subtle', 'canvas', 'surface', 'surface.subtle',
      'brand.solid', 'brand.fg', 'brand.subtle', 'agentic.solid', 'agentic.fg', 'agentic.subtle', 'agentic.contrast']) {
      assert.ok(system.token(`colors.${token}`), `${token} (${accent}) is not defined`);
    }
  }
  // And every colour named in the panes' and dialogs' recipes.
  const recipes = fs.readFileSync(path.join(__dirname, '..', 'theme', 'pane-recipes.ts'), 'utf8');
  const named = [...recipes.matchAll(/(?:bg|color|borderColor): "([a-z]+(?:\.[a-z]+)?)"/g)].map((match) => match[1]).filter((name) => name !== 'transparent');
  assert.ok(named.length > 5);
  const system = theme.buildSystem('agentic');
  for (const token of new Set(named)) assert.ok(system.token(`colors.${token}`), `${token} used in a recipe is not defined`);
});

test('with the blue accent the panes’ palette is blue (a tinted header: blue.subtle and blue’s text colour); with agentic, the green', () => {
  // The headers' recipes use colorPalette «agentic» (src/theme/pane-recipes.ts); the accent decides what it is.
  assert.deepEqual(accent.accentSemantic('blue').subtle.value, { _light: '{colors.blue.100}', _dark: '{colors.blue.900}' });
  assert.deepEqual(accent.accentSemantic('blue').solid.value, { _light: '{colors.blue.600}', _dark: '{colors.blue.600}' });
  assert.equal(accent.accentSemantic('agentic').solid.value, '{colors.agentic.500}');
  assert.equal(theme.buildSystem('blue').token('colors.agentic.500'), '#3b82f6');
  assert.equal(theme.buildSystem('agentic').token('colors.agentic.500'), '#10a37f');
  // The rail's mark alone stays in the fixed brand green.
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  assert.match(app, /<Mark size=\{28\} gradient\/>/);
});

test('Fons de les finestres: Chakra’s bg tokens, «auto» (the panel style’s own) by default, kept when saved', () => {
  assert.deepEqual([...prefs.PANE_BACKGROUNDS], ['auto', 'bg', 'bg.subtle', 'bg.muted', 'bg.emphasized', 'bg.inverted', 'bg.panel']);
  assert.equal(prefs.defaultAppearance().paneBg, 'auto');
  assert.equal(prefs.normalizeAppearance({ paneBg: 'bg.muted' }).paneBg, 'bg.muted');
  assert.equal(prefs.normalizeAppearance({ paneBg: '#ff0000' }).paneBg, 'auto', 'only the tokens');
  const pane = require('node:fs').readFileSync(require('node:path').join(__dirname, 'pane-header.tsx'), 'utf8');
  assert.match(pane, /bg=\{paneBg === "auto" \? undefined : paneBg\} color=\{paneBg === "bg\.inverted" \? "fg\.inverted" : undefined\}/);
  const app = require('node:fs').readFileSync(require('node:path').join(__dirname, 'App.tsx'), 'utf8');
  assert.match(app, /<PaneBgContext\.Provider value=\{appearance\.paneBg\}>/);
  // Swatch cards like Chakra's token docs: each option as a mini panel in light and dark (Chakra's Theme).
  assert.match(app, /role="radiogroup" aria-label="Fons de les finestres"/);
  assert.match(app, /PANE_BACKGROUNDS\.map\(\(value\) => \{/);
  assert.match(app, /<Theme key=\{mode\} appearance=\{mode\}[^>]*bg=\{token\} color=\{text\}/);
  assert.doesNotMatch(app, /<NativeSelect\.Field aria-label="Fons de les finestres"/);
  assert.match(app, /theme: \{ background: tokenColor\(paneSurface\)/, 'the terminal follows it');
});

test('Fons de les finestres reaches every window-like surface: bg and bg.panel re-pointed, dialogs and Historial too', () => {
  const app = require('node:fs').readFileSync(require('node:path').join(__dirname, 'App.tsx'), 'utf8');
  assert.match(app, /if \(appearance\.paneBg !== 'bg'\) root\.setProperty\('--chakra-colors-bg', ref\(appearance\.paneBg\)\);/);
  assert.match(app, /if \(appearance\.paneBg !== 'bg\.panel'\) root\.setProperty\('--chakra-colors-bg-panel', ref\(appearance\.paneBg\)\);/);
  assert.match(app, /if \(appearance\.paneBg === 'auto'\) return;/, '«auto» leaves the theme as it is');
  // Every dialog and the floating window take the text colour for bg.inverted.
  const contents = app.match(/<Dialog\.Content\b[^>]*>/g) || [];
  assert.ok(contents.length >= 10);
  for (const tag of contents) assert.match(tag, /\{\.\.\.surfaceText\}/, tag);
  assert.match(app, /<FloatingPanel\.Content [^>]*color="fg" \{\.\.\.surfaceText\}/);
  // The swatches say their values like Chakra's docs.
  assert.match(app, /\{mode === '_light' \? 'light' : 'dark'\}: \{tokenValue\(chakraSystem, token, mode\)\}/);
});
