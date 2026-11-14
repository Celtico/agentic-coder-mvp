// Images attached to a chat message (src/app/image-attachments.ts): what is accepted and at what size it goes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-image-attachments-'));
const out = path.join(dir, 'image-attachments.cjs');
esbuild.buildSync({ entryPoints: [path.join(__dirname, 'image-attachments.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
const images = require(out);
fs.rmSync(dir, { recursive: true, force: true });

test('PNG, JPEG and WebP up to 20 MB, four per message', () => {
  assert.equal(images.imageProblem({ name: 'a.png', type: 'image/png', size: 1000 }, 0), null);
  assert.equal(images.imageProblem({ name: 'a.jpg', type: 'image/jpeg', size: 20_000_000 }, 3), null);
  assert.match(images.imageProblem({ name: 'a.gif', type: 'image/gif', size: 10 }, 0), /només PNG, JPEG o WebP/);
  assert.match(images.imageProblem({ name: 'a.svg', type: 'image/svg+xml', size: 10 }, 0), /només PNG/);
  assert.match(images.imageProblem({ name: 'big.png', type: 'image/png', size: 20_000_001 }, 0), /20 MB/);
  assert.match(images.imageProblem({ name: 'empty.png', type: 'image/png', size: 0 }, 0), /buit/);
  assert.match(images.imageProblem({ name: 'fifth.png', type: 'image/png', size: 10 }, 4), /com a molt 4/);
  assert.equal(images.isImageFile({ type: '', name: 'Captura.PNG' }), true);
  assert.equal(images.isImageFile({ type: 'text/plain', name: 'notes.txt' }), false);
});

test('an image is sent at about 1.5 MP at most, with its shape; small ones keep their size', () => {
  assert.deepEqual(images.fitWithin(800, 600), { width: 800, height: 600 });
  const big = images.fitWithin(4032, 3024);
  assert.ok(big.width * big.height <= 1_500_000, JSON.stringify(big));
  assert.ok(big.width * big.height > 1_450_000, 'not much smaller than it has to be');
  assert.ok(Math.abs(big.width / big.height - 4032 / 3024) < 0.01, 'same shape');
  const screenshot = images.fitWithin(3456, 2234);
  assert.ok(screenshot.width * screenshot.height <= 1_500_000);
  assert.deepEqual(images.fitWithin(0, 100), { width: 0, height: 0 });
  assert.deepEqual(images.fitWithin(100000, 1), { width: 100000, height: 1 });
});

test('the chat keeps a thumbnail of 160 px at most, and PNG stays PNG', () => {
  assert.deepEqual(images.thumbnailSize(1600, 900), { width: 160, height: 90 });
  assert.deepEqual(images.thumbnailSize(900, 1600), { width: 90, height: 160 });
  assert.deepEqual(images.thumbnailSize(100, 50), { width: 100, height: 50 });
  assert.equal(images.outputType('image/png'), 'image/png');
  assert.equal(images.outputType('image/webp'), 'image/jpeg');
  assert.equal(images.outputType('image/jpeg'), 'image/jpeg');
});
