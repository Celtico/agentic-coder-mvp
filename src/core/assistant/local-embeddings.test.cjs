const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, 'local-embeddings.ts'), 'utf8');
const compiled = esbuild.transformSync(source, { loader: 'ts', format: 'cjs', target: 'node20' }).code;
const loaded = { exports: {} };
new Function('module', 'exports', 'require', '__dirname', compiled)(loaded, loaded.exports, require, __dirname);
const { cosineSimilarity, parseEmbeddingIndex, rankExperiences } = loaded.exports;

test('cosine similarity and semantic experience ranking return the closest verified examples', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  const values = [
    { id: 'near', prompt: 'near', answer: 'answer', evidence: 'verified' },
    { id: 'far', prompt: 'far', answer: 'answer', evidence: 'verified' },
  ];
  const ranked = rankExperiences([1, 0], values, new Map([['near', [0.9, 0.1]], ['far', [0, 1]]]));
  assert.deepEqual(ranked.map((item) => item.id), ['near']);
});

test('persistent embedding index accepts only matching versions and finite vectors', () => {
  const valid = Array.from({ length: 384 }, () => 0.25);
  const contents = JSON.stringify({ version: 1, modelId: 'model-v1', embeddings: {
    good: valid,
    wrongLength: [0.1],
    nonFinite: [...valid.slice(0, 383), null],
  } });
  assert.deepEqual([...parseEmbeddingIndex(contents, 'model-v1').keys()], ['good']);
  assert.equal(parseEmbeddingIndex(contents, 'model-v2').size, 0);
  assert.equal(parseEmbeddingIndex('{broken json', 'model-v1').size, 0);
});
