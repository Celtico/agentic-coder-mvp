// Learning in versions, beta → stable (src/electron/learning-versions.cjs), without any model: the
// training command is a stand-in that writes what mlx_lm would.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const versions = require('./learning-versions.cjs');
const { prepareTrainingDataset } = require('./learning-dataset.cjs');

const hex = (n) => String(n).padStart(64, '0');
function caseRecord(n, { system = 'Ets Agentic Coder.\nFitxers:\n' + 'x'.repeat(200), result = 'resultat', answer = `Fet ${n}.` } = {}) {
  return {
    id: hex(n), at: `2026-11-14T10:${String(n % 60).padStart(2, '0')}:00.000Z`, projectPath: '/tmp/p', model: 'm', verification: 'user-confirmed',
    prompt: `Petició ${n}`, answer, evidence: 'build superat', task: `Tasca general ${n}`,
    trajectory: { turns: [{ request: `Petició ${n}`, system, steps: [{ name: 'read_file', arguments: { path: 'a' }, result, ok: true }], answer }] },
  };
}
const prepare = (count, options) => prepareTrainingDataset(Array.from({ length: count }, (_, index) => caseRecord(index + 1, options)));

test('the training preferences: prudent defaults for 16 GB, kept in range', () => {
  assert.deepEqual(versions.defaultTrainingPreferences(32 * 2 ** 30), { maxTokens: 4096, numLayers: 8, learningRate: 0.00001, itersPerCase: 20, minIters: 60, maxIters: 600, seed: 7 });
  // The example length follows the Mac's memory: what fits a 9B model's training.
  assert.equal(versions.defaultMaxTokens(16 * 2 ** 30), 1536);
  assert.equal(versions.defaultMaxTokens(24 * 2 ** 30), 3072);
  assert.equal(versions.defaultMaxTokens(64 * 2 ** 30), 4096);
  const prefs = versions.normalizeTrainingPreferences({ maxTokens: 99999, numLayers: 2, learningRate: 1, itersPerCase: '30', seed: -4, minIters: 900, maxIters: 100 });
  assert.deepEqual(prefs, { maxTokens: 8192, numLayers: 4, learningRate: 0.00005, itersPerCase: 30, minIters: 100, maxIters: 100, seed: 0 });
  assert.deepEqual(versions.normalizeTrainingPreferences('x'), versions.defaultTrainingPreferences());
});

test('iterations grow with the cases: max(60, 20 × N), at most 600', () => {
  const prefs = versions.defaultTrainingPreferences();
  assert.equal(versions.itersFor(1, prefs), 60);
  assert.equal(versions.itersFor(3, prefs), 60);
  assert.equal(versions.itersFor(10, prefs), 200);
  assert.equal(versions.itersFor(30, prefs), 600);
  assert.equal(versions.itersFor(100, prefs), 600);
});

test('the buttons: a beta from one case (few cases only check the circuit), the stable from 30, promotion after the comparison', () => {
  assert.deepEqual(versions.learningButtons({ cases: 0 }).beta, { enabled: false, reason: 'Cal almenys un cas verificat vàlid.', fewCases: false });
  assert.deepEqual(versions.learningButtons({ cases: 1 }).beta, { enabled: true, reason: null, fewCases: true });
  assert.equal(versions.learningButtons({ cases: 12 }).beta.fewCases, false);
  assert.equal(versions.learningButtons({ cases: 29 }).stable.enabled, false);
  assert.match(versions.learningButtons({ cases: 29 }).stable.reason, /Calen 30/);
  assert.equal(versions.learningButtons({ cases: 30 }).stable.enabled, true);
  assert.equal(versions.learningButtons({ cases: 30, running: true }).stable.enabled, false);
  assert.equal(versions.learningButtons({ cases: 5, otherWork: true }).beta.enabled, false);
  assert.equal(versions.learningButtons({ cases: 30, candidate: { cases: 30 } }).promote.enabled, false);
  assert.equal(versions.learningButtons({ cases: 30, candidate: { comparison: { base: {}, candidate: {} } } }).promote.enabled, true);
  assert.equal(versions.learningButtons({ cases: 30, candidate: { comparison: {}, promoted: { folder: 'x' } } }).promote.enabled, false);
});

