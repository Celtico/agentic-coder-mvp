// The title bar of a floating window looks and works like a macOS one (src/app/window-controls.tsx).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

function render(stage) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-window-'));
  const entry = path.join(dir, 'entry.tsx');
  fs.writeFileSync(entry, `
    import { ChakraProvider, FloatingPanel } from "@chakra-ui/react"
    import { renderToStaticMarkup } from "react-dom/server"
    import { system } from ${JSON.stringify(path.join(__dirname, '..', 'theme', 'system.ts'))}
    import { WindowTitleBar } from ${JSON.stringify(path.join(__dirname, 'window-controls.tsx'))}
    export default (stage) => renderToStaticMarkup(
      <ChakraProvider value={system}>
        <FloatingPanel.Root open defaultStage={stage === "default" ? undefined : stage}>
          <FloatingPanel.Positioner><FloatingPanel.Content>
            <WindowTitleBar name="l’historial" stage={stage} title="Historial local: /p"/>
          </FloatingPanel.Content></FloatingPanel.Positioner>
        </FloatingPanel.Root>
      </ChakraProvider>)
  `);
  const out = path.join(dir, 'entry.cjs');
  esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', outfile: out, logLevel: 'silent', nodePaths: [path.join(__dirname, '..', '..', 'node_modules')] });
  try { return require(out).default(stage); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const buttons = (html) => [...html.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
const label = (button) => /aria-label="([^"]*)"/.exec(button)?.[1];

test('the three traffic lights are on the left, then the title, left-aligned, and none is hidden', () => {
  const html = render('default');
  const lights = buttons(html);
  assert.deepEqual(lights.map(label), ['Tanca l’historial', 'Minimitza l’historial', 'Fes gran l’historial']);
  assert.ok(lights.every((button) => !/\shidden/.test(button)));
  assert.ok(html.indexOf('Fes gran') < html.indexOf('Historial local: /p'), 'the lights come before the title');
  // The whole bar is the drag handle: the lights are inside it (zag ignores a drag that starts on a button).
  const drag = html.indexOf('data-part="drag-trigger"');
  assert.ok(drag > -1 && drag < html.indexOf('Tanca l’historial'));
  // Left-aligned, 40 px like the panes' headers, with nothing to keep it centred.
  assert.doesNotMatch(html, /text-align:\s*center|text-align_center/);
  const source = fs.readFileSync(path.join(__dirname, 'window-controls.tsx'), 'utf8');
  assert.match(source, /<FloatingPanel\.DragTrigger flex="1" minW="0" h="10" display="flex" alignItems="center" gap="3" px="3" py="0" borderBottomWidth="thin" borderColor="border">/);
  // The same box as the panes' header (src/theme/pane-recipes.ts).
  const recipes = fs.readFileSync(path.join(__dirname, '..', 'theme', 'pane-recipes.ts'), 'utf8');
  assert.match(recipes, /root: \{ colorPalette: "agentic", display: "flex", flex: "none", h: "10", alignItems: "center", gap: "2", px: "3", minW: "0", borderBottomWidth: "1px", borderColor: "border" \}/);
  assert.match(source, /<FloatingPanel\.Title display="flex" flex="1" minW="0" textAlign="start">/);
});

test('each light is the trigger itself: it gets the trigger’s click and attributes', () => {
  const lights = buttons(render('default'));
  assert.match(lights[0], /data-part="close-trigger"/);
  assert.match(lights[1], /data-part="stage-trigger"[^>]*data-stage="minimized"|data-stage="minimized"[^>]*data-part="stage-trigger"/);
  assert.match(lights[2], /data-stage="maximized"/);
  assert.ok(lights.every((button) => /type="button"/.test(button)));
});

test('yellow and green turn into restore when the window is already minimized or big', () => {
  assert.deepEqual(buttons(render('maximized')).map(label), ['Tanca l’historial', 'Minimitza l’historial', 'Restaura la mida de l’historial']);
  assert.deepEqual(buttons(render('minimized')).map(label), ['Tanca l’historial', 'Restaura l’historial', 'Fes gran l’historial']);
});

test('the colours and sizes come from the theme, not from the component', () => {
  const source = fs.readFileSync(path.join(__dirname, 'window-controls.tsx'), 'utf8');
  assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|\d+px/i);
  const theme = fs.readFileSync(path.join(__dirname, '..', 'theme', 'system.ts'), 'utf8');
  for (const token of ['"window.close"', '"window.minimize"', '"window.maximize"', 'windowTitleBar: { value: "28px" }', 'windowLight: { value: "12px" }', 'windowLights: { value: "52px" }', 'windowLightGap: { value: "8px" }', 'windowLightInset: { value: "12px" }']) assert.ok(theme.includes(token), token);
});

test('the floating window: a Mac window’s rounder corners and a header of the window’s own colour', () => {
  const recipes = fs.readFileSync(path.join(__dirname, '..', 'theme', 'pane-recipes.ts'), 'utf8');
  assert.match(recipes, /content: \{ \.\.\.chakraFloatingPanel\.base\.content, borderRadius: "xl" \}/);
  assert.match(recipes, /header: \{ \.\.\.chakraFloatingPanel\.base\.header, bg: "transparent", borderBottomWidth: "0" \}/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'theme', 'system.ts'), 'utf8'), /floatingPanel: floatingPanelRecipe/);
});
