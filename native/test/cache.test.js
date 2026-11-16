// Prompt cache: reusing saved states must give exactly the tokens a full
// prefill gives (tiny model from make_tiny.py).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { NativeModel } = require('..');

const dir = process.env.TINY_MODEL;
const skip = !dir && 'TINY_MODEL not set';

// Deterministic "random" token ids below the tiny vocabulary.
function ids(n, seed) {
  const out = [];
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(2 + (x % 500));
  }
  return out;
}

function run(model, prompt, options = {}) {
  return [...model.generate(prompt, { maxTokens: 20, ...options })];
}

// The same prompt with nothing saved: the reference.
function fresh(model, prompt) {
  model.clearCache();
  return run(model, prompt, { cache: false });
}

test('a conversation reuses the cache and gives the same tokens', { skip }, () => {
  const model = new NativeModel(dir);
  model.eos = new Set();
  const turn1 = ids(600, 1);
  const answer1 = run(model, turn1);
  assert.strictEqual(model.lastPrompt.reused, 0);

  // Second message: the first prompt, its answer and something new.
  const turn2 = [...turn1, ...answer1, ...ids(50, 2)];
  const answer2 = run(model, turn2);
  assert.strictEqual(model.lastPrompt.reused, turn1.length + answer1.length);
  assert.deepStrictEqual(answer2, fresh(model, turn2));
  assert.deepStrictEqual(answer1, fresh(model, turn1));
});

test('a prompt that changes in the middle starts from a shorter state', { skip }, () => {
  const model = new NativeModel(dir);
  model.eos = new Set();
  const start = ids(300, 3);
  const a = [...start, ...ids(400, 4)];
  const b = [...start, ...ids(400, 5)];
  const c = [...start, ...ids(400, 6)];
  run(model, a);
  // b shares 300 tokens with a: nothing saved covers them yet, so b reads it
  // all and keeps a checkpoint at 300 (as the worker does).
  const gotB = run(model, b);
  assert.strictEqual(model.lastPrompt.reused, 0);
  const gotC = run(model, c);
  assert.strictEqual(model.lastPrompt.reused, 300);
  assert.deepStrictEqual(gotB, fresh(model, b));
  assert.deepStrictEqual(gotC, fresh(model, c));
});

test('changing the adapters drops the saved states', { skip: (!dir || !fs.existsSync(path.join(dir ?? '', 'adapters_init.safetensors'))) && 'LoRA reference not made' }, () => {
  const model = new NativeModel(dir);
  model.eos = new Set();
  const prompt = ids(400, 7);
  run(model, prompt);
  model.engine.loraLoad(path.join(dir, 'adapters_init.safetensors'), 20);
  const got = run(model, [...prompt, ...ids(10, 8)]);
  assert.strictEqual(model.lastPrompt.reused, 0);
  assert.strictEqual(model.memory().promptEntries, 1);  // only the checkpoint just made
  assert.deepStrictEqual(got, fresh(model, [...prompt, ...ids(10, 8)]));
});
