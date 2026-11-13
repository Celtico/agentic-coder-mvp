// The main window opens where it was left: same size and place, maximized or full screen if it was.
// Saved as window-state.json in the app's data folder. If the place is no longer on a screen (a
// display was unplugged), the window is centred on the main screen at its saved size, made to fit.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = { width: 1440, height: 920, minWidth: 980, minHeight: 680 };

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** Reads what was saved; anything missing or broken gives null. */
function readWindowState(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bounds = saved?.bounds;
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(isNumber)) return null;
    return { bounds: { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) }, maximized: saved.maximized === true, fullScreen: saved.fullScreen === true };
  } catch { return null; }
}

function writeWindowState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  } catch { /* only a convenience: the window opens at its default size next time */ }
}

const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * Where to open the window. `displays` are the work areas of the screens ({x, y, width, height}),
 * the main one first. Saved bounds are kept if at least a quarter of the window, and its top edge
 * (where it is dragged from), are on a screen; otherwise it is centred on the main screen.
 */
function windowBounds(saved, displays, defaults = DEFAULTS) {
  const main = displays[0];
  const fit = (width, height, area) => ({ width: Math.max(defaults.minWidth, Math.min(width, area.width)), height: Math.max(defaults.minHeight, Math.min(height, area.height)) });
  if (!saved || !main) {
    if (!main) return { width: defaults.width, height: defaults.height };
    const size = fit(defaults.width, defaults.height, main);
    return { x: Math.round(main.x + (main.width - size.width) / 2), y: Math.round(main.y + (main.height - size.height) / 2), ...size };
  }
  const { bounds } = saved;
  const size = { width: Math.max(defaults.minWidth, bounds.width), height: Math.max(defaults.minHeight, bounds.height) };
  const rect = { x: bounds.x, y: bounds.y, ...size };
  const titleBar = { x: rect.x, y: rect.y, width: rect.width, height: 28 };
  const visible = displays.some((area) => overlap(rect, area) >= (rect.width * rect.height) / 4 && overlap(titleBar, area) > 0);
  if (visible) return rect;
  const centred = fit(size.width, size.height, main);
  return { x: Math.round(main.x + (main.width - centred.width) / 2), y: Math.round(main.y + (main.height - centred.height) / 2), ...centred };
}

module.exports = { readWindowState, writeWindowState, windowBounds, DEFAULTS };
