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

const defaults = { top: ['browser', 'evaluation'], bottom: ['console', 'terminal', 'git', 'learning'] };

test('the default layout: the editor and «new chat» have no icon any more', () => {
  assert.deepEqual(rail.defaultRailLayout(), defaults);
  assert.ok(!rail.RAIL_PANELS.includes('editor'));
});

test('an icon dragged to the other group goes where it is dropped', () => {
  assert.deepEqual(rail.moveRailPanel(defaults, 'terminal', 'top', 1), { top: ['browser', 'terminal', 'evaluation'], bottom: ['console', 'git', 'learning'] });
  assert.deepEqual(rail.moveRailPanel(defaults, 'browser', 'bottom', 0), { top: ['evaluation'], bottom: ['browser', 'console', 'terminal', 'git', 'learning'] });
  assert.deepEqual(rail.moveRailPanel(defaults, 'evaluation', 'bottom', 99), { top: ['browser'], bottom: ['console', 'terminal', 'git', 'learning', 'evaluation'] });
  assert.deepEqual(rail.moveRailPanel(defaults, 'git', 'top', -3).top, ['git', 'browser', 'evaluation']);
});

test('inside its group an icon is reordered, counting the slot as shown while dragging', () => {
  assert.deepEqual(rail.moveRailPanel(defaults, 'browser', 'top', 2).top, ['evaluation', 'browser']);
  assert.deepEqual(rail.moveRailPanel(defaults, 'learning', 'bottom', 0).bottom, ['learning', 'console', 'terminal', 'git']);
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

test('a saved layout drops unknown, retired and repeated ids, and adds the panes it does not name', () => {
  assert.deepEqual(rail.normalizeRailLayout(null), defaults);
  assert.deepEqual(rail.normalizeRailLayout('top'), defaults);
  assert.deepEqual(rail.normalizeRailLayout({ top: ['git', 'nope', 42, 'git'], bottom: 'browser' }), { top: ['git', 'browser', 'evaluation'], bottom: ['console', 'terminal', 'learning'] });
  // A pane named in both groups stays in the first one it appears in.
  assert.deepEqual(rail.normalizeRailLayout({ top: ['terminal'], bottom: ['terminal', 'browser'] }), { top: ['terminal', 'evaluation'], bottom: ['browser', 'console', 'git', 'learning'] });
  // Saved before the editor and «new chat» left the bar: those ids go, the rest keeps its order.
  assert.deepEqual(rail.normalizeRailLayout({ top: ['editor', 'terminal', 'browser', 'newChat', 'evaluation'], bottom: ['git', 'console', 'learning'] }), { top: ['terminal', 'browser', 'evaluation'], bottom: ['git', 'console', 'learning'] });
  assert.deepEqual(rail.normalizeRailLayout({ top: ['browser'], bottom: ['editor', 'git', 'terminal', 'console'] }), { top: ['browser', 'evaluation'], bottom: ['git', 'terminal', 'console', 'learning'] });
});

test('the layouts saved on this Mac before and after the editor left the bar load cleanly', () => {
  // As saved while the editor still had an icon, and as saved since (every icon moved to the bottom).
  assert.deepEqual(rail.normalizeRailLayout({ top: ['browser', 'editor', 'learning'], bottom: ['evaluation', 'terminal', 'git', 'console'] }), { top: ['browser', 'learning'], bottom: ['evaluation', 'terminal', 'git', 'console'] });
  const allBelow = { top: [], bottom: ['evaluation', 'learning', 'browser', 'terminal', 'git', 'console'] };
  assert.deepEqual(rail.normalizeRailLayout(allBelow), allBelow);
  assert.deepEqual(rail.panelsInRow(allBelow, 'top', () => true), ['editor'], 'the editor still opens on top');
  // An icon can be dragged back into the empty top group.
  assert.deepEqual(rail.moveRailPanel(allBelow, 'browser', 'top', 0).top, ['browser']);
});

test('each open pane goes to the row of its icon, in the order of the icons; the editor is first on top', () => {
  const layout = rail.moveRailPanel(rail.moveRailPanel(defaults, 'terminal', 'top', 0), 'browser', 'bottom', 1);
  const open = new Set(['terminal', 'browser', 'editor', 'git']);
  assert.deepEqual(rail.panelsInRow(layout, 'top', (panel) => open.has(panel)), ['editor', 'terminal']);
  assert.deepEqual(rail.panelsInRow(layout, 'bottom', (panel) => open.has(panel)), ['browser', 'git']);
  assert.deepEqual(rail.panelsInRow(defaults, 'top', (panel) => panel === 'editor'), ['editor']);
  assert.equal(rail.railGroupOf(layout, 'browser'), 'bottom');
  assert.equal(rail.railGroupOf(layout, 'terminal'), 'top');
});
