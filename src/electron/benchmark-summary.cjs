// Turns benchmark reports (scripts/evaluate-agent.cjs) into the comparison shown in the README and in
// the app's evaluation panel: per model, the open tasks (the reference task apart), the whole apps
// from an empty folder, time and memory, and an SVG chart of it. No model is involved here.

const APP_TASK = /^app-/;

function rate(passed, runs) { return runs ? passed / runs : 0; }

/**
 * Several reports of the same model (for instance one per round, or a run split in two) add up.
 * `reports` are the JSON files evaluate-agent writes; `notes` maps a model id to a remark.
 */
function summarizeReports(reports, { notes = {}, labels = {}, peakMemoryMb = {} } = {}) {
  const byModel = new Map();
  for (const report of reports) {
    if (!report || !Array.isArray(report.results)) continue;
    const key = report.model;
    const entry = byModel.get(key) || { model: key, label: labels[key] || key, at: report.at, results: [] };
    entry.results.push(...report.results);
    if (report.at > entry.at) entry.at = report.at;
    byModel.set(key, entry);
  }
  const referenceIds = new Set(['fix-failing-test-directed']);
  return [...byModel.values()].map((entry) => {
    const pick = (filter) => {
      const runs = entry.results.filter(filter);
      return { runs: runs.length, passed: runs.filter((result) => result.pass).length };
    };
    const open = pick((result) => !referenceIds.has(result.task) && !APP_TASK.test(result.task));
    const apps = pick((result) => APP_TASK.test(result.task));
    const reference = pick((result) => referenceIds.has(result.task));
    const tasks = {};
    for (const result of entry.results) {
      const task = tasks[result.task] || (tasks[result.task] = { runs: 0, passed: 0, seconds: 0, details: [] });
      task.runs += 1; if (result.pass) task.passed += 1; task.seconds += result.seconds || 0;
      if (!result.pass && result.detail) task.details.push(String(result.detail).slice(0, 200));
    }
    for (const task of Object.values(tasks)) task.meanSeconds = Number((task.seconds / task.runs).toFixed(1));
    const seconds = entry.results.reduce((sum, result) => sum + (result.seconds || 0), 0);
    return {
      model: entry.model, label: entry.label, at: entry.at, open, apps, reference, tasks,
      meanSeconds: entry.results.length ? Number((seconds / entry.results.length).toFixed(1)) : 0,
      ...(peakMemoryMb[entry.model] ? { peakMemoryMb: peakMemoryMb[entry.model] } : {}),
      ...(notes[entry.model] ? { note: notes[entry.model] } : {}),
    };
  });
}

const escapeXml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** A horizontal bar chart, one group per model: open tasks, apps from an empty folder, reference task. */
function renderBenchmarkSvg(models, { title = 'Benchmark de l’agent amb models locals' } = {}) {
  const series = [
    { key: 'open', label: 'Tasques obertes', color: '#2f9e75' },
    { key: 'apps', label: 'Apps des de carpeta buida', color: '#d9822b' },
    { key: 'reference', label: 'Tasca dirigida (referència)', color: '#8a8f98' },
  ];
  const width = 760; const left = 210; const right = 70; const barHeight = 16; const gap = 4; const groupGap = 22;
  const top = 74; const chartWidth = width - left - right;
  const groupHeight = series.length * (barHeight + gap) - gap;
  const height = top + models.length * (groupHeight + groupGap) + 44;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">`);
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  parts.push(`<text x="20" y="30" font-size="17" font-weight="600" fill="#1f2328">${escapeXml(title)}</text>`);
  series.forEach((item, index) => {
    const x = 20 + index * 230;
    parts.push(`<rect x="${x}" y="44" width="12" height="12" rx="2" fill="${item.color}"/><text x="${x + 18}" y="54" font-size="12" fill="#57606a">${escapeXml(item.label)}</text>`);
  });
  for (let tick = 0; tick <= 100; tick += 25) {
    const x = left + (chartWidth * tick) / 100;
    parts.push(`<line x1="${x}" y1="${top - 6}" x2="${x}" y2="${height - 36}" stroke="#d0d7de" stroke-width="1"/><text x="${x}" y="${height - 20}" font-size="11" fill="#57606a" text-anchor="middle">${tick}%</text>`);
  }
  models.forEach((model, modelIndex) => {
    const y0 = top + modelIndex * (groupHeight + groupGap);
    parts.push(`<text x="${left - 12}" y="${y0 + groupHeight / 2 - 2}" font-size="13" font-weight="600" fill="#1f2328" text-anchor="end">${escapeXml(model.label)}</text>`);
    if (model.note) parts.push(`<text x="${left - 12}" y="${y0 + groupHeight / 2 + 13}" font-size="10" fill="#8a8f98" text-anchor="end">${escapeXml(model.note)}</text>`);
    series.forEach((item, index) => {
      const value = model[item.key];
      const y = y0 + index * (barHeight + gap);
      const share = rate(value.passed, value.runs);
      parts.push(`<rect x="${left}" y="${y}" width="${chartWidth}" height="${barHeight}" rx="3" fill="#f3f4f6"/>`);
      if (share > 0) parts.push(`<rect x="${left}" y="${y}" width="${Math.max(2, chartWidth * share)}" height="${barHeight}" rx="3" fill="${item.color}"/>`);
      parts.push(`<text x="${left + chartWidth + 8}" y="${y + barHeight - 4}" font-size="11" fill="#1f2328">${value.runs ? `${value.passed}/${value.runs}` : '—'}</text>`);
    });
  });
  parts.push('</svg>');
  return parts.join('\n');
}