test('an example is the chat the agent had: its system text, the request, the tool calls and the answer', () => {
  const built = versions.buildTrainingExamples(prepare(2), 4096);
  assert.equal(built.examples.length, 2);
  assert.deepEqual(built.examples[0].messages.map((message) => message.role), ['system', 'user', 'assistant', 'user', 'assistant']);
  assert.match(built.examples[0].messages[0].content, /^Ets Agentic Coder/);
  // One example per turn: its own request (not the case's general task).
  assert.match(built.examples[0].messages[1].content, /^Petició/);
  assert.equal(JSON.parse(built.examples[0].messages[2].content).name, 'read_file');
  assert.match(JSON.parse(built.examples[0].messages[4].content).content, /^Fet/);
  assert.equal(built.truncated, 0);
  assert.equal(built.dropped, 0);
  assert.deepEqual(built.caseIds.sort(), [hex(1), hex(2)]);
});

test('a long example is cut: the system text first, then tool results; never the request or the answer', () => {
  const long = versions.buildTrainingExamples(prepare(1, { system: 'INSTRUCCIONS\n' + 'f'.repeat(40000) }), 1024).examples[0];
  assert.ok(versions.estimateTokens(long.messages.map((m) => m.content).join('')) <= 1024);
  assert.match(long.messages[0].content, /^INSTRUCCIONS/);
  assert.match(long.messages[0].content, /\[retallat\]$/);
  const results = versions.buildTrainingExamples(prepare(1, { system: '', result: 'r'.repeat(20000) }), 1024);
  assert.equal(results.truncated, 1);
  const example = results.examples[0].messages;
  assert.equal(example[0].content, 'Petició 1');
  assert.match(example[2].content, /\[retallat\]$/);
  assert.match(JSON.parse(example.at(-1).content).content, /^Fet 1\.$/);
  // An answer that alone does not fit: the turn goes step by step, and the answer's step is left out and counted.
  const dropped = versions.buildTrainingExamples(prepare(1, { answer: 'a'.repeat(20000) }), 1024);
  assert.equal(dropped.stepsDropped, 1);
  assert.ok(dropped.examples.every((example) => !/a{1000}/.test(example.messages.at(-1).content)));
});

test('a turn too long whole goes as one example per step of the agent, each with the request and the steps before it that fit', () => {
  const built = versions.buildTrainingExamples(prepare(1, { system: '', result: 'r'.repeat(6000) }), 1024);
  // With the result cut to its share it still fits whole: one example.
  assert.equal(built.split, 0);
  const steps = versions.buildTrainingExamples(prepare(1, { system: '', answer: 'a'.repeat(3460) }), 1024);
  assert.equal(steps.split, 1);
  assert.ok(steps.examples.length >= 2, 'the tool call and the answer');
  for (const example of steps.examples) {
    assert.equal(example.messages[0].content, 'Petició 1', 'always the request first');
    assert.equal(example.messages.at(-1).role, 'assistant', 'and one of the agent\'s messages last');
    assert.ok(versions.estimateTokens(example.messages.map((m) => m.content).join('')) <= 1024);
  }
  assert.match(steps.examples.at(-1).messages.at(-1).content, /a{3000}/, 'the answer is the last step');
});

test('lines of mlx_lm lora give the iteration, the loss and the speed', () => {
  assert.deepEqual(versions.parseTrainingLine('Iter 20: Train loss 1.234, Learning Rate 1.000e-05, It/sec 0.123, Tokens/sec 380.500, Trained Tokens 9000, Peak mem 9.1 GB'), { iteration: 20, loss: 1.234, itPerSec: 0.123, tokensPerSec: 380.5 });
  assert.equal(versions.parseTrainingLine('Loading pretrained model'), null);
});

