// Panes opened from an icon of the left bar have no × of their own: the icon is their tab
// (src/app/App.tsx, dockPane and sidePane).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
const closeButtons = [...app.matchAll(/icon=\{X\} label=\{?["'`]?([^"'`}]*)/g)].map((match) => match[1]);

test('the browser, evaluation, Git, learning and terminal panes have no close button: their icon opens and closes them', () => {
  for (const label of ['Tanca el navegador web', 'Tanca l’avaluació', 'Tanca Git', 'Tanca l’aprenentatge local', 'Tanca el terminal']) {
    assert.ok(!closeButtons.includes(label), `${label} should be gone`);
  }
  // Their icons in the left bar are toggles that show which pane is open.
  for (const [icon, open] of [['Globe2', 'browserOpen'], ['ChartBar', 'evaluationOpen'], ['TerminalIcon', 'terminalOpen'], ['GitBranch', 'gitOpen'], ['Brain', 'learningOpen']]) {
    assert.match(app, new RegExp(`icon=\\{${icon}\\}[^\\n]*variant=\\{${open} \\? 'subtle' : 'ghost'\\} colorPalette=\\{${open} \\? 'agentic' : 'gray'\\}`), icon);
  }
});

test('the editor keeps its ×, and the console has one only while the browser (where its button is) is closed', () => {
  assert.match(app, /\{ label: 'Tanca l’editor', onClose: closeEditor \}/);
  assert.match(app, /browserOpen \? undefined : \{ label: 'Tanca la consola', onClose: \(\) => setConsoleOpen\(false\) \}/);
});
