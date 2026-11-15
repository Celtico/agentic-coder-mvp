// Dictation in the main process (src/electron/dictation.cjs): the sound it accepts, the queue that keeps
// one model on the GPU, the preferences and the dictation models.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dictation = require('./dictation.cjs');
const mlxModels = require('./mlx-models.cjs');

function wav({ seconds = 1, rate = 16000, channels = 1, bits = 16, format = 1 } = {}) {
  const data = Math.round(seconds * rate) * channels * (bits / 8);
  const buffer = Buffer.alloc(44 + data);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + data, 4); buffer.write('WAVE', 8); buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(format, 20); buffer.writeUInt16LE(channels, 22); buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * channels * bits / 8, 28); buffer.writeUInt16LE(channels * bits / 8, 32); buffer.writeUInt16LE(bits, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(data, 40);
  return buffer.toString('base64');
}

test('only a 16 kHz mono 16-bit WAV between 0.2 s and ten minutes is accepted', () => {
  assert.equal(Math.round(dictation.validateDictationAudio({ data: wav({ seconds: 2.5 }) }).seconds * 10), 25);
  assert.throws(() => dictation.validateDictationAudio({ data: wav({ rate: 44100 }) }), /16 kHz, mono i 16 bits/);
  assert.throws(() => dictation.validateDictationAudio({ data: wav({ channels: 2 }) }), /16 kHz, mono/);
  assert.throws(() => dictation.validateDictationAudio({ data: wav({ format: 3, bits: 16 }) }), /PCM/);
  assert.throws(() => dictation.validateDictationAudio({ data: wav({ seconds: 0.1 }) }), /massa curta/);
  assert.throws(() => dictation.validateDictationAudio({ data: wav({ seconds: 601 }) }), /deu minuts/);
  assert.throws(() => dictation.validateDictationAudio({ data: Buffer.from('OggS'.padEnd(64, '\0')).toString('base64') }), /ha de ser un WAV/);
  assert.throws(() => dictation.validateDictationAudio({ data: 'no és base64!' }), /no és vàlid/);
  assert.throws(() => dictation.validateDictationAudio(null), /no és vàlid/);
  assert.throws(() => dictation.validateDictationAudio({ data: 'A'.repeat(40_000_000) }), /supera la mida/);
});

test('the dictation preferences: a known Whisper model and auto, ca, es or en', () => {
  assert.deepEqual(dictation.defaultDictationPreferences(), { model: 'whisper-large-v3-turbo-q4', language: 'auto' });
  assert.deepEqual(dictation.normalizeDictationPreferences({ model: 'whisper-small', language: 'ca' }), { model: 'whisper-small', language: 'ca' });
  assert.deepEqual(dictation.normalizeDictationPreferences({ model: 'whisper-huge', language: 'fr' }), dictation.defaultDictationPreferences());
  assert.deepEqual(dictation.normalizeDictationPreferences('x', { model: 'whisper-small', language: 'es' }), { model: 'whisper-small', language: 'es' });
});

