const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeReports, renderBenchmarkSvg, renderBenchmarkTable } = require('./benchmark-summary.cjs');

const result = (task, pass, seconds = 10, detail = '') => ({ task, pass, seconds, detail });
const reports = [
  { model: 'org/a', at: '2026-11-13T10:00:00Z', results: [result('fix-failing-test', true), result('fix-failing-test-directed', true), result('app-chakra-ui', false, 1200, 'Chakra UI ^2.0.0, no la v3')] },
  { model: 'org/a', at: '2026-11-13T12:00:00Z', results: [result('fix-failing-test', false, 20, 'toca el test'), result('app-chakra-ui', true, 300)] },
  { model: 'org/b', at: '2026-11-13T09:00:00Z', results: [result('create-html-page', true)] },
];

test('reports of the same model add up; the reference task and the apps are counted apart', () => {
  const [a, b] = summarizeReports(reports, { labels: { 'org/a': 'Model A' }, notes: { 'org/b': 'codi d’abans' }, peakMemoryMb: { 'org/a': 9600 } });
  assert.equal(a.label, 'Model A');
  assert.deepEqual(a.open, { runs: 2, passed: 1 });
  assert.deepEqual(a.reference, { runs: 1, passed: 1 });
  assert.deepEqual(a.apps, { runs: 2, passed: 1 });
  assert.equal(a.at, '2026-11-13T12:00:00Z');
  assert.deepEqual(a.tasks['app-chakra-ui'].details, ['Chakra UI ^2.0.0, no la v3']);
  assert.equal(a.peakMemoryMb, 9600);
  assert.equal(b.note, 'codi d’abans');
  assert.deepEqual(b.apps, { runs: 0, passed: 0 });
});

test('the chart and the table show every model with its numbers', () => {
  const models = summarizeReports(reports, { labels: { 'org/a': 'Model <A>' } });
  const svg = renderBenchmarkSvg(models);
  assert.match(svg, /^<svg /);
  assert.match(svg, /Model &lt;A&gt;/);
  assert.match(svg, /1\/2/);
  const table = renderBenchmarkTable(models);
  assert.match(table, /\| Model <A> \| 1\/2 \(50 %\) \| 1\/2 \(50 %\) \| 1\/1 \(100 %\) \|/);
  assert.match(table, /\| org\/b \| 1\/1 \(100 %\) \| — \|/);
});