function fakeRun(calls, { code = 0, lines = ['Iter 5: Train loss 2.5, It/sec 0.1, Tokens/sec 300.0', 'Iter 60: Train loss 1.25, It/sec 0.1, Tokens/sec 310.0'] } = {}) {
  return async (command, args, { onLine } = {}) => {
    calls.push([command, ...args]);
    if (args.includes('lora') && code === 0) {
      const adapterPath = args[args.indexOf('--adapter-path') + 1];
      fs.writeFileSync(path.join(adapterPath, 'adapters.safetensors'), 'w');
      for (const line of lines) onLine?.(line);
    }
    if (args.includes('fuse') && code === 0) { const save = args[args.indexOf('--save-path') + 1]; fs.mkdirSync(save, { recursive: true }); fs.writeFileSync(path.join(save, 'model.safetensors'), 'w'); fs.writeFileSync(path.join(save, 'config.json'), '{}'); }
    return { code, output: code ? 'error de prova' : 'ok' };
  };
}
const base = (root) => ({ id: 'mimo-9b-mlx', label: 'MiMo V2.6 9B · MLX', modelId: 'mlx-community/MiMo', directory: path.join(root, 'mlx', 'mimo') });

test('a beta is trained from the base with every case, and its manifest says what went in', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-beta-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const progress = [];
  let clock = Date.parse('2026-11-14T22:00:00.000Z');
  const beta = await versions.trainAdapter({ kind: 'beta', base: base(root), prepared: prepare(3), preferences: versions.defaultTrainingPreferences(32 * 2 ** 30), modelsRoot: root, python: 'py', launcher: 'mlx-locked.py', run: fakeRun(calls), onProgress: (event) => progress.push(event), now: () => new Date((clock += 1000)) });
  const args = calls[0];
  assert.deepEqual(args.slice(0, 4), ['py', 'mlx-locked.py', 'lora', '--model']);
  assert.equal(args[args.indexOf('--model') + 1], base(root).directory, 'always the original base, never another adapter');
  assert.ok(!args.includes('--resume-adapter-file'));
  for (const flag of ['--grad-checkpoint', '--mask-prompt']) assert.ok(args.includes(flag), flag);
  assert.deepEqual(['--iters', '--batch-size', '--num-layers', '--learning-rate', '--max-seq-length', '--seed'].map((flag) => args[args.indexOf(flag) + 1]), ['60', '1', '8', '0.00001', '4096', '7']);
  assert.match(beta.folder, /^beta-1-2026-11-14T22-00-0/);
  const manifest = JSON.parse(fs.readFileSync(path.join(beta.adapterPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'beta');
  assert.equal(manifest.cases, 3);
  assert.deepEqual(manifest.caseIds.sort(), [hex(1), hex(2), hex(3)]);
  assert.deepEqual(manifest.base, { id: 'mimo-9b-mlx', modelId: 'mlx-community/MiMo', label: 'MiMo V2.6 9B · MLX' });
  assert.equal(manifest.finalLoss, 1.25);
  assert.ok(manifest.durationSeconds > 0);
  assert.equal(manifest.parameters.iters, 60);
  assert.ok(!fs.existsSync(path.join(beta.adapterPath, 'data')), 'the training data copy is removed afterwards');
  assert.ok(progress.some((event) => event.iteration === 60 && event.loss === 1.25 && event.progress === 1));
  // The next one is beta 2, again from the base.
  const second = await versions.trainAdapter({ kind: 'beta', base: base(root), prepared: prepare(4), preferences: versions.defaultTrainingPreferences(), modelsRoot: root, python: 'py', run: fakeRun(calls) });
  assert.match(second.folder, /^beta-2-/);
  assert.equal(calls[1][calls[1].indexOf('--model') + 1], base(root).directory);
});

test('the chat offers the newest beta as «<base> beta · N casos»; older ones can be deleted, not the newest', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-beta-list-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefs = versions.defaultTrainingPreferences();
  const first = await versions.trainAdapter({ kind: 'beta', base: base(root), prepared: prepare(1), preferences: prefs, modelsRoot: root, python: 'py', run: fakeRun([]) });
  const second = await versions.trainAdapter({ kind: 'beta', base: base(root), prepared: prepare(5), preferences: prefs, modelsRoot: root, python: 'py', run: fakeRun([]) });
  const models = await versions.betaModels([{ id: 'mimo-9b-mlx', label: 'MiMo V2.6 9B · MLX', modelId: 'x', runtime: 'mlx', folder: 'mimo', aliases: ['mimo'] }, { id: 'other', label: 'Other', modelId: 'y', runtime: 'mlx', folder: 'o', aliases: [] }], root);
  // Every beta, newest first; only the newest is `latest` (the one the selector offers by default).
  assert.equal(models.length, 2);
  assert.equal(models[0].label, 'MiMo V2.6 9B · MLX beta 2 · 5 casos');
  assert.equal(models[0].id, `mimo-9b-mlx@${second.folder}`);
  assert.deepEqual(models.map((model) => model.latest), [true, false]);
  assert.equal(models[1].label, 'MiMo V2.6 9B · MLX beta 1 · 1 cas');
  assert.equal(models[0].adapterPath, second.adapterPath);
  assert.equal(models[0].folder, 'mimo', 'the base’s weights');
  await assert.rejects(versions.deleteBeta(root, 'mimo-9b-mlx', second.folder), /només es poden esborrar les anteriors/);
  await assert.rejects(versions.deleteBeta(root, 'mimo-9b-mlx', '../../x'), /no és vàlida/);
  assert.deepEqual(await versions.deleteBeta(root, 'mimo-9b-mlx', first.folder), { deleted: first.folder });
  assert.deepEqual((await versions.listBetas(root, 'mimo-9b-mlx')).map((beta) => beta.folder), [second.folder]);
});

