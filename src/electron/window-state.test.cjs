// The main window opens where it was left (src/electron/window-state.cjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readWindowState, writeWindowState, windowBounds, DEFAULTS } = require('./window-state.cjs');

const laptop = { x: 0, y: 25, width: 1512, height: 944 };
const external = { x: 1512, y: 0, width: 2560, height: 1415 };

test('saved state is written and read back; a missing or broken file gives nothing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-window-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'window-state.json');
  assert.equal(readWindowState(file), null);
  writeWindowState(file, { bounds: { x: 10.4, y: 40, width: 1300, height: 800 }, maximized: true, fullScreen: false });
  assert.deepEqual(readWindowState(file), { bounds: { x: 10, y: 40, width: 1300, height: 800 }, maximized: true, fullScreen: false });
  fs.writeFileSync(file, '{"bounds":{"x":"a"}}');
  assert.equal(readWindowState(file), null);
});

test('the window opens where it was, on any screen that is still there', () => {
  const saved = { bounds: { x: 1700, y: 100, width: 1600, height: 1000 } };
  assert.deepEqual(windowBounds(saved, [laptop, external]), { x: 1700, y: 100, width: 1600, height: 1000 });
});

test('if its screen is gone it is centred on the main one, made to fit', () => {
  const saved = { bounds: { x: 1700, y: 100, width: 1600, height: 1000 } };
  const bounds = windowBounds(saved, [laptop]);
  assert.deepEqual(bounds, { x: 0, y: 25, width: 1512, height: 944 });
});

test('a window mostly off the screen, or with its title bar out of reach, is brought back', () => {
  assert.notEqual(windowBounds({ bounds: { x: 1400, y: 100, width: 1200, height: 800 } }, [laptop]).x, 1400);
  assert.notEqual(windowBounds({ bounds: { x: 100, y: -500, width: 1200, height: 800 } }, [laptop]).y, -500);
});

test('without anything saved it opens at the default size, centred, and never below the minimum', () => {
  assert.deepEqual(windowBounds(null, [external]), { x: 1512 + (2560 - 1440) / 2, y: 248, width: 1440, height: 920 });
  const tiny = windowBounds({ bounds: { x: 0, y: 25, width: 300, height: 200 } }, [laptop]);
  assert.equal(tiny.width, DEFAULTS.minWidth);
  assert.equal(tiny.height, DEFAULTS.minHeight);
});
