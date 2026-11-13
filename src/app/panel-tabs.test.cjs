// Every pane opens and closes from its icon in the left bar, its tab; no pane has a × of its own
// (src/app/App.tsx, dockPane, sidePane, the evaluation card and the terminal).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
const closeButtons = [...app.matchAll(/icon=\{X\} label=\{?["'`]?([^"'`}]*)/g)].map((match) => match[1]);

test('no pane has a close button in its header', () => {
  for (const label of ['Tanca l’editor', 'Tanca el navegador web', 'Tanca l’avaluació', 'Tanca Git', 'Tanca l’aprenentatge local', 'Tanca la consola', 'Tanca el terminal']) {
    assert.ok(!closeButtons.includes(label), `${label} should be gone`);
  }
  assert.doesNotMatch(app, /close\?: \{ label/);
});

test('each pane has a toggle in the left bar that shows when it is open', () => {
  for (const [icon, open] of [['FileCode', 'editorOpen'], ['Globe2', 'browserOpen'], ['ChartBar', 'evaluationOpen'], ['Bug', 'consoleOpen'], ['TerminalIcon', 'terminalOpen'], ['GitBranch', 'gitOpen'], ['Brain', 'learningOpen']]) {
    assert.match(app, new RegExp(`icon=\\{${icon}\\}[^\\n]*w="38px" h="38px" variant=\\{${open} \\? 'subtle' : 'ghost'\\} colorPalette=\\{${open} \\? 'agentic'`), icon);
  }
  // The console is opened only from the bar now, not from the browser's toolbar as well.
  assert.equal((app.match(/icon=\{Bug\}/g) || []).length, 1);
});
