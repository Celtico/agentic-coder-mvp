// Fitxers › «Buida la carpeta»: a button in the panel's header (cel, 17-11-2026), besides the right-click menu.
// The main process asks first, keeps the agent's own files and moves everything else to the Trash.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');

test('the Files header has a button that empties the project, as the right-click menu does', () => {
  assert.match(app, /<IconButton icon=\{Trash\} label="Buida la carpeta \(tot a la paperera\)" disabled=\{!project \|\| loading\} onClick=\{\(\) => void clearProject\(\)\}\/>\n\s*<\/>\}\/>/);
  assert.match(app, /<Menu\.Item value="clear"[^\n]*clearProject\(\)/);
});

test('emptying asks first and only moves to the Trash, never deletes; home and shallow folders are refused', () => {
  const handler = main.slice(main.indexOf("ipcMain.handle('project:clear'"), main.indexOf("ipcMain.handle('project:current'"));
  assert.match(handler, /dialog\.showMessageBox/);
  assert.match(handler, /shell\.trashItem/);
  assert.doesNotMatch(handler, /fs\.rm\(|unlink/);
  assert.match(handler, /root === home/);
  assert.match(handler, /agents\\\.md\|skills\\\.md/);
});
