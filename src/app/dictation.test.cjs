// The window's side of dictation (src/app/dictation.ts): the WAV it sends and how the text is added.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { validateDictationAudio } = require('../electron/dictation.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-dictation-window-'));
const out = path.join(dir, 'dictation.cjs');
esbuild.buildSync({ entryPoints: [path.join(__dirname, 'dictation.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
const dictation = require(out);
fs.rmSync(dir, { recursive: true, force: true });

test('the WAV the window writes is the one the main process accepts', () => {
  const samples = new Float32Array(16000).map((_, index) => Math.sin(index / 10) * 0.5);
  const wav = Buffer.from(dictation.encodeWav(samples));
  assert.equal(wav.length, 44 + 32000);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(validateDictationAudio({ data: dictation.toBase64(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.length)) }).seconds, 1);
});

test('samples are clipped to 16 bits and channels are averaged', () => {
  const wav = Buffer.from(dictation.encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5])));
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((index) => wav.readInt16LE(44 + index * 2)), [0, 32767, -32768, 32767, -32768, 16383]);
  assert.deepEqual(Array.from(dictation.mixToMono([new Float32Array([1, 0, 0.5]), new Float32Array([0, 0, 0.5, 9])])), [0.5, 0, 0.5]);
  assert.equal(dictation.mixToMono([]).length, 0);
});

test('the dictated text is added to what is written, never sent by itself', () => {
  assert.equal(dictation.appendDictation('', ' Hola. '), 'Hola.');
  assert.equal(dictation.appendDictation('Crea un botó ', 'que sumi un.'), 'Crea un botó que sumi un.');
  assert.equal(dictation.appendDictation('Ja escrit', '   '), 'Ja escrit');
  assert.equal(dictation.MAX_RECORDING_MS, 300000);
});
