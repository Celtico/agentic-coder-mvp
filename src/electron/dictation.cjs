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

const defaultDictationPreferences = () => ({ model: DEFAULT_DICTATION_MODEL, language: 'auto' });

function normalizeDictationPreferences(value, base = defaultDictationPreferences()) {
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    model: DICTATION_MODELS.some((model) => model.id === saved.model) ? saved.model : base.model,
    language: DICTATION_LANGUAGES.includes(saved.language) ? saved.language : base.language,
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

module.exports = {
  DICTATION_MODELS, DEFAULT_DICTATION_MODEL, DICTATION_LANGUAGES, MAX_AUDIO_BYTES,
  defaultDictationPreferences, normalizeDictationPreferences, dictationModelDirectory, dictationModelInstalled,
  validateDictationAudio, writeDictationAudio, createDictationQueue, parseDictationOutput,
};
