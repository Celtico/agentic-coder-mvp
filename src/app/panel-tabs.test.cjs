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

test('each pane but the editor has a toggle in the left bar that shows when it is open', () => {
  // The icons are a table (railButtons) so they can move between the top and bottom groups.
  for (const [name, icon, open] of [['browser', 'Globe2', 'browserOpen'], ['evaluation', 'ChartBar', 'evaluationOpen'], ['console', 'Bug', 'consoleOpen'], ['terminal', 'TerminalIcon', 'terminalOpen'], ['git', 'GitBranch', 'gitOpen'], ['learning', 'Brain', 'learningOpen']]) {
    assert.match(app, new RegExp(`${name}: \\{ icon: ${icon}, label: [^\\n]*palette: ${open} \\? 'agentic'`), icon);
  }
  // Plain ghost with no background: open, only the icon is in the accent; closed, muted. The same size for all.
  assert.match(app, /icon=\{button\.icon\} label=\{button\.label\} w="38px" h="38px" variant="ghost" colorPalette=\{button\.palette\} color=\{button\.palette === 'agentic' \? 'colorPalette\.solid' : 'fg\.muted'\} aria-pressed=\{button\.palette === 'agentic'\}/);
  assert.doesNotMatch(app, /variant=\{button\.palette === 'agentic' \? 'solid'/, 'never a full solid background');
  assert.doesNotMatch(app, /bg=\{button\.palette === 'agentic'/, 'no background when open, not even subtle');
  // The console is opened only from the bar now, not from the browser's toolbar as well.
  assert.equal((app.match(/icon=\{Bug\}|icon: Bug\b/g) || []).length, 1);
});

test('the bar: the app’s mark on top, no fold toggle, no «new chat» or editor icon; each column has its +', () => {
  assert.doesNotMatch(app, /editor: \{ icon: FileCode/);
  assert.doesNotMatch(app, /PanelLeftClose|PanelLeftOpen|setNavigationOpen|Amaga converses i fitxers/);
  assert.doesNotMatch(app, /icon=\{MessageSquarePlus\}/);
  // The mark has its own slot, with space below it before the first group, and is always the brand green.
  assert.match(app, /<Center flex="none" w="full" h="10" pt="2" mb="3" role="img" aria-label="Agentic Coder"><Mark size=\{28\} gradient\/><\/Center>/);
  const nav = app.slice(app.indexOf('<Flex as="nav"'), app.indexOf("{railGroup('bottom')}"));
  assert.ok(nav.indexOf('aria-label="Agentic Coder"') < nav.indexOf("{railGroup('top')}"), 'the mark comes before the first group');
  assert.doesNotMatch(nav.slice(0, nav.indexOf("{railGroup('top')}")), /position="absolute"/);
  // The mark's drawing is as big as asked, in pixels: a bare number is a size token (sizes.28 is 112 px)
  // and made it spill over the first icon.
  assert.match(fs.readFileSync(path.join(__dirname, 'mark.tsx'), 'utf8'), /<chakra\.svg viewBox="0 0 24 24" width=\{`\$\{size\}px`\} height=\{`\$\{size\}px`\}/);
  assert.match(app, /<PaneHeader icon=\{Conversations\} title="Converses" actions=\{<><IconButton icon=\{Trash\} label="Paperera de converses" onClick=\{\(\) => void openChatTrash\(\)\}\/><IconButton icon=\{Plus\} label="Nova conversa" onClick=\{\(\) => void newChat\(\)\}\/><\/>\}\/>/);
  assert.match(app, /<PaneHeader icon=\{FileText\} title="Fitxers" subtitle=/);
  assert.match(app, /<Menu\.Trigger asChild><IconButton icon=\{Plus\} label="Nou document o carpeta"/);
  // The visible side columns are the first panes of the top row's one splitter, in the order of their icons.
  assert.match(app, /\.\.\.sideColumns\.map\(\(column\) => \(\{ id: `nav-\$\{column\}`, node: column === 'conversations' \? conversationsColumn : filesColumn \}\)\),\n\s*\.\.\.sideItems,\n\s*\{ id: 'chat', node: chatPane \},/);
  // The same column is a side column or a pane of the bottom row, as its icon's group says.
  assert.match(app, /const sideColumns = sideColumnsShown\(railLayout, /);
  assert.match(app, /case 'conversations': return conversationsColumn;\n\s*case 'files': return filesColumn;/);
  assert.match(app, /const conversationsColumn = \(\n\s*<PaneCard label="Converses"/);
  assert.match(app, /const filesColumn = \(\n\s*<PaneCard label="Fitxers"/);
  assert.match(app, /conversations: \{ icon: Conversations, label: [^\n]*palette: conversationsOpen \? 'agentic'/);
  assert.match(app, /files: \{ icon: FileText, label: [^\n]*palette: filesOpen \? 'agentic'/);
  // With both hidden, they are simply not in the row.
  assert.match(app, /const navigationOpen = navigationColumns > 0;/);
  assert.doesNotMatch(app, /recent-conversations|recentConversationsExpanded/);
  // The project is the Fitxers header's subtitle («AGENT · /path»), with a folder button to choose another.
  const files = app.indexOf('<PaneCard label="Fitxers"');
  const filesHeader = app.slice(files, app.indexOf('<Menu.Trigger asChild><IconButton icon={Plus} label="Nou document o carpeta"', files));
  assert.match(filesHeader, /subtitle=\{project \? `\$\{project\.path\.split/);
  assert.match(filesHeader, /<IconButton icon=\{FolderOpen\} label=\{project \? `\$\{project\.path\} · canvia de projecte`[^}]*\} onClick=\{\(\) => void selectProject\(\)\}\/>/);
  assert.doesNotMatch(app, /<Box flex="none" pt="1"><Button variant="ghost" w="full"/, 'the big project block is gone');
});
