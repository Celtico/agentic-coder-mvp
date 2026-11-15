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

test('Comparativa: each complete run apart, newest first; the newest is shown by default, «Totes» adds them up; cut runs are never counted', () => {
  const { comparisonByModel } = require('./benchmark-summary.cjs');
  const result = (task, pass) => ({ task, pass, seconds: 1 });
  const reports = [
    { id: 'old', at: '2026-11-15T11:47:23.583Z', model: 'vl', results: [result('fix-failing-test', false), result('add-function', true), result('app-react-todo', false)] },
    { id: 'new', at: '2026-11-15T16:51:36.725Z', model: 'vl', results: [result('fix-failing-test', true), result('add-function', true), result('fix-failing-test-directed', true)] },
    { id: 'text', at: '2026-11-13T18:37:06.943Z', model: 'text', results: [result('add-function', true)] },
  ];
  const incomplete = [{ id: 'cut', at: '2026-11-15T11:39:45.115Z', model: 'vl' }, { id: 'cut-only', at: '2026-11-14T10:00:00.000Z', model: 'other' }];
  const [vl, text, other] = comparisonByModel(reports, { labels: { vl: 'MiMo amb visió' }, incomplete });
  assert.equal(vl.label, 'MiMo amb visió');
  assert.equal(vl.latest, 'new');
  assert.deepEqual(vl.runs.map((run) => [run.id, run.passed, run.total]), [['new', 3, 3], ['old', 1, 3]]);
  assert.deepEqual(vl.runs[0].open, { runs: 2, passed: 2 });
  assert.deepEqual(vl.runs[0].reference, { runs: 1, passed: 1 });
  assert.deepEqual(vl.runs[1].apps, { runs: 1, passed: 0 });
  // «Totes»: every complete run added up (the cut one is not a report and does not count).
  assert.deepEqual(vl.all.open, { runs: 4, passed: 3 });
  assert.deepEqual(vl.incomplete, [{ id: 'cut', at: '2026-11-15T11:39:45.115Z' }]);
  assert.equal(text.latest, 'text');
  // A model with only a cut run is listed, with nothing to show.
  assert.deepEqual([other.model, other.latest, other.runs.length, other.all], ['other', null, 0, null]);
  const app = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
  assert.match(app, /const chosen = comparisonChoice\[model\.model\] \?\? model\.latest \?\? 'all';/);
  assert.match(app, /<option key=\{item\.id\} value=\{item\.id\} disabled>[^\n]*incompleta<\/option>/);
});
