// Which library answers a request with images, and how the images reach the message (mlx_vision.py).
// Pure Python: neither mlx_lm nor mlx_vlm is imported, no model is loaded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const venv = path.join(__dirname, '..', '..', '..', 'models', '.mlx-venv', 'bin', 'python');
const python = fs.existsSync(venv) ? venv : 'python3';
const available = spawnSync(python, ['--version']).status === 0;

function run(script) {
  const result = spawnSync(python, ['-I', '-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(__dirname)})\nimport mlx_vision\n${script}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

test('images go to mlx-vlm only on a model with vision and with mlx-vlm installed; once there it stays', { skip: !available && 'no Python' }, () => {
  const out = run(`print(json.dumps([
    mlx_vision.choose_backend(False, True, True, "text"),
    mlx_vision.choose_backend(True, True, True, "text"),
    mlx_vision.choose_backend(True, False, True, "text"),
    mlx_vision.choose_backend(True, True, False, "text"),
    mlx_vision.choose_backend(False, True, True, "vision"),
  ]))`);
  assert.deepEqual(out[0], ['text', null]);
  assert.deepEqual(out[1], ['vision', null]);
  assert.equal(out[2][0], 'text'); assert.match(out[2][1], /no pot veure imatges/);
  assert.equal(out[3][0], 'text'); assert.match(out[3][1], /Falta mlx-vlm/);
  assert.deepEqual(out[4], ['vision', null], 'text requests after the switch stay on the one model in memory');
});

test('the images become slots before the text of the request’s message only', { skip: !available && 'no Python' }, () => {
  const out = run(`m = [{"role": "system", "content": "s"}, {"role": "user", "content": "abans"}, {"role": "assistant", "content": "r"}, {"role": "user", "content": "mira-ho"}]
print(json.dumps([mlx_vision.with_images(m, 3, 2), mlx_vision.with_images(m, None, 2), mlx_vision.with_images(m, 9, 1), m]))`);
  assert.deepEqual(out[0][3].content, [{ type: 'image' }, { type: 'image' }, { type: 'text', text: 'mira-ho' }]);
  assert.equal(out[0][1].content, 'abans', 'earlier messages carry no image');
  assert.deepEqual(out[1], out[3]);
  assert.deepEqual(out[2], out[3]);
  assert.equal(out[3][3].content, 'mira-ho', 'the request is not changed in place');
});

test('a model has vision when its config and its weights both have the tower', { skip: !available && 'no Python' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-vision-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, files) => { fs.mkdirSync(path.join(dir, name)); for (const [file, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, name, file), JSON.stringify(value)); };
  write('vl', { 'config.json': { vision_config: { depth: 27 } }, 'model.safetensors.index.json': { weight_map: { 'vision_tower.blocks.0.attn.proj.weight': 'a', 'language_model.model.embed_tokens.weight': 'a' } } });
  write('text-of-vl', { 'config.json': { image_token_id: 1 }, 'model.safetensors.index.json': { weight_map: { 'language_model.model.embed_tokens.weight': 'a' } } });
  write('config-only', { 'config.json': { vision_config: {} }, 'model.safetensors.index.json': { weight_map: { 'language_model.lm_head.weight': 'a' } } });
  fs.writeFileSync(path.join(dir, 'image.png'), 'x');
  const out = run(`d = ${JSON.stringify(dir)}
print(json.dumps([mlx_vision.model_has_vision(d + "/vl"), mlx_vision.model_has_vision(d + "/text-of-vl"), mlx_vision.model_has_vision(d + "/config-only"), mlx_vision.model_has_vision(d + "/missing"),
  mlx_vision.image_paths({"images": {"paths": [d + "/image.png", d + "/gone.png", 3], "message": 2}}), mlx_vision.image_paths({}), mlx_vision.image_paths({"images": {"paths": [d + "/image.png"], "message": -1}})]))`);
  assert.deepEqual(out.slice(0, 4), [true, false, false, false]);
  assert.deepEqual(out[4], [[path.join(dir, 'image.png')], 2]);
  assert.deepEqual(out[5], [[], null]);
  assert.deepEqual(out[6], [[path.join(dir, 'image.png')], null]);
});
