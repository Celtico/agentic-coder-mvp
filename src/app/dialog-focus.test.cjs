// When a dialog opens, the focus goes to its content (first tab, first field or main button), not to the ✕.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');

test('every dialog opens with the focus on what is marked data-initial-focus in it', () => {
  const roots = source.match(/<Dialog\.Root\b[^>]*>/g) || [];
  assert.ok(roots.length >= 8);
  for (const root of roots) assert.match(root, /initialFocusEl=\{focusDialogContent\}/, root);
  assert.match(source, /\[data-scope="dialog"\]\[data-part="content"\]\[data-state="open"\] \[data-initial-focus\]/);
  // One mark per dialog (two of them mark both their field and, by autoFocus, the same element).
  assert.ok((source.match(/data-initial-focus/g) || []).length >= 8 + 1);
  assert.match(source, /<Tabs\.Trigger value="model" data-initial-focus>/, 'Preferències: the first tab');
});
