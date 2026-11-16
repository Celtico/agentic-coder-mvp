// The podium of the engine benchmark (src/app/engine-podium.ts): who wins each figure and overall.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-engine-podium-'));
const out = path.join(dir, 'engine-podium.cjs');
esbuild.buildSync({ entryPoints: [path.join(__dirname, 'engine-podium.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
const { engineWinners } = require(out);

const engine = (name, values) => ({ runtime: name, name, loadSeconds: values.load, short: { firstTokenSeconds: values.short }, long: { promptTps: values.read }, second: { firstTokenSeconds: values.second }, generationTps: values.gen, peakMemoryGb: values.memory });

test('less is better for times and memory, more for speeds; under 2% or under 0,1 s is a tie', () => {
  // cel's run of 16-11-2026, 11:23.
  const podium = engineWinners({ engines: [
    engine('natiu', { load: 2.6, read: 203.34, gen: 26.14, short: 0.25, second: 0.25, memory: 9.89 }),
    engine('Python', { load: 6.5, read: 163.91, gen: 25.68, short: 0.26, second: 0.28, memory: 9.89 }),
  ] });
  // Load 2,6 vs 6,5 s and reading 203 vs 164 tok/s are wins; 0,25 vs 0,26 and 0,25 vs 0,28 s are ties (under 0,1 s).
  assert.deepEqual(podium.figures.map((figure) => figure.winner), ['natiu', 'natiu', null, null, null, null]);
  // Memory is a tie only with the same value to 3 decimals: 9,889 against 9,89 is a win.
  const memory = engineWinners({ engines: [engine('Node', { load: 1, read: 1, gen: 1, short: 1, second: 1, memory: 9.889 }), engine('Python', { load: 1, read: 1, gen: 1, short: 1, second: 1, memory: 9.89 })] });
  assert.equal(memory.figures[5].winner, 'Node');
  assert.match(podium.figures[1].detail, /24% més/);
  assert.deepEqual(podium.figures[1].entries.map((entry) => entry.runtime), ['natiu', 'Python']);
  assert.equal(podium.figures[2].tie, true);
  assert.deepEqual(podium.wins.map(({ name, wins }) => ({ name, wins })), [{ name: 'natiu', wins: 2 }, { name: 'Python', wins: 0 }]);
  assert.equal(podium.ties, 4);
  assert.equal(podium.overall, 'natiu');
});

test('as many figures won by each engine is a tie overall; one engine alone has nothing to compare', () => {
  const podium = engineWinners({ engines: [
    engine('natiu', { load: 2, read: 100, gen: 20, short: 1, second: 1, memory: 9 }),
    engine('Python', { load: 4, read: 200, gen: 20, short: 1, second: 1, memory: 9 }),
  ] });
  assert.equal(podium.overall, null);
  assert.deepEqual(engineWinners({ engines: [engine('natiu', { load: 2, read: 1, gen: 1, short: 1, second: 1, memory: 1 })] }).figures.every((figure) => figure.winner === null), true);
});
