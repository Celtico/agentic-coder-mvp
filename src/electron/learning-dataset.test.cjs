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
});
