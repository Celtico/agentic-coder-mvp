// Dictation in the chat: the window records, makes the sound a 16 kHz mono WAV (src/app/dictation.ts) and
// sends it here; it is written to a file only this user can read, transcribed on this Mac by a short-lived
// Python process with mlx-whisper (src/core/assistant/mlx_dictation.py), and removed. The text goes back
// to the window's message box; nothing is sent to the model.
//
// One MLX model on the GPU at a time (src/core/assistant/mlx_lock.py): a transcription waits for the chat
// to finish what it is generating, then the chat's model is unloaded (it loads again with the next message)
// and the dictation model is loaded only while it transcribes.
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

const MAX_AUDIO_BYTES = 25_000_000;
/** About ten minutes of 16 kHz mono 16-bit sound. */
const MAX_AUDIO_SECONDS = 600;

/** The Whisper models for dictation: not chat models, never in the chat's selector. */
const DICTATION_MODELS = [
  { id: 'whisper-large-v3-turbo-q4', label: 'Whisper large-v3 turbo (4 bits)', repo: 'mlx-community/whisper-large-v3-turbo-q4', folder: 'whisper-large-v3-turbo-q4', bytes: 463_666_861, kind: 'dictation' },
  { id: 'whisper-small', label: 'Whisper small', repo: 'mlx-community/whisper-small-mlx', folder: 'whisper-small-mlx', bytes: 481_309_720, kind: 'dictation' },
];
const DEFAULT_DICTATION_MODEL = 'whisper-large-v3-turbo-q4';
const DICTATION_LANGUAGES = ['auto', 'ca', 'es', 'en'];

// `coexist`: the warm Whisper lives beside the chat's model instead of one model on the GPU at a time.
// Off by default: the one-model rule came after a kernel panic (13-11-2026, two MLX processes with models).
const defaultDictationPreferences = () => ({ model: DEFAULT_DICTATION_MODEL, language: 'auto', coexist: false });

function normalizeDictationPreferences(value, base = defaultDictationPreferences()) {
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    model: DICTATION_MODELS.some((model) => model.id === saved.model) ? saved.model : base.model,
    language: DICTATION_LANGUAGES.includes(saved.language) ? saved.language : base.language,
    coexist: typeof saved.coexist === 'boolean' ? saved.coexist : base.coexist,
  };
}

/** Where a dictation model's weights live (models/whisper/<folder>), and whether they are there. */
const dictationModelDirectory = (model, modelsRoot) => path.join(modelsRoot, 'whisper', model.folder);
async function dictationModelInstalled(model, modelsRoot) {
  const directory = dictationModelDirectory(model, modelsRoot);
  try {
    await fs.access(path.join(directory, 'config.json'));
    return (await fs.readdir(directory)).some((name) => /^weights\.(?:npz|safetensors)$/.test(name));
  } catch { return false; }
}

/**
 * The recorded sound, checked: a 16 kHz mono PCM WAV of at most ten minutes. Anything else is refused
 * with a word that says why.
 */
function validateDictationAudio(value) {
  if (!value || typeof value !== 'object' || typeof value.data !== 'string') throw new Error('L’àudio del dictat no és vàlid.');
  if (value.data.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) throw new Error('L’àudio del dictat supera la mida o no és vàlid.');
  const buffer = Buffer.from(value.data, 'base64');
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE' || buffer.toString('ascii', 12, 16) !== 'fmt ') throw new Error('L’àudio del dictat ha de ser un WAV.');
  const format = buffer.readUInt16LE(20);
  const channels = buffer.readUInt16LE(22);
  const rate = buffer.readUInt32LE(24);
  const bits = buffer.readUInt16LE(34);
  if (format !== 1 || channels !== 1 || rate !== 16000 || bits !== 16) throw new Error('L’àudio del dictat ha de ser WAV PCM de 16 kHz, mono i 16 bits.');
  const seconds = (buffer.length - 44) / (rate * 2);
  if (seconds < 0.2) throw new Error('La gravació és massa curta.');
  if (seconds > MAX_AUDIO_SECONDS) throw new Error('La gravació supera els deu minuts.');
  return { buffer, seconds };
}

