// A tool call the app could not read is not shown as the answer's text (src/app/tool-call-markup.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-tool-markup-'));
const out = path.join(dir, 'markup.cjs');
esbuild.buildSync({ entryPoints: [path.join(__dirname, 'tool-call-markup.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
const { splitToolCallMarkup } = require(out);
fs.rmSync(dir, { recursive: true, force: true });

test('the markup goes out of what is shown; the text around it stays', () => {
  const answer = 'Vull veure el fitxer on es defineixen aquests colors.<tool_call><function=call_mcp_tool>{"server": "x", "tool": "search_text"}</tool_call>\n\nDesprés ho miro.';
  const shown = splitToolCallMarkup(answer);
  assert.equal(shown.text, 'Vull veure el fitxer on es defineixen aquests colors.\n\nDesprés ho miro.');
  assert.deepEqual(shown.calls, ['<tool_call><function=call_mcp_tool>{"server": "x", "tool": "search_text"}</tool_call>']);
  // Cut at the end, and Gemma's form.
  assert.deepEqual(splitToolCallMarkup('Hola <tool_call>{"name": "x"').calls, ['<tool_call>{"name": "x"']);
  assert.equal(splitToolCallMarkup('<|tool_call>call:x{}<tool_call|>').text, '');
  assert.deepEqual(splitToolCallMarkup('Text normal, sense crides.'), { text: 'Text normal, sense crides.', calls: [] });
});

test('only the display changes: the conversation and the history keep the answer as the model wrote it', () => {
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  assert.match(app, /const shown = splitToolCallMarkup\(message\.text\);/);
  assert.match(app, /'Crida a eina no llegida'/);
  assert.equal((app.match(/splitToolCallMarkup\(/g) || []).length, 1, 'used only where the message is shown');
  assert.match(app, /const history = messages\.slice\(-100\)\.filter\(\(message\) => !isWindowNotice\(message\)\)\.map\(\(message\) => \(\{ role: message\.role, content: message\.text \}\)\);/);
});