test('a failed or stopped training leaves nothing behind', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-beta-fail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(versions.trainAdapter({ kind: 'beta', base: base(root), prepared: prepare(1), preferences: versions.defaultTrainingPreferences(), modelsRoot: root, python: 'py', run: fakeRun([], { code: 1 }) }), /ha fallat/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'adapters', 'mimo-9b-mlx')), []);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(versions.trainAdapter({ kind: 'beta', base: base(root), prepared: prepare(1), preferences: versions.defaultTrainingPreferences(), modelsRoot: root, python: 'py', run: fakeRun([]), signal: controller.signal }), /aturat/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'adapters', 'mimo-9b-mlx')), []);
  await assert.rejects(versions.trainAdapter({ kind: 'beta', base: base(root), prepared: prepare(0), preferences: versions.defaultTrainingPreferences(), modelsRoot: root, python: 'py', run: fakeRun([]) }), /Calen 1 casos/);
});

test('the stable version: a candidate from 30 cases, compared, and promoted only when asked, with a name', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-stable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefs = versions.defaultTrainingPreferences();
  await assert.rejects(versions.trainAdapter({ kind: 'candidata', base: base(root), prepared: prepare(29), preferences: prefs, modelsRoot: root, python: 'py', run: fakeRun([]) }), /Calen 30/);
  const calls = [];
  await versions.trainAdapter({ kind: 'candidata', base: base(root), prepared: prepare(30), preferences: prefs, modelsRoot: root, python: 'py', run: fakeRun(calls) });
  assert.equal(calls[0][calls[0].indexOf('--iters') + 1], '600');
  let candidate = await versions.latestCandidate(root, 'mimo-9b-mlx');
  assert.equal(candidate.cases, 30);
  await assert.rejects(versions.promoteStable({ candidate, name: 'El nostre model', base: base(root), modelsRoot: root, python: 'py', run: fakeRun(calls) }), /Falta la comparativa/);
  await versions.recordComparison(candidate, { base: { passed: 8, runs: 10 }, candidate: { passed: 9, runs: 10 } });
  candidate = await versions.latestCandidate(root, 'mimo-9b-mlx');
  assert.equal(versions.learningButtons({ cases: 30, candidate }).promote.enabled, true);
  await assert.rejects(versions.promoteStable({ candidate, name: ' ', base: base(root), modelsRoot: root, python: 'py', run: fakeRun(calls) }), /Tria un nom/);
  const meta = await versions.promoteStable({ candidate, name: 'El nostre model', base: base(root), modelsRoot: root, python: 'py', run: fakeRun(calls) });
  assert.equal(meta.label, 'El nostre model · estable v1');
  assert.equal(meta.id, 'el-nostre-model-estable-v1');
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'mlx', meta.id, 'agentic-model.json'), 'utf8'));
  assert.deepEqual(saved.comparison.candidate, { passed: 9, runs: 10 });
  candidate = await versions.latestCandidate(root, 'mimo-9b-mlx');
  assert.equal(candidate.promoted.folder, meta.id);
  await assert.rejects(versions.promoteStable({ candidate, name: 'El nostre model', base: base(root), modelsRoot: root, python: 'py', run: fakeRun(calls) }), /ja s’ha promocionat/);
});

