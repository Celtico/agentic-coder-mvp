// The rows of panes, as in an IDE (src/app/row-sizes.ts, src/app/pane-row.tsx): each pane its own width,
// its divider changes only that one, and the flexible pane (the chat, or the dock's last) takes the rest.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-row-sizes-'));
const build = (name, entry, external = false) => {
  const out = path.join(dir, `${name}.cjs`);
  esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent', jsx: 'automatic', nodePaths: [path.join(__dirname, '..', '..', 'node_modules')] });
  return require(out);
};
const rows = build('row-sizes', path.join(__dirname, 'row-sizes.ts'));
const view = build('view-state', path.join(__dirname, 'view-state.ts'));
const entry = path.join(dir, 'entry.tsx');
fs.writeFileSync(entry, `
import { renderToStaticMarkup } from "react-dom/server"
import { ChakraProvider } from "@chakra-ui/react"
import { buildSystem } from ${JSON.stringify(path.join(__dirname, '..', 'theme', 'system.ts'))}
import { PaneRow } from ${JSON.stringify(path.join(__dirname, 'pane-row.tsx'))}
export const render = (widths: Record<string, number>) => renderToStaticMarkup(<ChakraProvider value={buildSystem("agentic")}><PaneRow label="fila" flexId="chat" widths={widths} onWidth={() => {}} onCommit={() => {}} items={[{ id: "nav-files", node: <i>fitxers</i> }, { id: "side-browser", node: <i>navegador</i> }, { id: "chat", node: <i>xat</i> }]}/></ChakraProvider>)
`);
const ui = build('entry', entry);
fs.rmSync(dir, { recursive: true, force: true });

test('minimums: the side columns 160 px, the chat 320 px, any other pane 220 px', () => {
  assert.equal(rows.paneMinWidth('nav-conversations'), 160);
  assert.equal(rows.paneMinWidth('chat'), 320);
  assert.equal(rows.paneMinWidth('side-browser'), 220);
  assert.equal(rows.paneMinWidth('dock-terminal'), 220);
  assert.equal(rows.paneWidth('nav-files', { 'nav-files': 50 }), 160, 'never under its minimum');
});

test('dragging a divider changes only its pane; the others keep their widths', () => {
  const widths = { 'nav-conversations': 220, 'nav-files': 240, 'side-browser': 500 };
  const width = rows.draggedPaneWidth({ id: 'nav-files', start: 240, delta: 60, flexWidth: 700, flexMin: 320 });
  assert.equal(width, 300);
  assert.deepEqual(rows.withPaneWidth(widths, 'nav-files', width), { 'nav-conversations': 220, 'nav-files': 300, 'side-browser': 500 });
  // The flexible pane is never given a width of its own.
  assert.equal(rows.withPaneWidth(widths, 'chat', 900), widths);
});

test('the divider stops at the pane’s minimum and where the flexible pane would go under its own', () => {
  assert.equal(rows.draggedPaneWidth({ id: 'side-browser', start: 400, delta: -900, flexWidth: 700, flexMin: 320 }), 220);
  // 700 − 320 = 380 px to give: 400 + 380 at most.
  assert.equal(rows.draggedPaneWidth({ id: 'side-browser', start: 400, delta: 2000, flexWidth: 700, flexMin: 320 }), 780);
  // The flexible pane already at its minimum: the divider does not go right at all.
  assert.equal(rows.draggedPaneWidth({ id: 'side-browser', start: 400, delta: 50, flexWidth: 320, flexMin: 320 }), 400);
});

test('the widths are kept in the view state between launches; only pane ids and sane widths load back', () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
  assert.deepEqual(view.loadViewState(storage).paneWidths, {});
  view.updateViewState(storage, (state) => { state.paneWidths = rows.withPaneWidth(state.paneWidths, 'nav-files', 280); });
  assert.deepEqual(view.loadViewState(storage).paneWidths, { 'nav-files': 280 });
  assert.deepEqual(rows.normalizePaneWidths({ 'nav-files': 280, chat: 600, 'side-git': 100, '<x>': 300, 'dock-git': 5000 }), { 'nav-files': 280 });
});

test('the row: each pane but the flexible one has its width and a separator on its right; the chat takes the rest', () => {
  const html = ui.render({ 'nav-files': 260 });
  assert.equal((html.match(/role="separator"/g) || []).length, 2, 'one per pane with its own width');
  assert.match(html, /data-pane-handle="nav-files"[^>]*|aria-valuenow="260"/);
  assert.match(html, /aria-valuenow="260"/);
  assert.match(html, /aria-valuenow="420"/, 'the browser at its default width');
  assert.doesNotMatch(html, /data-pane-handle="chat"/);
  assert.match(html, /data-pane-flex="true" data-pane-id="chat"|data-pane-flex="" data-pane-id="chat"/);
});

