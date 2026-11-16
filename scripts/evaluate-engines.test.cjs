// Benchmark de motors (evaluate-engines.cjs): what it computes, without a model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { median, summarizeEngine, sameAnswers, longText } = require('./evaluate-engines.cjs');

test('medians of the rounds, ignoring missing numbers', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, null, 2]), 3);
  assert.equal(median([]), null);
});

test('one engine: the medians of each kind of request, its peak memory and its short answer', () => {
  const call = (kind, round, metrics, text = null) => ({ kind, round, metrics, text });
  const summary = summarizeEngine('native', 2.7, [
    call('short', 1, { firstTokenSeconds: 0.5, promptTps: 40, generationTps: 25, peakMemoryGb: 7.1 }, 'function suma(a, b) {}'),
    call('short', 2, { firstTokenSeconds: 0.7, promptTps: 30, generationTps: 24 }),
    call('long', 1, { firstTokenSeconds: 20, promptTps: 200, generationTps: 23, promptTokens: 4000, peakMemoryGb: 7.9 }),
    call('second', 1, { firstTokenSeconds: 0.6, cachedTokens: 4100, promptTokens: 4150 }),
  ]);
  assert.equal(summary.name, 'Node');
  assert.equal(summary.short.firstTokenSeconds, 0.6);
  assert.equal(summary.long.promptTps, 200);
  assert.equal(summary.second.cachedTokens, 4100);
  assert.equal(summary.generationTps, 24);
  assert.equal(summary.peakMemoryGb, 7.9);
  assert.equal(summary.shortText, 'function suma(a, b) {}');
});

test('the same greedy answer on every engine: ✓ only when all match; nothing to compare with one engine', () => {
  assert.equal(sameAnswers([{ shortText: 'a' }, { shortText: 'a' }]), true);
  assert.equal(sameAnswers([{ shortText: 'a' }, { shortText: 'b' }]), false);
  assert.equal(sameAnswers([{ shortText: 'a' }]), null);
});

test('the long prompt is fixed text from this repository (about 4.000 tokens)', () => {
  const text = longText();
  assert.ok(text.length > 12000 && text.length < 20000, String(text.length));
  assert.equal(text, longText());
});

test('Avaluació: «Benchmark del model» (as before) and «Benchmark de motors», with its own button and charts, a trophy beside each winner', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'App.tsx'), 'utf8');
  assert.match(app, /rowHeader\('Benchmark del model'[\s\S]*?defaultValue=\{initialView\.evaluationSections\}/);
  assert.match(app, /rowHeader\('Benchmark de motors'[\s\S]*?startEngineBenchmark\(\)[\s\S]*?Passa el benchmark de motors[\s\S]*?ENGINE_CHARTS\.map/);
  // The trophy goes next to the winner of each chart and of the run (no separate podium).
  assert.match(app, /const winner = report\.engines\.length > 1 \? engineWinners\(report\)\.figures\[figureIndex\]\?\.winner : null;[\s\S]*?winner === engine\.name && <Box color="agentic\.fg"/);
  assert.doesNotMatch(app, />Podi</);
  assert.match(app, /label="Esborra aquesta passada" onClick=\{\(\) => void window\.agentic\.deleteEngineBenchmark\(report\.id\)/);
});
