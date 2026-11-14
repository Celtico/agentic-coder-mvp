// The dictation process's own logic (mlx_dictation.py), without mlx-whisper or a model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const python = path.join(__dirname, '..', '..', '..', 'models', '.mlx-venv', 'bin', 'python');
const available = fs.existsSync(python);

test('the language is detected unless one is fixed; the WAV is read without ffmpeg', { skip: !available && 'no MLX runtime' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-mlx-dictation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = `import sys, json, wave, struct
sys.path.insert(0, ${JSON.stringify(__dirname)})
import mlx_dictation as d
good = ${JSON.stringify(path.join(dir, 'good.wav'))}
bad = ${JSON.stringify(path.join(dir, 'bad.wav'))}
with wave.open(good, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(struct.pack("<3h", 0, 16384, -32768))
with wave.open(bad, "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(44100); w.writeframes(struct.pack("<2h", 0, 0))
samples = d.read_wav(good)
try:
    d.read_wav(bad); bad_error = None
except ValueError as error:
    bad_error = str(error)
print(json.dumps([d.language_option("auto"), d.language_option("ca"), d.language_option("fr"), samples.tolist(), str(samples.dtype), bad_error, d.main(["x"])]))`;
  const result = spawnSync(python, ['-I', '-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.deepEqual(out.slice(0, 3), [null, 'ca', null]);
  assert.deepEqual(out[3], [0, 0.5, -1]);
  assert.equal(out[4], 'float32');
  assert.match(out[5], /16 kHz, mono/);
  assert.equal(out[6], 2, 'wrong arguments end with an error, without loading anything');
});
