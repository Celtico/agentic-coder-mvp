const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseVerifiedExperiences, prepareTrainingDataset, writeTrainingCandidate } = require('./learning-dataset.cjs');

function record(id, overrides = {}) {
  return {
    id,
    at: '2026-10-18T12:00:00.000Z',
    model: 'local-test-model',
    projectPath: '/tmp/private-project',
    prompt: `Implementa una funció de validació ${id}`,
    answer: `La funció ${id} comprova els valors i retorna un resultat validat.`,
    evidence: 'La prova automatitzada corresponent ha passat.',
    verification: 'user-confirmed',
    ...overrides,
  };
}

test('preparation keeps only verified, valid, secret-free and deduplicated examples', () => {
  const rows = [
    record('one'),
    record('two'),
    record('duplicate', { prompt: ' IMPLEMENTA UNA FUNCIÓ DE VALIDACIÓ one ', answer: 'La funció one comprova els valors i retorna un resultat validat.' }),
    record('unverified', { verification: 'unconfirmed' }),
    record('secret', { answer: 'El valor és api_key=abcDEF0123456789-secret' }),
    record('invalid', { prompt: ' ' }),
  ];

  const prepared = prepareTrainingDataset(rows);

  assert.deepEqual(prepared.counts, { input: 6, unverified: 1, invalid: 1, secrets: 1, duplicates: 1, included: 2 });
  assert.equal(prepared.splitCounts.train, 2);
  assert.equal(prepared.splitCounts.validation, 0);
  assert.equal(prepared.splitCounts.test, 0);
  assert.equal(prepared.trainingReady, false);
});

test('JSONL parsing ignores malformed lines and enforces its size limit', () => {
  assert.deepEqual(parseVerifiedExperiences('{bad json\n{"id":"valid"}\n'), [{ __invalidJSON: true }, { id: 'valid' }]);
  assert.throws(() => parseVerifiedExperiences('x'.repeat(20_000_001)), /20 MB/);
});

test('candidate partitions are deterministic, provenance-preserving and immutable on disk', async (t) => {
  const rows = Array.from({ length: 40 }, (_, index) => record(`case-${index}`));
  const first = prepareTrainingDataset(rows);
  const second = prepareTrainingDataset(rows);
  assert.deepEqual(first.splitCounts, { train: 32, validation: 4, test: 4 });
  assert.deepEqual(first.partitions, second.partitions);
  assert.equal(first.trainingReady, true);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-learning-dataset-test-'));
  const candidatesRoot = path.join(tempRoot, 'candidates');
  const candidate = await writeTrainingCandidate(first, candidatesRoot);
  t.after(async () => {
    await fs.chmod(candidate.directory, 0o700).catch(() => {});
    await fs.chmod(path.join(candidate.directory, 'mlx'), 0o700).catch(() => {});
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const manifest = JSON.parse(await fs.readFile(path.join(candidate.directory, 'manifest.json'), 'utf8'));
  const train = await fs.readFile(path.join(candidate.directory, 'train.jsonl'), 'utf8');
  assert.equal(manifest.trainingReady, true);
  assert.equal(manifest.splits.train, 32);
  assert.equal((await fs.stat(path.join(candidate.directory, 'train.jsonl'))).mode & 0o777, 0o400);
  assert.equal((await fs.stat(candidate.directory)).mode & 0o777, 0o500);
  assert.doesNotMatch(train, /private-project/);
  assert.match(train, /sourceProjectHash/);
  assert.match(candidate.manifest.note, /No model was trained or changed/);
  // The chat-format copy for mlx_lm.lora: train/valid/test with the same records.
  const mlxTrain = (await fs.readFile(path.join(candidate.directory, 'mlx', 'train.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(mlxTrain.length, 32);
  assert.deepEqual(mlxTrain[0].messages.map((message) => message.role), ['user', 'assistant']);
  assert.equal(manifest.files['mlx/valid.jsonl'].records, 4);
  assert.match(manifest.datasetHash, /^[0-9a-f]{64}$/);
});

test('the prepared data as the window shows it, and as one .jsonl: every case with its examples, and what is left out with why', () => {
  const { prepareTrainingDataset, datasetView, datasetJsonl } = require('./learning-dataset.cjs');
  const versions = require('./learning-versions.cjs');
  const examplesFor = (item) => versions.toTrainingExamples(item, 4096);
  const base = { projectPath: '/tmp/p', verification: 'user-confirmed', evidence: 'build ok' };
  const records = [
    { ...base, id: 'a', prompt: 'posa un botó', answer: 'fet', task: 'Botó' },
    { ...base, id: 'b', prompt: 'posa un botó', answer: 'fet' },
    { ...base, id: 'c', prompt: 'clau', answer: 'ghp_abcdefghijklmnopqrstuvwxyz0123' },
    { id: 'd', prompt: 'x', answer: 'y', evidence: 'z', projectPath: '/tmp/p' },
  ];
  const prepared = prepareTrainingDataset(records);
  const view = datasetView(prepared, examplesFor);
  assert.equal(view.counts.included, 1);
  assert.equal(view.counts.examples, 1);
  assert.deepEqual(view.splits.train.map((item) => [item.id, item.task, item.examples.length, item.examples[0].fits]), [['a', 'Botó', 1, true]]);
  assert.deepEqual(view.discarded.map((item) => [item.id, item.reason]).sort(), [['b', 'duplicate'], ['c', 'secret'], ['d', 'unverified']]);
  const lines = datasetJsonl(prepared, examplesFor).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => [line.split, line.caseId, line.turn]), [['train', 'a', 0]]);
  assert.deepEqual(lines[0].messages.map((message) => message.role), ['user', 'assistant']);
});
