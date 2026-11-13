const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runTrainingPipeline, slugify, nextVersion, decide } = require('./learning-training.cjs');
const mlxModels = require('./mlx-models.cjs');

async function setup(t, { trainingReady = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-training-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataset = path.join(root, 'dataset');
  await fs.mkdir(path.join(dataset, 'mlx'), { recursive: true });
  for (const name of ['train', 'valid', 'test']) await fs.writeFile(path.join(dataset, 'mlx', `${name}.jsonl`), '{"messages":[]}\n');
  await fs.writeFile(path.join(dataset, 'manifest.json'), JSON.stringify({ datasetVersion: 'dataset-x', datasetHash: 'a'.repeat(64), splits: { train: 24, validation: 3, test: 3 }, trainingReady }));
  const modelsRoot = path.join(root, 'models');
  const baseDir = path.join(modelsRoot, 'mlx', 'base');
  await fs.mkdir(baseDir, { recursive: true });
  await fs.writeFile(path.join(baseDir, 'weights.safetensors'), 'BASE');
  return { root, dataset, modelsRoot, base: { id: 'base-mlx', label: 'Base', modelId: 'org/base', directory: baseDir } };
}

/** Stands in for python/mlx_lm: records each call and answers like the real commands. */
function fakeRunner({ baseLoss = 2.0, adapterLoss = 1.5, failStep } = {}) {
  const calls = [];
  const run = async (command, args, { onLine } = {}) => {
    const sub = args.find((arg) => arg === 'lora' || arg === 'fuse');
    const isTest = args.includes('--test');
    const adapter = args[args.indexOf('--adapter-path') + 1];
    calls.push({ command, sub, isTest, adapter, args });
    if (failStep && failStep === (sub === 'fuse' ? 'fuse' : isTest ? 'test' : 'train')) return { code: 1, output: 'boom' };
    if (sub === 'lora' && !isTest) { onLine?.('Iter 150: Train loss 1.2'); await fs.writeFile(path.join(adapter, 'adapters.safetensors'), 'A'); return { code: 0, output: 'ok' }; }
    if (isTest) return { code: 0, output: `Test loss ${adapter ? adapterLoss : baseLoss}, Test ppl 3.0.` };
    if (sub === 'fuse') {
      const save = args[args.indexOf('--save-path') + 1];
      await fs.mkdir(save, { recursive: true });
      await fs.writeFile(path.join(save, 'config.json'), '{}');
      await fs.writeFile(path.join(save, 'model.safetensors'), 'FUSED');
      return { code: 0, output: 'fused' };
    }
    return { code: 1, output: 'unknown' };
  };
  return { run, calls };
}

const benchmarkOf = (base, adapter) => async (adapterPath) => (adapterPath ? adapter : base);

test('an adapter that improves is fused into a new version listed with its metadata, base weights untouched', async (t) => {
  const env = await setup(t);
  const runner = fakeRunner();
  const progress = [];
  const result = await runTrainingPipeline({ datasetDirectory: env.dataset, base: env.base, name: 'El nostre model', modelsRoot: env.modelsRoot, python: 'py', run: runner.run, benchmark: benchmarkOf({ passed: 3, runs: 6 }, { passed: 4, runs: 6 }), onProgress: (event) => progress.push(event), now: () => new Date('2026-11-13T10:00:00Z') });
  assert.equal(result.published, true);
  assert.equal(result.model.id, 'el-nostre-model-v1');
  assert.equal(result.model.label, 'El nostre model v1');
  assert.deepEqual(runner.calls.map((call) => [call.sub, call.isTest]), [['lora', false], ['lora', true], ['lora', true], ['fuse', false]]);
  assert.equal(runner.calls[1].adapter, '', 'the base is measured without any adapter');
  assert.ok(runner.calls[0].adapter.startsWith(path.join(env.modelsRoot, 'adapters', 'base-mlx')));
  assert.equal(await fs.readFile(path.join(env.base.directory, 'weights.safetensors'), 'utf8'), 'BASE');
  const meta = JSON.parse(await fs.readFile(path.join(env.modelsRoot, 'mlx', 'el-nostre-model-v1', 'agentic-model.json'), 'utf8'));
  assert.equal(meta.dataset.hash, 'a'.repeat(64));
  assert.deepEqual(meta.metrics.testLoss, { base: 2, adapter: 1.5 });
  assert.ok(progress.some((event) => event.progress === 0.5));
  // The app lists the new version next to the built-in models.
  const listed = await mlxModels.listModels(env.modelsRoot);
  const own = listed.find((model) => model.id === 'el-nostre-model-v1');
  assert.equal(own.label, 'El nostre model v1');
  assert.ok(await mlxModels.modelDirectory(own, env.modelsRoot));
});

test('a second training gets the next version and keeps the previous one', async (t) => {
  const env = await setup(t);
  const options = { datasetDirectory: env.dataset, base: env.base, name: 'El nostre model', modelsRoot: env.modelsRoot, python: 'py', benchmark: benchmarkOf({ passed: 3, runs: 6 }, { passed: 3, runs: 6 }) };
  await runTrainingPipeline({ ...options, run: fakeRunner().run, now: () => new Date('2026-11-13T10:00:00Z') });
  const second = await runTrainingPipeline({ ...options, run: fakeRunner().run, now: () => new Date('2026-11-13T11:00:00Z') });
  assert.equal(second.model.id, 'el-nostre-model-v2');
  const ids = (await mlxModels.listModels(env.modelsRoot)).filter((model) => model.own).map((model) => model.id);
  assert.deepEqual(ids, ['el-nostre-model-v1', 'el-nostre-model-v2']);
});

test('nothing is published when the test loss does not improve or the benchmark gets worse', async (t) => {
  const env = await setup(t);
  const base = { datasetDirectory: env.dataset, base: env.base, name: 'M', modelsRoot: env.modelsRoot, python: 'py' };
  const worseLoss = await runTrainingPipeline({ ...base, run: fakeRunner({ adapterLoss: 2.5 }).run, benchmark: benchmarkOf({ passed: 3, runs: 6 }, { passed: 5, runs: 6 }) });
  assert.equal(worseLoss.published, false);
  assert.match(worseLoss.reason, /no millora/);
  const runner = fakeRunner();
  const worseBench = await runTrainingPipeline({ ...base, run: runner.run, benchmark: benchmarkOf({ passed: 4, runs: 6 }, { passed: 3, runs: 6 }), now: () => new Date('2026-11-13T12:00:00Z') });
  assert.equal(worseBench.published, false);
  assert.match(worseBench.reason, /empitjora/);
  assert.ok(!runner.calls.some((call) => call.sub === 'fuse'));
  assert.deepEqual((await mlxModels.listModels(env.modelsRoot)).filter((model) => model.own), []);
  // The report stays next to the adapter to see why.
  const report = JSON.parse(await fs.readFile(path.join(worseBench.report.adapterPath, 'report.json'), 'utf8'));
  assert.equal(report.verdict.improved, false);
});

test('it refuses to train without enough verified cases, unless asked for a plumbing test', async (t) => {
  const env = await setup(t, { trainingReady: false });
  const options = { datasetDirectory: env.dataset, base: env.base, name: 'M', modelsRoot: env.modelsRoot, python: 'py', benchmark: benchmarkOf({ passed: 1, runs: 1 }, { passed: 1, runs: 1 }) };
  await assert.rejects(runTrainingPipeline({ ...options, run: fakeRunner().run }), /prou casos/);
  const plumbing = await runTrainingPipeline({ ...options, run: fakeRunner().run, settings: { requireReady: false, iters: 2 } });
  assert.equal(plumbing.published, true);
});

test('cancelling stops before the next step and publishes nothing', async (t) => {
  const env = await setup(t);
  const controller = new AbortController();
  const runner = fakeRunner();
  const run = async (...args) => { const result = await runner.run(...args); controller.abort(); return result; };
  await assert.rejects(runTrainingPipeline({ datasetDirectory: env.dataset, base: env.base, name: 'M', modelsRoot: env.modelsRoot, python: 'py', run, benchmark: benchmarkOf({ passed: 1, runs: 1 }, { passed: 1, runs: 1 }), signal: controller.signal }), /cancel·lat/);
  assert.equal(runner.calls.length, 1);
  assert.deepEqual((await mlxModels.listModels(env.modelsRoot)).filter((model) => model.own), []);
});

test('a failed fuse leaves no half-written model', async (t) => {
  const env = await setup(t);
  await assert.rejects(runTrainingPipeline({ datasetDirectory: env.dataset, base: env.base, name: 'M', modelsRoot: env.modelsRoot, python: 'py', run: fakeRunner({ failStep: 'fuse' }).run, benchmark: benchmarkOf({ passed: 1, runs: 1 }, { passed: 1, runs: 1 }) }), /ha fallat/);
  assert.deepEqual((await fs.readdir(path.join(env.modelsRoot, 'mlx'))).sort(), ['base']);
});

test('names and versions', async (t) => {
  assert.equal(slugify('  El Nostre Model!  '), 'el-nostre-model');
  assert.equal(slugify('Àlex · v1'), 'alex-v1');
  assert.throws(() => slugify('  !! '), /Cal un nom/);
  const env = await setup(t);
  await fs.mkdir(path.join(env.modelsRoot, 'mlx', 'm-v3'));
  assert.equal(await nextVersion(env.modelsRoot, 'm'), 4);
  assert.equal(decide({ baseLoss: 1, adapterLoss: 0.9, baseBenchmark: { passed: 2, runs: 6 }, adapterBenchmark: { passed: 2, runs: 6 } }).improved, true);
});
