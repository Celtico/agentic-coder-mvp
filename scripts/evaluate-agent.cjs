// Repeatable benchmark of the coding agent with the real local model.
//
//   npm run evaluate:agent                      # every task once with the base model, MiMo 9B (MLX)
//   npm run evaluate:agent -- --model gemma     # another MLX model: id or alias from src/electron/mlx-models.cjs
//   npm run evaluate:agent -- --task add-function --repeat 3
//   npm run evaluate:agent -- --list
//
// Each task runs in a new temporary folder with its own files; the result is judged by objective
// checks on that folder (tests pass, protected files untouched, files present), not by a model.
// A JSON report and the model's raw turns are written under logs/benchmarks/ (ignored by Git).
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const modelsRoot = process.env.AGENT_MODELS_DIR || path.join(repoRoot, 'models');
const mlxModels = require('../src/electron/mlx-models.cjs');

function parseArgs(argv) {
  const options = { model: mlxModels.DEFAULT_MODEL_ID, tasks: [], repeat: 1, keep: false, list: false, timeoutMinutes: 10 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => { const value = argv[++index]; if (value === undefined) throw new Error(`Falta el valor de ${arg}`); return value; };
    if (arg === '--model') options.model = next();
    else if (arg === '--task') options.tasks.push(...next().split(',').map((value) => value.trim()).filter(Boolean));
    else if (arg === '--repeat') options.repeat = Math.max(1, Number.parseInt(next(), 10) || 1);
    else if (arg === '--timeout') options.timeoutMinutes = Math.max(1, Number(next()) || 10);
    else if (arg === '--out') options.out = path.resolve(next());
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--list') options.list = true;
    else throw new Error(`Opció desconeguda: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { tasks } = require('./agent-benchmark/tasks.cjs');
  if (options.list) {
    for (const task of tasks) console.log(`${task.id}\n  ${task.description}\n  «${task.prompt}»`);
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // With --out (as the app runs it) nothing is written inside the repository or the app bundle.
  const outDir = options.out ? path.dirname(options.out) : path.join(repoRoot, 'logs', 'benchmarks');
  fs.mkdirSync(outDir, { recursive: true });
  const model = await mlxModels.findModel(modelsRoot, options.model);
  if (!model) throw new Error(`Model desconegut: ${options.model} (opcions: ${(await mlxModels.listModels(modelsRoot)).map((item) => [item.id, ...item.aliases].join('/')).join(', ')})`);
  const modelDirectory = await mlxModels.modelDirectory(model, modelsRoot);
  if (!modelDirectory) throw new Error(`No s’han trobat els pesos de ${model.label} a models/.`);
  // The same environment the app gives its model worker (src/electron/main.cjs), set before the
  // runtime is loaded because it reads some of it at load time.
  Object.assign(process.env, {
    AGENT_MODEL_CACHE: modelsRoot,
    AGENT_MODEL_RUNTIME: model.runtime,
    AGENT_MODEL: model.modelId,
    AGENT_MLX_PYTHON: process.env.AGENT_MLX_PYTHON || path.join(modelsRoot, '.mlx-venv', 'bin', 'python'),
    AGENT_MLX_MODEL_PATH: modelDirectory,
    AGENT_TURN_LOG: process.env.AGENT_TURN_LOG || path.join(outDir, `turns-${model.id}-${stamp}.jsonl`),
  });

  const { LocalCodingAgent, MlxInferenceEngine } = require('../src/core/assistant/agent-runtime.cjs');
  const { runBenchmark } = require('./agent-benchmark/run.cjs');
  const engine = new MlxInferenceEngine();
  console.error(`Model: ${model.modelId} (${model.runtime}). Carregant…`);
  const loadStarted = Date.now();
  await engine.loadModel((message) => console.error(message));
  const loadSeconds = Number(((Date.now() - loadStarted) / 1000).toFixed(1));

  let report;
  try {
    report = await runBenchmark({
      LocalCodingAgent, engine, taskIds: options.tasks, repeat: options.repeat, keep: options.keep, timeoutMs: options.timeoutMinutes * 60000,
      // «TASCA n/total id #run» as each task starts: the app's evaluation panel shows it live.
      onStart: ({ task, run, index, total }) => console.error(`TASCA ${index}/${total} ${task} #${run}`),
      onResult: (result) => console.error(`${result.pass ? 'PASSA' : 'FALLA'}  ${result.task} #${result.run}  ${result.seconds}s  eines:${result.toolCalls}  ${result.detail}`),
    });
  } finally {
    await engine.unloadModel().catch(() => {});
  }
  const out = options.out || path.join(outDir, `agent-${model.id}-${stamp}.json`);
  const full = { at: new Date().toISOString(), model: model.modelId, runtime: model.runtime, adapter: process.env.AGENT_MLX_ADAPTER_PATH || null, loadSeconds, repeat: options.repeat, ...report };
  fs.writeFileSync(out, `${JSON.stringify(full, null, 2)}\n`);
  console.log(JSON.stringify({ model: model.modelId, ...report.summary }, null, 2));
  console.error(`Informe complet: ${path.relative(process.cwd(), out)}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
