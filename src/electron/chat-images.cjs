// Images that come with a chat request (src/app/image-attachments.ts): checked here, written to files for
// the model's worker, and removed when the request ends. Only the current request carries them.
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8_000_000;

// The first bytes of each format: the declared type has to match what the file is.
const looksLike = {
  'image/png': (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
};

/** The images of a request as buffers, or an error that says what is wrong. No images: an empty list. */
function validateChatImages(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Les imatges adjuntes no són vàlides.');
  if (value.length > MAX_IMAGES) throw new Error(`Com a molt ${MAX_IMAGES} imatges per missatge.`);
  return value.map((image, index) => {
    if (!image || typeof image !== 'object' || !(image.mime in TYPES) || typeof image.data !== 'string') throw new Error(`La imatge ${index + 1} no és vàlida.`);
    if (image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error(`La imatge ${index + 1} supera la mida o no és vàlida.`);
    const buffer = Buffer.from(image.data, 'base64');
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES || !looksLike[image.mime](buffer)) throw new Error(`La imatge ${index + 1} no és un ${image.mime.slice(6).toUpperCase()} vàlid.`);
    const name = typeof image.name === 'string' && image.name.trim() ? path.basename(image.name).slice(0, 120) : `imatge-${index + 1}.${TYPES[image.mime]}`;
    return { name, mime: image.mime, buffer };
  });
}

/** Writes the images for the worker, readable only by this user; returns their paths. */
async function writeChatImages(directory, images) {
  if (!images.length) return [];
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const paths = [];
  for (const image of images) {
    const file = path.join(directory, `${randomUUID()}.${TYPES[image.mime]}`);
    await fs.writeFile(file, image.buffer, { mode: 0o600, flag: 'wx' });
    paths.push(file);
  }
  return paths;
}

async function removeChatImages(paths) {
  await Promise.all((paths || []).map((file) => fs.rm(file, { force: true }).catch(() => {})));
}

module.exports = { validateChatImages, writeChatImages, removeChatImages, MAX_IMAGES, MAX_IMAGE_BYTES };
