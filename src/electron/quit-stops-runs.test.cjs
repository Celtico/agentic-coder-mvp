// Quitting the app stops an evaluation or a training: they run in a process group of their own and would
// otherwise stay on the GPU with their model after the app is gone (15-11-2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('before-quit aborts the evaluation and the training, which kill their whole process group', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  assert.match(main, /app\.on\('before-quit', \(\) => \{[^]*?benchmarkRun\?\.controller\.abort\(\); trainingRun\?\.controller\.abort\(\);\n\}\);/);
  assert.match(main, /const stop = \(\) => \{ try \{ process\.kill\(-child\.pid, 'SIGTERM'\); \} catch \{\} \};/);
});