test('dictation models are their own kind, with their download, and never in the chat’s list', async (t) => {
  assert.ok(dictation.DICTATION_MODELS.every((model) => model.kind === 'dictation' && /^mlx-community\//.test(model.repo) && model.bytes > 100e6 && model.bytes < 1e9));
  const chat = await mlxModels.listModels(path.join(os.tmpdir(), 'no-models-here'));
  assert.ok(!chat.some((model) => dictation.DICTATION_MODELS.some((item) => item.id === model.id || item.repo === model.modelId)));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-dictation-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const model = dictation.DICTATION_MODELS[0];
  assert.equal(await dictation.dictationModelInstalled(model, root), false);
  fs.mkdirSync(dictation.dictationModelDirectory(model, root), { recursive: true });
  fs.writeFileSync(path.join(dictation.dictationModelDirectory(model, root), 'config.json'), '{}');
  assert.equal(await dictation.dictationModelInstalled(model, root), false, 'config without weights');
  fs.writeFileSync(path.join(dictation.dictationModelDirectory(model, root), 'weights.npz'), 'x');
  assert.equal(await dictation.dictationModelInstalled(model, root), true);
  assert.equal(dictation.dictationModelDirectory(model, root), path.join(root, 'whisper', 'whisper-large-v3-turbo-q4'));
});

test('a transcription waits for the chat to finish, frees the GPU, and runs one at a time', async () => {
  let busy = true;
  const events = [];
  const enqueue = dictation.createDictationQueue({
    chatIdle: () => !busy,
    freeGpu: async () => { events.push('free'); },
    run: async (job) => { events.push(`start ${job}`); await new Promise((resolve) => setTimeout(resolve, 20)); events.push(`end ${job}`); return `text ${job}`; },
    onWaiting: () => events.push('waiting'),
    pollMs: 5,
  });
  const first = enqueue('a');
  const second = enqueue('b');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(events, ['waiting'], 'nothing runs while the chat generates');
  busy = false;
  assert.equal(await first, 'text a');
  assert.equal(await second, 'text b');
  assert.deepEqual(events, ['waiting', 'free', 'start a', 'end a', 'free', 'start b', 'end b']);
});

test('a failed transcription does not stop the next one, and a chat that never ends gives up', async () => {
  const enqueue = dictation.createDictationQueue({ chatIdle: () => true, freeGpu: async () => {}, run: async (job) => { if (job === 'bad') throw new Error('falla'); return job; } });
  await assert.rejects(enqueue('bad'), /falla/);
  assert.equal(await enqueue('good'), 'good');
  const stuck = dictation.createDictationQueue({ chatIdle: () => false, freeGpu: async () => {}, run: async () => 'never', pollMs: 2, maxWaitMs: 10 });
  await assert.rejects(stuck('x'), /no ha acabat a temps/);
});

test('the Python process answers with one JSON line', () => {
  assert.equal(dictation.parseDictationOutput('loading…\n{"text": " Hola, món. "}\n'), 'Hola, món.');
  assert.throws(() => dictation.parseDictationOutput('{"error": "Falta mlx-whisper al runtime MLX"}'), /Falta mlx-whisper/);
  assert.throws(() => dictation.parseDictationOutput(''), /cap resultat/);
  assert.throws(() => dictation.parseDictationOutput('{"other": 1}'), /cap text/);
});

test('the recording is written for the transcription, readable only by the user', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-dictation-audio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { buffer } = dictation.validateDictationAudio({ data: wav() });
  const file = await dictation.writeDictationAudio(path.join(dir, 'dictation'), buffer);
  assert.match(file, /\.wav$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(file), buffer);
});

test('the warm transcriber: ready first, then one answer per file in order; a crash fails what waits', async () => {
  const { createLiveTranscriber } = require('./dictation.cjs');
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  const sent = [];
  child.stdin = { write: (line) => sent.push(JSON.parse(line)), end: () => sent.push('end') };
  const live = createLiveTranscriber(child);
  child.stdout.emit('data', '{"ready": true}\n');
  await live.ready;
  const first = live.transcribe('/tmp/a.wav');
  const second = live.transcribe('/tmp/b.wav');
  assert.deepEqual(sent, [{ id: 1, file: '/tmp/a.wav' }, { id: 2, file: '/tmp/b.wav' }]);
  child.stdout.emit('data', '{"id": 1, "text": " Hola "}\n{"id": 2, "te');
  child.stdout.emit('data', 'xt": "què tal"}\n');
  assert.deepEqual(await Promise.all([first, second]), ['Hola', 'què tal']);
  const third = live.transcribe('/tmp/c.wav');
  child.emit('exit', 1);
  await assert.rejects(third, /s’ha aturat/);
  live.stop();
  assert.equal(sent.at(-1), 'end');
});
