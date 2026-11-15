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

test('live dictation: never two partial passes at once; one that waits is replaced by the newest; clear and idle', async () => {
  const ran = [];
  let release;
  const queue = dictation.createLatestQueue((job) => { ran.push(job); return new Promise((resolve) => { release = resolve; }); });
  queue.push('a');
  queue.push('b');
  queue.push('c');
  assert.deepEqual(ran, ['a'], 'one at a time');
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ran, ['a', 'c'], 'b was replaced by the newer c');
  queue.push('d');
  queue.clear();
  const idle = queue.idle();
  release();
  await idle;
  assert.deepEqual(ran, ['a', 'c'], 'd dropped by clear (the final pass runs instead)');
  assert.equal(dictation.LIVE_CHUNK_MS, 2500);
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  assert.match(app, /if \(live\.live\) recorder\.start\(LIVE_CHUNK_MS\); else recorder\.start\(\);/);
  assert.match(app, /partials\.clear\(\);\n\s*void partials\.idle\(\)\.then\(\(\) => transcribeRecording\(/, 'the final pass waits for the partial in flight');
  assert.match(app, /\{dictationPartial && <Text [^>]*color="fg\.muted"[^>]*data-dictation-partial>/);
});

test('silence never goes to Whisper: the level of the WAV, and each partial decodes the whole recording so far', () => {
  const silent = dictation.encodeWav(new Float32Array(16000));
  const spoken = dictation.encodeWav(new Float32Array(16000).map((_, index) => Math.sin(index / 5) * 0.3));
  assert.equal(dictation.isSilent(dictation.wavLevel(silent)), true);
  assert.equal(dictation.isSilent(dictation.wavLevel(spoken)), false);
  assert.equal(dictation.wavLevel(spoken).seconds, 1);
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  assert.match(app, /partials\.push\(new Blob\(chunks, \{ type: recorder\.mimeType \}\)\)/, 'all the chunks from the first (with the header)');
  assert.match(app, /if \(isSilent\(wavLevel\(wav\)\)\) return;/);
  assert.match(app, /setStatus\(silentNotice\(\{ device: microphoneLabelRef\.current, status: microphone\?\.status, launcher: microphone\?\.launcher \}\)\);/);
  assert.match(app, /microphoneLabelRef\.current = stream\.getAudioTracks\(\)\[0\]\?\.label \|\| null;/);
});

test('a silent recording names the microphone used, says the closed lid first, then the permission of the app macOS counts', () => {
  const granted = dictation.silentNotice({ device: 'Micròfon del MacBook Pro', status: 'granted', launcher: 'Terminal' });
  assert.equal(granted, 'No arriba so de «Micròfon del MacBook Pro»: si el portàtil té la tapa tancada, obre-la o tria un altre micròfon a Configuració del Sistema › So › Entrada; comprova també el permís de micròfon de «Terminal» (Privadesa i seguretat › Micròfon).');
  assert.match(dictation.silentNotice({ status: 'denied', launcher: null }), /^No arriba so del micròfon: [^;]*; macOS no dona el micròfon a «Electron»: activa-ho a Configuració del Sistema › Privadesa i seguretat › Micròfon\.$/);
});
