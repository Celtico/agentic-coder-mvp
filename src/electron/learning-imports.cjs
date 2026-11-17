// Aprenentatge local › Dades JSON: training examples loaded from a .jsonl file (one conversation per line,
// {"messages": [{"role": "user", "content": "…"}, {"role": "assistant", "content": "…"}]}, as mlx_lm and
// the app's own «Descarrega (.jsonl)» write them). Each file is checked and copied into the app's data
// folder; the betas and stable candidates train with its examples beside the verified cases.
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * One line made safe: a conversation with text messages that ends with the assistant's answer, or null. A
 * line can also be a case as «Crea un cas» writes it ({"task", "prompt", "answer", "evidence"}): its
 * prompt is the user's message and its answer the assistant's.
 */
function readExample(line) {
  let value;
  try { value = JSON.parse(line); } catch { return null; }
  if (value && !Array.isArray(value.messages) && typeof value.prompt === 'string' && typeof value.answer === 'string') {
    value = { messages: [{ role: 'user', content: value.prompt }, { role: 'assistant', content: value.answer }] };
  }
  const messages = Array.isArray(value?.messages) ? value.messages : null;
  if (!messages || messages.length < 2) return null;
  if (!messages.every((message) => message && ROLES.has(message.role) && typeof message.content === 'string' && message.content.trim())) return null;
  if (!messages.some((message) => message.role === 'user') || messages[messages.length - 1].role !== 'assistant') return null;
  return { messages: messages.map(({ role, content }) => ({ role, content })) };
}

/** The examples of a file's text, and how many lines were not one. */
function readExamples(text) {
  const lines = String(text || '').split('\n').filter((line) => line.trim());
  const examples = lines.map(readExample).filter(Boolean);
  return { examples, skipped: lines.length - examples.length };
}

/** The files loaded, with their examples counted: [{ name, examples, skipped, bytes, addedAt }]. */
async function listImports(directory) {
  const found = [];
  for (const name of (await fs.readdir(directory).catch(() => [])).filter((item) => item.endsWith('.jsonl')).sort()) {
    const file = path.join(directory, name);
    const [text, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    const { examples, skipped } = readExamples(text);
    found.push({ name, examples: examples.length, skipped, bytes: stat.size, addedAt: stat.mtime.toISOString() });
  }
  return found;
}

/** Copies a .jsonl file into the folder after checking it (at least one valid example); returns its new name. */
async function addImport(directory, source) {
  if (!/\.jsonl$/i.test(source)) throw new Error('Tria un fitxer .jsonl (una conversa per línia).');
  const stat = await fs.stat(source);
  if (stat.size > MAX_FILE_BYTES) throw new Error('El fitxer és massa gran (màxim 50 MB).');
  const text = await fs.readFile(source, 'utf8');
  const { examples } = readExamples(text);
  if (!examples.length) throw new Error('Aquest fitxer no té cap conversa vàlida ({"messages": [...]} que acabi amb la resposta de l’assistent).');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const base = path.basename(source).replace(/\.jsonl$/i, '').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'dades';
  let name = `${base}.jsonl`;
  for (let n = 2; await fs.access(path.join(directory, name)).then(() => true, () => false); n++) name = `${base}-${n}.jsonl`;
  await fs.writeFile(path.join(directory, name), text, { mode: 0o600 });
  return name;
}

/** The path of a loaded file, only if it is one of the folder's (for removing it). */
async function importPath(directory, name) {
  const names = await fs.readdir(directory).catch(() => []);
  if (typeof name !== 'string' || !name.endsWith('.jsonl') || !names.includes(name)) throw new Error('Aquest fitxer ja no hi és.');
  return path.join(directory, name);
}

/** Every loaded example that fits the training length (estimated as the training does), with its file. */
async function importedExamples(directory, maxTokens, estimateTokens) {
  const all = [];
  let dropped = 0;
  for (const { name } of await listImports(directory)) {
    const { examples } = readExamples(await fs.readFile(path.join(directory, name), 'utf8'));
    examples.forEach((example, index) => {
      const size = example.messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);
      if (size > maxTokens) { dropped += 1; return; }
      all.push({ id: `${name}:${index + 1}`, file: name, messages: example.messages });
    });
  }
  return { examples: all, dropped };
}

module.exports = { readExample, readExamples, listImports, addImport, importPath, importedExamples, MAX_FILE_BYTES };