test('the window: both rows are PaneRows (no proportional splitter); the chat is flexible on top, the last pane below', () => {
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  assert.match(app, /<PaneRow items=\{topItems\} flexId="chat" widths=\{paneWidths\} onWidth=\{dragPaneWidth\} onCommit=\{keepPaneWidth\}/);
  assert.match(app, /<PaneRow items=\{dockItems\} flexId=\{dockItems\[dockItems\.length - 1\]\.id\} widths=\{paneWidths\}/);
  assert.doesNotMatch(app, /<Splitter\./);
  // The divider between the rows changes only the dock's height.
  assert.match(app, /<Flex flex="none" minH="0" minW="0" position="relative" mt="6px" h=\{`\$\{terminalHeight\}px`\}/);
});

test('a divider changes only the two panes beside it: one wider, the other narrower by as much', () => {
  // Fitxers | Navegador: Fitxers +60, Navegador −60; nothing else is given a width.
  assert.deepEqual(rows.draggedPair({ left: 'nav-files', right: 'side-browser', startLeft: 240, startRight: 500, delta: 60, rightIsFlex: false, flexMin: 320 }), { 'nav-files': 300, 'side-browser': 440 });
  // Stopped by the right one's minimum (220) and by the left one's (160).
  assert.deepEqual(rows.draggedPair({ left: 'nav-files', right: 'side-browser', startLeft: 240, startRight: 500, delta: 900, rightIsFlex: false, flexMin: 320 }), { 'nav-files': 520, 'side-browser': 220 });
  assert.deepEqual(rows.draggedPair({ left: 'nav-files', right: 'side-browser', startLeft: 240, startRight: 500, delta: -900, rightIsFlex: false, flexMin: 320 }), { 'nav-files': 160, 'side-browser': 580 });
  // Beside the chat: only the left one gets a width; the chat takes the rest, down to 320.
  assert.deepEqual(rows.draggedPair({ left: 'side-evaluation', right: 'chat', startLeft: 400, startRight: 700, delta: 1000, rightIsFlex: true, flexMin: 320 }), { 'side-evaluation': 780 });
  const widths = { 'nav-conversations': 200, 'nav-files': 240, 'side-browser': 500, 'side-evaluation': 400 };
  assert.deepEqual(rows.withPaneWidths(widths, { 'nav-files': 300, 'side-browser': 440 }), { 'nav-conversations': 200, 'nav-files': 300, 'side-browser': 440, 'side-evaluation': 400 });
});

test('while a divider is dragged nothing gets selected: the row stops selecting text and a layer keeps the cursor', () => {
  const source = fs.readFileSync(path.join(__dirname, 'pane-row.tsx'), 'utf8');
  assert.match(source, /handle\.setPointerCapture\(event\.pointerId\)/);
  assert.match(source, /setDragging\(id\)\n\s*window\.getSelection\(\)\?\.removeAllRanges\(\)/);
  assert.match(source, /userSelect=\{dragging \? "none" : undefined\}/);
  assert.match(source, /\{dragging && <Box position="fixed" inset="0" zIndex="4000" cursor="col-resize" userSelect="none" data-pane-drag-layer/);
  // And it all goes back when the drag ends or is cancelled.
  assert.match(source, /if \(handle\.hasPointerCapture\(event\.pointerId\)\) handle\.releasePointerCapture\(event\.pointerId\)\n\s*setDragging\(null\)/);
  // It ends however the pointer is let go, once: on the divider, in the window, on losing the capture or the focus.
  for (const [target, name] of [['handle', 'pointerup'], ['handle', 'pointercancel'], ['handle', 'lostpointercapture'], ['window', 'pointerup'], ['window', 'blur']]) {
    assert.ok(source.includes(`${target}.addEventListener("${name}", end)`) && source.includes(`${target}.removeEventListener("${name}", end)`), `${target} ${name}`);
  }
  assert.match(source, /if \(ended\) return\n\s*ended = true/);
  assert.match(source, /data-pane-drag-layer onPointerUp=\{\(\) => setDragging\(null\)\}/, 'the layer itself never stays');
  // Not dragging: no layer, text can be selected.
  assert.doesNotMatch(ui.render({}), /data-pane-drag-layer/);
});

test('the boxes of a row do not clip their pane, so a pane’s shadow shows round its corners; the terminal takes its pane’s colour', () => {
  const source = fs.readFileSync(path.join(__dirname, 'pane-row.tsx'), 'utf8');
  for (const box of source.match(/<Flex key=\{item\.id\}[^\n]*|<Flex flex="none" w=[^\n]*/g)) assert.doesNotMatch(box, /overflow="hidden"/, box);
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  assert.match(app, /allowTransparency: true, theme: \{ background: 'rgba\(0, 0, 0, 0\)'/);
});

test('a drag cut short (the row unmounted mid-drag) is ended too, so nothing stays blocked', () => {
  const source = fs.readFileSync(path.join(__dirname, 'pane-row.tsx'), 'utf8');
  assert.match(source, /useEffect\(\(\) => \(\) => endDragRef\.current\?\.\(\), \[\]\)/);
  assert.match(source, /endDragRef\.current = end\n/);
});
