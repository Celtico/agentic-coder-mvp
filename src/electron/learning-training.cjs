// Training a model of our own from the verified cases, locally, with MLX:
//
//   1. LoRA on the chosen base model with the train/valid split of a prepared dataset (mlx_lm lora).
//   2. Evaluation: loss on the test split with and without the adapter, and the agent benchmark with
//      and without it (scripts/evaluate-agent.cjs).
//   3. Only if the test loss improves and the benchmark does not get worse, the adapter is fused into a
//      new model folder, models/mlx/<name>-v<N>, with agentic-model.json (base, data and its hash, date,
//      metrics). The app lists it in the model selector. Otherwise nothing is published and the report
//      says why.
//
// Base weights are never written: the adapter goes to models/adapters/<base>/<date>/ and a fused model
// always goes to a new folder. Every version stays, so going back is choosing an older one.
// The commands are run by an injected `run(command, args, { onLine, signal })`, so the logic can be
// tested without a model.
const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULTS = { iters: 300, numLayers: 8, maxSeqLength: 2048, learningRate: 1e-5, batchSize: 1 };

function slugify(name) {
  const slug = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (!slug) throw new Error('Cal un nom per al model.');
  return slug;
}

/** The next free version number for a name: v1, v2… (folders already there are never reused). */
async function nextVersion(modelsRoot, slug) {
  let highest = 0;
  for (const entry of await fs.readdir(path.join(modelsRoot, 'mlx')).catch(() => [])) {
    const match = new RegExp(`^${slug}-v(\\d+)$`).exec(entry);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

const parseTestLoss = (output) => { const match = /Test loss ([0-9.]+)/.exec(output); return match ? Number(match[1]) : null; };

function decide({ baseLoss, adapterLoss, baseBenchmark, adapterBenchmark }) {
  if (baseLoss === null || adapterLoss === null) return { improved: false, reason: 'No s’ha pogut mesurar la pèrdua del conjunt de prova.' };
  if (!(adapterLoss < baseLoss)) return { improved: false, reason: `Amb l’adaptador la pèrdua de prova no millora (${adapterLoss} davant ${baseLoss}).` };
  if (!baseBenchmark || !adapterBenchmark) return { improved: false, reason: 'No s’ha pogut passar el benchmark amb i sense l’adaptador.' };
  if (adapterBenchmark.passed < baseBenchmark.passed) return { improved: false, reason: `El benchmark empitjora amb l’adaptador (${adapterBenchmark.passed}/${adapterBenchmark.runs} davant ${baseBenchmark.passed}/${baseBenchmark.runs}).` };
  return { improved: true, reason: `Pèrdua de prova ${baseLoss} → ${adapterLoss}; benchmark ${baseBenchmark.passed}/${baseBenchmark.runs} → ${adapterBenchmark.passed}/${adapterBenchmark.runs}.` };
}

/**
 * @param {object} options
 * @param {string} options.datasetDirectory  a prepared candidate (learning-dataset.cjs) with mlx/ and manifest.json
 * @param {{id: string, label: string, modelId: string, directory: string}} options.base
 * @param {string} options.name              the name the user chose ("El nostre model")
 * @param {string} options.modelsRoot
 * @param {string} options.python            the MLX runtime's python
 * @param {(command: string, args: string[], opts: {onLine?: (line: string) => void, signal?: AbortSignal, env?: object}) => Promise<{code: number, output: string}>} options.run
 * @param {(adapterPath: string | null) => Promise<{passed: number, runs: number} | null>} options.benchmark
 * @param {(event: {step: string, message: string, progress?: number}) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @param {object} [options.settings]        iters, numLayers, maxSeqLength, learningRate; requireReady=false only for a plumbing test
 * @param {() => Date} [options.now]
 */
async function runTrainingPipeline({ datasetDirectory, base, name, modelsRoot, python, mlxLauncher = null, run, benchmark, onProgress = () => {}, signal, settings = {}, now = () => new Date() }) {
  // `python <mlxLauncher> lora …` takes the one-model-on-the-GPU lock first (mlx-locked.py); without it, `python -m mlx_lm lora …`.
  const mlx = (...args) => [...(mlxLauncher ? [mlxLauncher] : ['-m', 'mlx_lm']), ...args];
  const config = { ...DEFAULTS, requireReady: true, ...settings };
  const slug = slugify(name);
  const manifest = JSON.parse(await fs.readFile(path.join(datasetDirectory, 'manifest.json'), 'utf8'));
  if (config.requireReady && !manifest.trainingReady) throw new Error('Encara no hi ha prou casos verificats per entrenar (calen 30).');
  const data = path.join(datasetDirectory, 'mlx');
  await fs.access(path.join(data, 'train.jsonl'));
  const checkCancel = () => { if (signal?.aborted) throw new Error('Entrenament cancel·lat.'); };
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const adapterPath = path.join(modelsRoot, 'adapters', base.id, stamp);
  await fs.mkdir(adapterPath, { recursive: true });
  const report = { at: now().toISOString(), name, base: { id: base.id, modelId: base.modelId }, dataset: { version: manifest.datasetVersion, hash: manifest.datasetHash, splits: manifest.splits }, adapterPath, settings: config, steps: [] };
  const saveReport = () => fs.writeFile(path.join(adapterPath, 'report.json'), JSON.stringify(report, null, 2));
  const step = async (id, message, command, args) => {
    checkCancel();
    onProgress({ step: id, message });
    const result = await run(command, args, {
      signal,
      onLine: (line) => {
        const iteration = /Iter (\d+):/.exec(line);
        onProgress({ step: id, message: line.slice(0, 300), ...(iteration && id === 'train' ? { progress: Math.min(1, Number(iteration[1]) / config.iters) } : {}) });
      },
    });
    report.steps.push({ id, code: result.code });
    checkCancel();
    if (result.code !== 0) throw new Error(`El pas «${message}» ha fallat (codi ${result.code}): ${result.output.slice(-800)}`);
    return result;
  };

  try {
    await step('train', `Entrenant l’adaptador LoRA sobre ${base.label}…`, python, mlx('lora', '--model', base.directory, '--train', '--data', data,
      '--adapter-path', adapterPath, '--iters', String(config.iters), '--batch-size', String(config.batchSize), '--num-layers', String(config.numLayers),
      '--max-seq-length', String(config.maxSeqLength), '--learning-rate', String(config.learningRate), '--grad-checkpoint', '--steps-per-eval', String(Math.max(10, Math.floor(config.iters / 4)))));

    const baseTest = await step('test-base', 'Mesurant el model base amb el conjunt de prova…', python, mlx('lora', '--model', base.directory, '--data', data, '--test', '--adapter-path', ''));
    const adapterTest = await step('test-adapter', 'Mesurant el model amb l’adaptador amb el conjunt de prova…', python, mlx('lora', '--model', base.directory, '--data', data, '--test', '--adapter-path', adapterPath));
    report.testLoss = { base: parseTestLoss(baseTest.output), adapter: parseTestLoss(adapterTest.output) };

    checkCancel();
    onProgress({ step: 'benchmark-base', message: 'Benchmark del model base…' });
    report.benchmark = { base: await benchmark(null) };
    checkCancel();
    onProgress({ step: 'benchmark-adapter', message: 'Benchmark amb l’adaptador…' });
    report.benchmark.adapter = await benchmark(adapterPath);
    checkCancel();

    const verdict = decide({ baseLoss: report.testLoss.base, adapterLoss: report.testLoss.adapter, baseBenchmark: report.benchmark.base, adapterBenchmark: report.benchmark.adapter });
    report.verdict = verdict;
    if (!verdict.improved) {
      await saveReport();
      onProgress({ step: 'done', message: `No es publica cap versió nova: ${verdict.reason}` });
      return { published: false, reason: verdict.reason, report };
    }

    const version = await nextVersion(modelsRoot, slug);
    const folder = `${slug}-v${version}`;
    const savePath = path.join(modelsRoot, 'mlx', folder);
    await fs.mkdir(path.dirname(savePath), { recursive: true });
    try { await fs.access(savePath); throw new Error(`La carpeta ${folder} ja existeix; no es sobreescriu.`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try {
      await step('fuse', `Fusionant l’adaptador en un model nou: ${folder}…`, python, mlx('fuse', '--model', base.directory, '--adapter-path', adapterPath, '--save-path', savePath));
      const meta = {
        id: folder, label: `${String(name).trim().slice(0, 60)} v${version}`, modelId: `local/${folder}`, version, name: String(name).trim(),
        base: { id: base.id, modelId: base.modelId }, adapterPath, dataset: report.dataset, createdAt: now().toISOString(),
        metrics: { testLoss: report.testLoss, benchmark: report.benchmark }, settings: config,
      };
      await fs.writeFile(path.join(savePath, 'agentic-model.json'), JSON.stringify(meta, null, 2));
      report.published = { folder, label: meta.label };
      await saveReport();
      onProgress({ step: 'done', message: `Nova versió publicada: ${meta.label}. ${verdict.reason}` });
      return { published: true, model: meta, report };
    } catch (error) {
      await fs.rm(savePath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    await saveReport().catch(() => {});
    throw error;
  }
}

module.exports = { runTrainingPipeline, slugify, nextVersion, decide, parseTestLoss, DEFAULTS };
