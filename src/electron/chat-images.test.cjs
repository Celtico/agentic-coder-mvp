// Images of a chat request in the main process (src/electron/chat-images.cjs) and what the chat keeps of them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateChatImages, writeChatImages, removeChatImages } = require('./chat-images.cjs');
const { ChatStore } = require('./chat-store.cjs');
const { hasVision } = require('./mlx-models.cjs');

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);

test('images are checked: allowed type, its real format, size and count', () => {
  assert.deepEqual(validateChatImages(undefined), []);
  const ok = validateChatImages([{ name: '../../secret/captura.png', mime: 'image/png', data: png.toString('base64') }, { mime: 'image/jpeg', data: jpeg.toString('base64') }, { name: 'w.webp', mime: 'image/webp', data: webp.toString('base64') }]);
  assert.deepEqual(ok.map((image) => [image.name, image.mime, image.buffer.length]), [['captura.png', 'image/png', png.length], ['imatge-2.jpg', 'image/jpeg', jpeg.length], ['w.webp', 'image/webp', webp.length]]);
  assert.throws(() => validateChatImages([{ mime: 'image/png', data: jpeg.toString('base64') }]), /no és un PNG vàlid/);
  assert.throws(() => validateChatImages([{ mime: 'image/gif', data: png.toString('base64') }]), /no és vàlida/);
  assert.throws(() => validateChatImages([{ mime: 'image/png', data: 'not base64!' }]), /no és vàlida/);
  assert.throws(() => validateChatImages([{ mime: 'image/png', data: 'A'.repeat(11_000_000) }]), /supera la mida/);
  assert.throws(() => validateChatImages(Array(5).fill({ mime: 'image/png', data: png.toString('base64') })), /Com a molt 4/);
  assert.throws(() => validateChatImages('x'), /no són vàlides/);
});

test('they are written for the worker, readable only by the user, and removed afterwards', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-chat-images-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = await writeChatImages(path.join(dir, 'chat-images'), validateChatImages([{ mime: 'image/png', data: png.toString('base64') }, { mime: 'image/webp', data: webp.toString('base64') }]));
  assert.equal(paths.length, 2);
  assert.match(paths[0], /\.png$/); assert.match(paths[1], /\.webp$/);
  assert.deepEqual(fs.readFileSync(paths[0]), png);
  assert.equal(fs.statSync(paths[0]).mode & 0o777, 0o600);
  await removeChatImages(paths);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'chat-images')), []);
  assert.deepEqual(await writeChatImages(path.join(dir, 'none'), []), []);
});

test('a chat message keeps only valid small thumbnails of its images', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-chat-thumbs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ChatStore(path.join(dir, 'chats.sqlite'));
  const thumbnail = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  store.saveMany([{ id: 'a', title: 't', updatedAt: '2026-11-14T00:00:00.000Z', messages: [{ role: 'user', text: 'mira', images: [{ name: 'a.png', thumbnail }, { name: 'b', thumbnail: 'data:text/html;base64,PHNjcmlwdD4=' }, { name: 'c', thumbnail: `data:image/jpeg;base64,${'A'.repeat(90_000)}` }] }, { role: 'assistant', text: 'fet' }] }]);
  assert.deepEqual(store.get('a').messages, [{ role: 'user', text: 'mira', images: [{ name: 'a.png', thumbnail }] }, { role: 'assistant', text: 'fet' }]);
  store.close();
});

test('the model list marks a model with vision only when its weights have the tower', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-has-vision-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = (name, config, files) => { fs.mkdirSync(path.join(dir, name)); fs.writeFileSync(path.join(dir, name, 'config.json'), JSON.stringify(config)); for (const [file, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, name, file), value); };
  folder('vl', { vision_config: {} }, { 'model.safetensors.index.json': JSON.stringify({ weight_map: { 'vision_tower.blocks.0.attn.qkv.weight': 'a' } }) });
  folder('text', { image_token_id: 3 }, { 'model.safetensors.index.json': JSON.stringify({ weight_map: { 'language_model.lm_head.weight': 'a' } }) });
  // A single file of weights: the tensors are read from its header.
  const header = Buffer.from(JSON.stringify({ 'model.visual.patch_embed.proj.weight': { dtype: 'F16', shape: [1], data_offsets: [0, 2] } }));
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(header.length));
  folder('single', { vision_config: {} }, { 'model.safetensors': Buffer.concat([length, header, Buffer.alloc(2)]) });
  assert.equal(await hasVision(path.join(dir, 'vl')), true);
  assert.equal(await hasVision(path.join(dir, 'text')), false);
  assert.equal(await hasVision(path.join(dir, 'single')), true);
  assert.equal(await hasVision(null), false);
  assert.equal(await hasVision(path.join(dir, 'missing')), false);
});
