// The icons of the left bar move between the top and bottom groups, and their panes follow (src/app/rail-layout.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-rail-layout-'));
const out = path.join(dir, 'rail-layout.cjs');
esbuild.buildSync({ entryPoints: [path.join(__dirname, 'rail-layout.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
const rail = require(out);
fs.rmSync(dir, { recursive: true, force: true });

const defaults = { top: ['conversations', 'files', 'browser', 'evaluation', 'chat'], bottom: ['console', 'terminal', 'git', 'learning', 'llmlog'] };

test('the default layout: Converses and Fitxers first on top; the editor and «new chat» have no icon', () => {
  assert.deepEqual(rail.defaultRailLayout(), defaults);
  assert.ok(!rail.RAIL_PANELS.includes('editor'));
  assert.deepEqual(rail.SIDE_COLUMNS, ['conversations', 'files']);
});

test('an icon dragged to the other group goes where it is dropped', () => {
  assert.deepEqual(rail.moveRailPanel(defaults, 'terminal', 'top', 1), { top: ['conversations', 'terminal', 'files', 'browser', 'evaluation', 'chat'], bottom: ['console', 'git', 'learning', 'llmlog'] });
  assert.deepEqual(rail.moveRailPanel(defaults, 'files', 'bottom', 0), { top: ['conversations', 'browser', 'evaluation', 'chat'], bottom: ['files', 'console', 'terminal', 'git', 'learning', 'llmlog'] });
  assert.deepEqual(rail.moveRailPanel(defaults, 'evaluation', 'bottom', 99).bottom, ['console', 'terminal', 'git', 'learning', 'llmlog', 'evaluation']);
  assert.deepEqual(rail.moveRailPanel(defaults, 'git', 'top', -3).top, ['git', 'conversations', 'files', 'browser', 'evaluation', 'chat']);
});

test('inside its group an icon is reordered, counting the slot as shown while dragging', () => {
  assert.deepEqual(rail.moveRailPanel(defaults, 'conversations', 'top', 2).top, ['files', 'conversations', 'browser', 'evaluation', 'chat']);
  assert.deepEqual(rail.moveRailPanel(defaults, 'learning', 'bottom', 0).bottom, ['learning', 'console', 'terminal', 'git', 'llmlog']);
  // Dropped on itself (just before or just after) nothing changes.
  assert.deepEqual(rail.moveRailPanel(defaults, 'terminal', 'bottom', 1), defaults);
  assert.deepEqual(rail.moveRailPanel(defaults, 'terminal', 'bottom', 2), defaults);
  assert.ok(rail.sameRailLayout(rail.moveRailPanel(defaults, 'terminal', 'bottom', 2), defaults));
});

test('the move does not change the layout it was given', () => {
  const layout = rail.defaultRailLayout();
  rail.moveRailPanel(layout, 'git', 'top', 0);
  assert.deepEqual(layout, defaults);
});

test('a saved layout drops unknown, retired and repeated ids, and adds the icons it does not name (the column icons first on top)', () => {
  assert.deepEqual(rail.normalizeRailLayout(null), defaults);
  assert.deepEqual(rail.normalizeRailLayout({ top: ['git', 'nope', 42, 'git'], bottom: 'browser' }), { top: ['conversations', 'files', 'git', 'browser', 'evaluation', 'chat'], bottom: ['console', 'terminal', 'learning', 'llmlog'] });
  // A pane named in both groups stays in the first one it appears in.
  assert.deepEqual(rail.normalizeRailLayout({ top: ['terminal'], bottom: ['terminal', 'browser'] }).bottom, ['browser', 'console', 'git', 'learning', 'llmlog']);
  // Saved before the editor and «new chat» left the bar: those ids go, the rest keeps its order.
  assert.deepEqual(rail.normalizeRailLayout({ top: ['editor', 'terminal', 'browser', 'newChat', 'evaluation'], bottom: ['git', 'console', 'learning'] }), { top: ['conversations', 'files', 'terminal', 'browser', 'evaluation', 'chat'], bottom: ['git', 'console', 'learning', 'llmlog'] });
});

test('the layouts saved on this Mac load cleanly, and the new column icons go on top', () => {
  assert.deepEqual(rail.normalizeRailLayout({ top: ['browser', 'editor', 'learning'], bottom: ['evaluation', 'terminal', 'git', 'console'] }), { top: ['conversations', 'files', 'browser', 'learning', 'chat'], bottom: ['evaluation', 'terminal', 'git', 'console', 'llmlog'] });
  // Every icon moved to the bottom, as cel left it: the order is kept and the two new icons go on top.
  const allBelow = { top: [], bottom: ['evaluation', 'learning', 'browser', 'terminal', 'git', 'console'] };
  assert.deepEqual(rail.normalizeRailLayout(allBelow), { top: ['conversations', 'files', 'chat'], bottom: [...allBelow.bottom, 'llmlog'] });
  assert.deepEqual(rail.panelsInRow(allBelow, 'top', () => true), ['editor', 'chat'], 'the editor still opens on top, and the chat, added where it always was');
  assert.deepEqual(rail.moveRailPanel(allBelow, 'browser', 'top', 0).top, ['browser', 'conversations', 'files', 'chat']);
});

test('each open pane goes to the row of its icon, in order; the editor is first on top', () => {
  const layout = rail.moveRailPanel(rail.moveRailPanel(defaults, 'terminal', 'top', 0), 'browser', 'bottom', 1);
  const open = new Set(['terminal', 'browser', 'editor', 'git', 'conversations', 'files']);
  assert.deepEqual(rail.panelsInRow(layout, 'top', (panel) => open.has(panel)), ['editor', 'terminal']);
  assert.deepEqual(rail.panelsInRow(layout, 'bottom', (panel) => open.has(panel)), ['browser', 'git']);
  assert.equal(rail.isSideColumn('files'), true);
  assert.equal(rail.isSideColumn('git'), false);
  assert.equal(rail.railGroupOf(layout, 'browser'), 'bottom');
});

test('Converses and Fitxers follow their icons: side columns on top, panes of the bottom row below', () => {
  const both = () => true;
  // On top: the side panel's columns, in the order of the icons; not panes of the top row.
  assert.deepEqual(rail.sideColumnsShown(defaults, both), ['conversations', 'files']);
  assert.deepEqual(rail.sideColumnsShown(rail.moveRailPanel(defaults, 'files', 'top', 0), both), ['files', 'conversations']);
  assert.deepEqual(rail.panelsInRow(defaults, 'top', both), ['editor', 'browser', 'evaluation', 'chat']);
  // Fitxers dragged to the bottom group: it leaves the side panel and is a pane of the bottom row, in place.
  const filesBelow = rail.moveRailPanel(defaults, 'files', 'bottom', 2);
  assert.deepEqual(rail.sideColumnsShown(filesBelow, both), ['conversations']);
  assert.deepEqual(rail.panelsInRow(filesBelow, 'bottom', both), ['console', 'terminal', 'files', 'git', 'learning', 'llmlog']);
  // Hidden ones are in neither place.
  assert.deepEqual(rail.sideColumnsShown(defaults, (column) => column === 'files'), ['files']);
  assert.deepEqual(rail.panelsInRow(filesBelow, 'bottom', (panel) => panel !== 'files'), ['console', 'terminal', 'git', 'learning', 'llmlog']);
  // As cel left it: every icon at the bottom, Converses among them: the side panel is empty.
  const asLeft = { top: ['files'], bottom: ['conversations', 'evaluation', 'learning', 'browser', 'console', 'git', 'terminal'] };
  assert.deepEqual(rail.sideColumnsShown(asLeft, both), ['files']);
  assert.deepEqual(rail.panelsInRow(asLeft, 'bottom', both), [...asLeft.bottom, 'llmlog']);
  // Back on top, it is a column again.
  assert.deepEqual(rail.sideColumnsShown(rail.moveRailPanel(asLeft, 'conversations', 'top', 0), both), ['conversations', 'files']);
});
