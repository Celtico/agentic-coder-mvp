#!/usr/bin/env node
// Benchmark de motors: the engines that can run a model on this machine (the native one, when it supports the
// model, and Python's mlx-lm), compared with the same fixed requests, one engine after the other: a model is
// loaded, measured and unloaded, and its process has ended before the next engine starts (and the GPU lock
// would make it wait anyway). Measured as the Model log measures a call.
//
//   node scripts/evaluate-engines.cjs --model mimo-9b-mlx --out <report.json>
//
// For each engine: the load time, a warm-up request, then 3 rounds of a short prompt, a long one (about 4.000
// tokens of this repository's source) and a second message after the long one (the prompt cache). Each round
// starts with its own number, so the prompt cache cannot answer the first two; the report keeps the medians.
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const ROUNDS = 3;
const MAX_TOKENS = 128;
const ENGINE_NAMES = { native: 'natiu', mlx: 'Python', cuda: 'CUDA' };

const median = (values) => {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
};

/** The fixed long text: this repository's own worker code, about 4.000 tokens (no instructions in it). */
function longText() {
  const dir = path.join(repoRoot, 'src', 'core', 'assistant');
  return fs.readFileSync(path.join(dir, 'mlx-worker.py'), 'utf8') + fs.readFileSync(path.join(dir, 'mlx_text.py'), 'utf8').slice(0, 2500);
}

/** One engine's medians from its measured calls ({ kind, round, metrics, text }). */
function summarizeEngine(runtime, loadSeconds, calls) {
  const of = (kind, key) => median(calls.filter((call) => call.kind === kind).map((call) => call.metrics[key]));
  return {
    runtime, name: ENGINE_NAMES[runtime] || runtime, loadSeconds,
    short: { firstTokenSeconds: of('short', 'firstTokenSeconds'), promptTps: of('short', 'promptTps'), generationTps: of('short', 'generationTps'), promptTokens: of('short', 'promptTokens') },
    long: { firstTokenSeconds: of('long', 'firstTokenSeconds'), promptTps: of('long', 'promptTps'), generationTps: of('long', 'generationTps'), promptTokens: of('long', 'promptTokens') },
    second: { firstTokenSeconds: of('second', 'firstTokenSeconds'), cachedTokens: of('second', 'cachedTokens'), promptTokens: of('second', 'promptTokens') },
    generationTps: median(calls.map((call) => call.metrics.generationTps)),
    peakMemoryGb: Math.max(0, ...calls.map((call) => call.metrics.peakMemoryGb || 0)) || null,
    shortText: calls.find((call) => call.kind === 'short')?.text ?? null,
  };
}

/** Whether every engine gave the same greedy answer to the short prompt (null with only one engine). */
const sameAnswers = (engines) => (engines.length < 2 ? null : engines.every((engine) => engine.shortText !== null && engine.shortText === engines[0].shortText));

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const mlxModels = require(path.join(repoRoot, 'src', 'electron', 'mlx-models.cjs'));
  const modelsRoot = process.env.AGENT_MODELS_DIR || path.join(repoRoot, 'models');
  const model = await mlxModels.findModel(modelsRoot, option('--model') || mlxModels.DEFAULT_MODEL_ID);
  if (!model) throw new Error(`Model desconegut: ${option('--model')}`);
  const directory = await mlxModels.modelDirectory(model, modelsRoot);
  if (!directory) throw new Error(`No s’han trobat els pesos de ${model.label} a models/.`);
  const runtimes = [...(await mlxModels.nativeSupported(directory) ? ['native'] : []), model.runtime];
  Object.assign(process.env, {
    AGENT_MODEL_CACHE: modelsRoot, AGENT_MODEL: model.modelId, AGENT_MLX_MODEL_PATH: directory, AGENT_LLM_TRACE: '1',
    AGENT_MLX_PYTHON: process.env.AGENT_MLX_PYTHON || mlxModels.enginePython(modelsRoot),
  });
  const { createEngine } = require(path.join(repoRoot, 'src', 'core', 'assistant', 'agent-runtime.cjs'));
  const long = longText();
  const options = { max_new_tokens: MAX_TOKENS, temperature: 0, do_sample: false };
  const engines = [];
  for (const runtime of runtimes) {
    console.log(`MOTOR ${ENGINE_NAMES[runtime] || runtime}: carregant ${model.label}…`);
    process.env.AGENT_MODEL_RUNTIME = runtime;
    const engine = createEngine(runtime);
    let last = null;
    // Each measured call also goes to the Model log (AGENT_LLM_CALLS_LOG, set by the app), as «benchmark de motors».
    engine.traceContext = { source: 'benchmark de motors' };
    const write = engine.tracer.record.bind(engine.tracer);
    engine.tracer.record = (record) => { if (record.type === 'call') last = record; write(record); };
    const started = Date.now();
    await engine.loadModel(() => {});
    const loadSeconds = Math.round((Date.now() - started) / 100) / 10;
    const ask = async (messages) => {
      last = null;
      const text = await engine.generateResponse(messages, options);
      return { text, metrics: last?.metrics || {} };
    };
    const calls = [];
    try {
      await ask([{ role: 'user', content: 'Hola. Respon només «hola».' }]);
      for (let round = 1; round <= ROUNDS; round++) {
        console.log(`MOTOR ${ENGINE_NAMES[runtime] || runtime}: ronda ${round} de ${ROUNDS}`);
        const short = await ask([{ role: 'user', content: `Prova ${round}. Escriu una funció JavaScript que sumi dos números.` }]);
        calls.push({ kind: 'short', round, ...short });
        const first = [{ role: 'user', content: `Prova ${round}. Explica breument què fa aquest codi:\n\n${long}` }];
        const answer = await ask(first);
        calls.push({ kind: 'long', round, ...answer });
        const second = await ask([...first, { role: 'assistant', content: answer.text }, { role: 'user', content: 'Ara resumeix-ho en una sola frase.' }]);
        calls.push({ kind: 'second', round, ...second });
      }
    } finally {
      // The next engine starts only once this process has ended (never two models at once).
      const child = engine.child;
      const exited = child && child.exitCode === null ? new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 20000); }) : Promise.resolve();
      await engine.unloadModel();
      await exited;
    }
    // Only the short prompt's text is compared between engines (and kept, for that).
    engines.push(summarizeEngine(runtime, loadSeconds, calls.map((call) => ({ ...call, text: call.kind === 'short' && call.round === 1 ? call.text : null }))));
  }
  const report = { kind: 'engines', at: new Date().toISOString(), model: model.modelId, label: model.label, rounds: ROUNDS, maxTokens: MAX_TOKENS, sameAnswer: sameAnswers(engines), engines };
  const out = option('--out') || path.join(repoRoot, 'logs', 'benchmarks', `engines-${model.id}-${report.at.replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`FET ${out}`);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });

module.exports = { median, summarizeEngine, sameAnswers, longText, ENGINE_NAMES };