test('one example per turn, without the turns and steps the user excluded, and without the app’s framing of the results', () => {
  const { bareToolResult } = require('./learning-trajectory.cjs');
  const fsSync = require('node:fs');
  const read = (name) => fsSync.readFileSync(path.join(__dirname, '..', '..', 'prompts', `${name}.md`), 'utf8').trim();
  const framed = (tool, result) => read('tool-result').replace('{{tool}}', tool).replace('{{result}}', result).replace('{{page}}', '').replace('{{next}}', read('tool-result-continue'));
  assert.equal(bareToolResult(framed('read_file', '{"path":"a","content":"x"}'), 'read_file'), '{"path":"a","content":"x"}');
  assert.equal(bareToolResult('un resultat sense marc', 'read_file'), 'un resultat sense marc', 'nothing else is touched');
  const step = (name, ok = true) => ({ name, arguments: {}, result: framed(name, `ok ${name}`), ok });
  const record = { ...caseRecord(1), trajectory: { turns: [
    { request: 'crea el projecte', steps: [step('list_files'), step('write_file'), step('run_tests', false)], answer: 'Creat.' },
    { request: 'una pregunta', steps: [], answer: 'Resposta sense eines.' },
    { request: 'afegeix snippets', steps: [step('run_npx'), step('run_npx')], answer: 'Afegits.' },
    { request: 'compila', steps: [step('run_project_script')], answer: 'Compila.' },
  ] }, excludedTurns: [3], excludedSteps: ['2:1'] };
  const built = versions.buildTrainingExamples(prepareTrainingDataset([record]), 4096);
  assert.deepEqual(built.examples.map((example) => [example.turn, example.messages[0].content]), [[0, 'crea el projecte'], [2, 'afegeix snippets']]);
  assert.equal(built.skippedTurns, 2, 'the turn without steps and the excluded one');
  const first = built.examples[0].messages.filter((message) => message.role !== 'system');
  assert.deepEqual(first.filter((message) => message.role === 'assistant').slice(0, -1).map((message) => JSON.parse(message.content).name), ['list_files', 'write_file'], 'the failed step is left out');
  assert.equal(first[2].content, 'ok list_files', 'the bare result');
  assert.ok(!built.examples.some((example) => example.messages.some((message) => /continua amb una sola crida/.test(message.content))));
  const third = built.examples[1].messages.filter((message) => message.role === 'assistant');
  assert.equal(third.length, 2, 'one run_npx left (the other excluded) and the answer');
  assert.deepEqual(built.caseIds, [hex(1)]);
});