/** The comparison as a Markdown table, for the README. */
function renderBenchmarkTable(models) {
  const fraction = (value) => (value.runs ? `${value.passed}/${value.runs} (${Math.round(rate(value.passed, value.runs) * 100)} %)` : '—');
  const lines = ['| Model | Tasques obertes | Apps des de carpeta buida | Tasca dirigida | Temps mitjà per tasca | Memòria pic |', '| --- | --- | --- | --- | --- | --- |'];
  for (const model of models) {
    lines.push(`| ${model.label}${model.note ? ` (${model.note})` : ''} | ${fraction(model.open)} | ${fraction(model.apps)} | ${fraction(model.reference)} | ${model.meanSeconds} s | ${model.peakMemoryMb ? `${(model.peakMemoryMb / 1024).toFixed(1)} GB` : '—'} |`);
  }
  return lines.join('\n');
}

/**
 * The evaluation panel's Comparativa: per model, each completed run on its own (newest first) and all
 * of them added up. The panel shows the newest one by default: an old run (one from before a fix, say)
 * no longer weighs on the score unless «Totes» is chosen. A run cut before its end has no report and is
 * listed apart (`incomplete`), never counted.
 */
// The engine a run used (the report's «runtime»): the native one, CUDA on Linux, or else Python (also the runs
// made before the native engine, which have «mlx» or nothing).
const engineName = (runtime) => (runtime === 'native' ? 'natiu' : runtime === 'cuda' ? 'CUDA' : 'Python');

/** One row per model and engine (so the native and the Python engine of a model are compared side by side). */
function comparisonByModel(reports, { labels = {}, incomplete = [] } = {}) {
  const byModel = new Map();
  const keyOf = (run) => `${run.model} · ${engineName(run.runtime)}`;
  const labelOf = new Map();
  for (const report of reports) {
    if (!report || !Array.isArray(report.results)) continue;
    byModel.set(keyOf(report), [...(byModel.get(keyOf(report)) || []), report]);
    labelOf.set(keyOf(report), `${labels[report.model] || report.model} · ${engineName(report.runtime)}`);
  }
  for (const run of incomplete) {
    if (!byModel.has(keyOf(run))) byModel.set(keyOf(run), []);
    if (!labelOf.has(keyOf(run))) labelOf.set(keyOf(run), `${labels[run.model] || run.model} · ${engineName(run.runtime)}`);
  }
  return [...byModel.entries()].map(([model, list]) => {
    const runs = [...list].sort((a, b) => String(b.at).localeCompare(String(a.at))).map((report) => {
      const [summary] = summarizeReports([report], { labels });
      return { id: report.id, at: report.at, open: summary.open, apps: summary.apps, reference: summary.reference, passed: report.results.filter((result) => result.pass).length, total: report.results.length };
    });
    const [all] = summarizeReports(list, { labels });
    return {
      model, label: labelOf.get(model) || model, latest: runs[0]?.id || null, runs,
      all: all ? { open: all.open, apps: all.apps, reference: all.reference } : null,
      incomplete: incomplete.filter((run) => keyOf(run) === model).map(({ id, at, done, total, passed }) => ({ id, at, ...(done !== undefined ? { done, total, passed } : {}) })),
    };
  }).filter((entry) => entry.runs.length || entry.incomplete.length);
}

module.exports = { summarizeReports, comparisonByModel, renderBenchmarkSvg, renderBenchmarkTable };
