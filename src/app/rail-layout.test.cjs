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

const defaults = { top: ['editor', 'browser', 'evaluation'], bottom: ['console', 'terminal', 'git', 'learning'] };

test('the default layout is the bar as it was', () => {
  assert.deepEqual(rail.defaultRailLayout(), defaults);
});

test('an icon dragged to the other group goes where it is dropped', () => {
  assert.deepEqual(rail.moveRailPanel(defaults, 'terminal', 'top', 1), { top: ['editor', 'terminal', 'browser', 'evaluation'], bottom: ['console', 'git', 'learning'] });
  assert.deepEqual(rail.moveRailPanel(defaults, 'browser', 'bottom', 0), { top: ['editor', 'evaluation'], bottom: ['browser', 'console', 'terminal', 'git', 'learning'] });
  assert.deepEqual(rail.moveRailPanel(defaults, 'editor', 'bottom', 99), { top: ['browser', 'evaluation'], bottom: ['console', 'terminal', 'git', 'learning', 'editor'] });
  assert.deepEqual(rail.moveRailPanel(defaults, 'git', 'top', -3).top, ['git', 'editor', 'browser', 'evaluation']);
});

test('inside its group an icon is reordered, counting the slot as shown while dragging', () => {
  assert.deepEqual(rail.moveRailPanel(defaults, 'editor', 'top', 3).top, ['browser', 'evaluation', 'editor']);
  assert.deepEqual(rail.moveRailPanel(defaults, 'editor', 'top', 2).top, ['browser', 'editor', 'evaluation']);
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

test('a saved layout drops unknown and repeated ids and adds the panes it does not name', () => {
  assert.deepEqual(rail.normalizeRailLayout(null), defaults);
  assert.deepEqual(rail.normalizeRailLayout('top'), defaults);
  assert.deepEqual(rail.normalizeRailLayout({ top: ['git', 'nope', 42, 'git'], bottom: 'editor' }), { top: ['git', 'editor', 'browser', 'evaluation'], bottom: ['console', 'terminal', 'learning'] });
  // A pane named in both groups stays in the first one it appears in.
  assert.deepEqual(rail.normalizeRailLayout({ top: ['terminal'], bottom: ['terminal', 'editor'] }), { top: ['terminal', 'browser', 'evaluation'], bottom: ['editor', 'console', 'git', 'learning'] });
  // An older save without a pane added since: the new pane goes to its default group.
  assert.deepEqual(rail.normalizeRailLayout({ top: ['browser', 'editor'], bottom: ['git', 'terminal', 'console'] }), { top: ['browser', 'editor', 'evaluation'], bottom: ['git', 'terminal', 'console', 'learning'] });
});

test('each open pane goes to the row of its icon, in the order of the icons', () => {
  const layout = rail.moveRailPanel(rail.moveRailPanel(defaults, 'terminal', 'top', 0), 'browser', 'bottom', 1);
  const open = new Set(['terminal', 'browser', 'editor', 'git']);
  assert.deepEqual(rail.panelsInRow(layout, 'top', (panel) => open.has(panel)), ['terminal', 'editor']);
  assert.deepEqual(rail.panelsInRow(layout, 'bottom', (panel) => open.has(panel)), ['browser', 'git']);
  assert.equal(rail.railGroupOf(layout, 'browser'), 'bottom');
  assert.equal(rail.railGroupOf(layout, 'terminal'), 'top');
});
