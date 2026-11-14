// The iteration the agent is on, as the chat shows it while it works (src/app/turn-progress.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-turn-progress-'));
const out = path.join(dir, 'turn-progress.cjs');
esbuild.buildSync({ entryPoints: [path.join(__dirname, 'turn-progress.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
const progress = require(out);
fs.rmSync(dir, { recursive: true, force: true });

test('«Iteració i de N», with the tool when one runs; nothing before the first iteration', () => {
  assert.equal(progress.turnProgressText({ iteration: 9, maxIterations: 28 }), 'Iteració 9 de 28');
  assert.equal(progress.turnProgressText({ iteration: 9, maxIterations: 28, tool: 'start_project' }), 'Iteració 9 de 28 · start_project');
  assert.equal(progress.turnProgressText({ iteration: 3, maxIterations: 16 }), 'Iteració 3 de 16', 'compact mode: its own limit');
  assert.equal(progress.turnProgressText(null), '');
  assert.equal(progress.turnProgressText({ iteration: 0, maxIterations: 28 }), '');
});

test('a progress status carries iteration and maxIterations; any other status is not progress', () => {
  assert.deepEqual(progress.progressFromStatus({ type: 'progress', iteration: 2, maxIterations: 28, tool: 'read_file' }), { iteration: 2, maxIterations: 28, tool: 'read_file' });
  assert.equal(progress.progressFromStatus({ type: 'status', message: 'Llegint…' }), null);
  assert.equal(progress.progressFromStatus({ type: 'progress', iteration: '2', maxIterations: 28 }), null);
});

test('the chat’s indicator and the status bar show it, muted, at the indicator’s size', () => {
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  assert.match(app, /<Text fontSize="xs" lineHeight="short">\{loadingLabel\}<\/Text>\{turnProgressText\(turnProgress\) && <Text fontSize="xs" lineHeight="short" color="fg\.muted" flex="none" data-turn-progress>\{turnProgressText\(turnProgress\)\}<\/Text>\}/);
  assert.match(app, /\{loading \? \[turnProgressText\(turnProgress\), loadingLabel\]\.filter\(Boolean\)\.join\(' · '\)/);
  assert.match(app, /const progress = progressFromStatus\(s\);\n\s*if \(progress\) \{ setTurnProgress\(progress\); return; \}/);
});