async function writeDictationAudio(directory, buffer) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${randomUUID()}.wav`);
  await fs.writeFile(file, buffer, { mode: 0o600, flag: 'wx' });
  return file;
}

/**
 * Transcriptions one after another. Each waits until the chat is not generating (`chatIdle`), frees the
 * GPU (`freeGpu`: unloads the chat's model) and runs (`run`). `onWaiting` tells the window it waits.
 */
function createDictationQueue({ chatIdle, freeGpu, run, onWaiting = () => {}, pollMs = 500, maxWaitMs = 15 * 60_000 }) {
  let tail = Promise.resolve();
  return function enqueue(job) {
    const task = tail.catch(() => {}).then(async () => {
      const started = Date.now();
      if (!chatIdle()) onWaiting();
      while (!chatIdle()) {
        if (Date.now() - started > maxWaitMs) throw new Error('El xat no ha acabat a temps: el dictat s’ha cancel·lat.');
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      await freeGpu();
      return run(job);
    });
    tail = task;
    return task;
  };
}

/** The text the Python process printed as its last line ({"text"} or {"error"}). */
function parseDictationOutput(stdout) {
  const line = String(stdout || '').trim().split('\n').filter(Boolean).pop();
  let value;
  try { value = JSON.parse(line); } catch { throw new Error('El dictat no ha retornat cap resultat.'); }
  if (value && typeof value.error === 'string') throw new Error(value.error);
  if (!value || typeof value.text !== 'string') throw new Error('El dictat no ha retornat cap text.');
  return value.text.trim();
}

/**
 * A warm Whisper process for live dictation (mlx_dictation.py --serve): `transcribe(file)` sends one audio
 * file and resolves with its text, one at a time in order; `stop()` closes it. `child` is the spawned
 * process (stdin, stdout, events); the first line it prints says it is ready (or why not).
 */
function createLiveTranscriber(child, { readyTimeoutMs = 60_000 } = {}) {
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  let settleReady;
  const ready = new Promise((resolve, reject) => { settleReady = { resolve, reject }; });
  const timer = setTimeout(() => settleReady.reject(new Error('El dictat en directe no s’ha pogut preparar a temps.')), readyTimeoutMs);
  const fail = (error) => {
    clearTimeout(timer);
    settleReady.reject(error);
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  };
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      if (value.ready) { clearTimeout(timer); settleReady.resolve(); continue; }
      if (value.id === undefined && value.error) { fail(new Error(value.error)); continue; }
      const job = pending.get(value.id);
      if (!job) continue;
      pending.delete(value.id);
      if (typeof value.error === 'string') job.reject(new Error(value.error)); else job.resolve(String(value.text || '').trim());
    }
  });
  child.once('error', fail);
  child.once('exit', () => fail(new Error('El dictat en directe s’ha aturat.')));
  return {
    ready,
    transcribe(file) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, file }) + '\n');
      });
    },
    stop() { try { child.stdin.end(); } catch { /* already closed */ } },
  };
}

/** A warm Whisper stays resident this long after the last dictation, then is closed. */
const LIVE_DICTATION_IDLE_MS = 10 * 60_000;

/**
 * The warm Whisper kept between dictations: `acquire()` gives the resident one (or starts one with
 * `start()`), `idle()` arms the timer that closes it after `idleMs` without dictation, `release()` closes it
 * now (the chat is about to use the GPU, or the app quits). One at a time.
 */
function createResidentTranscriber({ start, idleMs = LIVE_DICTATION_IDLE_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let current = null;
  let timer = null;
  const cancelTimer = () => { if (timer) { clearTimer(timer); timer = null; } };
  const release = () => { cancelTimer(); if (current) { const closing = current; current = null; closing.stop(); } };
  return {
    async acquire() {
      cancelTimer();
      if (current) return current;
      const fresh = start();
      current = fresh;
      try { await fresh.ready; } catch (error) { if (current === fresh) current = null; fresh.stop(); throw error; }
      return fresh;
    },
    idle() { cancelTimer(); if (current) timer = setTimer(release, idleMs); },
    release,
    get resident() { return current !== null; },
  };
}

/**
 * Whether a warm Whisper (~0.5 GB loaded, a little more while it transcribes) fits beside the chat's model:
 * on a Mac with 12 GB or more it always does; on a smaller one only with 1.5 GB free. (macOS counts its file
 * cache as used memory, so the free figure alone would say no too often.)
 */
const WHISPER_MIN_FREE_BYTES = 1.5 * 1024 ** 3;
const WHISPER_ROOMY_TOTAL_BYTES = 12 * 1024 ** 3;
const roomForWhisper = (freeBytes, totalBytes = 0) => totalBytes >= WHISPER_ROOMY_TOTAL_BYTES || (Number.isFinite(freeBytes) && freeBytes >= WHISPER_MIN_FREE_BYTES);

module.exports = {
  createLiveTranscriber, createResidentTranscriber, LIVE_DICTATION_IDLE_MS, WHISPER_MIN_FREE_BYTES, roomForWhisper,
  DICTATION_MODELS, DEFAULT_DICTATION_MODEL, DICTATION_LANGUAGES, MAX_AUDIO_BYTES,
  defaultDictationPreferences, normalizeDictationPreferences, dictationModelDirectory, dictationModelInstalled,
  validateDictationAudio, writeDictationAudio, createDictationQueue, parseDictationOutput,
};
