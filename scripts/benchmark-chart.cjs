// Draws docs/benchmark.svg and prints the Markdown table of the README from benchmark reports.
//
//   node scripts/benchmark-chart.cjs logs/benchmarks/agent-*.json \
//     --label mlx-community/Qwen2.5-Coder-7B-Instruct-4bit="Qwen2.5-Coder 7B" \
//     --note mlx-community/Qwen2.5-Coder-7B-Instruct-4bit="codi del 13-11 al matí" \
//     --memory lmstudio-community/gemma-4-12B-it-MLX-4bit=9618 \
//     --out docs/benchmark.svg
//
// Reports of the same model add up (one per round, or a run split in two). Labels, notes and peak
// memory (MB) are given by model id; the model labels of the app are used when there is none.
const fs = require('node:fs');
const path = require('node:path');
const { summarizeReports, renderBenchmarkSvg, renderBenchmarkTable } = require('../src/electron/benchmark-summary.cjs');
const { builtInModels } = require('../src/electron/mlx-models.cjs');

const files = [];
const labels = Object.fromEntries(builtInModels.map((model) => [model.modelId, model.label.replace(/ · MLX$/, '')]));
const notes = {};
const peakMemoryMb = {};
let out = path.join(__dirname, '..', 'docs', 'benchmark.svg');
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  const pair = () => { const value = argv[++index] || ''; const at = value.indexOf('='); if (at < 1) throw new Error(`${arg} vol model=valor`); return [value.slice(0, at), value.slice(at + 1)]; };
  if (arg === '--label') { const [key, value] = pair(); labels[key] = value; }
  else if (arg === '--note') { const [key, value] = pair(); notes[key] = value; }
  else if (arg === '--memory') { const [key, value] = pair(); peakMemoryMb[key] = Number(value); }
  else if (arg === '--out') out = path.resolve(argv[++index]);
  else files.push(arg);
}
if (!files.length) { console.error('Indica els informes del benchmark (logs/benchmarks/agent-*.json).'); process.exit(1); }
const reports = files.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
const models = summarizeReports(reports, { labels, notes, peakMemoryMb });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${renderBenchmarkSvg(models)}\n`);
console.log(renderBenchmarkTable(models));
console.error(`Gràfic: ${path.relative(process.cwd(), out)}`);
