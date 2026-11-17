// Aprenentatge local › Dades JSON (learning-imports.cjs): .jsonl conversations loaded for training.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const imports = require('./learning-imports.cjs');
const { estimateTokens } = require('./learning-versions.cjs');

const line = (messages) => JSON.stringify({ messages });
const good = line([{ role: 'user', content: 'Com faig un botó amb Chakra v3?' }, { role: 'assistant', content: '<Button colorPalette="teal">Desa</Button>' }]);

test('a line counts only as a whole conversation that ends with the assistant', () => {
  assert.ok(imports.readExample(good));
  assert.equal(imports.readExample('no és json'), null);
  assert.equal(imports.readExample(line([{ role: 'user', content: 'hola' }])), null, 'no answer');
  assert.equal(imports.readExample(line([{ role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }])), null, 'ends with the user');
  assert.equal(imports.readExample(line([{ role: 'user', content: 'a' }, { role: 'robot', content: 'b' }])), null, 'unknown role');
  // A case as «Crea un cas» writes it: its prompt and its answer.
  assert.deepEqual(imports.readExample(JSON.stringify({ task: 'Botó', prompt: 'Fes un botó', answer: '<Button/>', evidence: 'docs' })), { messages: [{ role: 'user', content: 'Fes un botó' }, { role: 'assistant', content: '<Button/>' }] });
  assert.equal(imports.readExample(JSON.stringify({ task: 'Botó', prompt: 'Fes un botó', answer: '' })), null, 'an empty answer');
  assert.deepEqual(imports.readExamples(`${good}\n\nbrossa\n${good}\n`), { examples: [imports.readExample(good), imports.readExample(good)], skipped: 1 });
});

test('a file is checked and copied (never overwriting another), listed, and its examples go to training', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-imports-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'chakra v3.jsonl');
  fs.writeFileSync(source, `${good}\nbrossa\n${line([{ role: 'user', content: 'x'.repeat(10000) }, { role: 'assistant', content: 'llarg' }])}\n`);
  const folder = path.join(dir, 'imports');
  assert.equal(await imports.addImport(folder, source), 'chakra-v3.jsonl');
  assert.equal(await imports.addImport(folder, source), 'chakra-v3-2.jsonl');
  const listed = await imports.listImports(folder);
  assert.deepEqual(listed.map(({ name, examples, skipped }) => ({ name, examples, skipped })), [{ name: 'chakra-v3-2.jsonl', examples: 2, skipped: 1 }, { name: 'chakra-v3.jsonl', examples: 2, skipped: 1 }]);
  // The long one does not fit 2048 tokens: left out, and counted.
  const training = await imports.importedExamples(folder, 2048, estimateTokens);
  assert.equal(training.examples.length, 2);
  assert.equal(training.dropped, 2);
  assert.equal(training.examples[0].messages[1].content, '<Button colorPalette="teal">Desa</Button>');
  // Only a file of the folder can be removed.
  assert.equal(await imports.importPath(folder, 'chakra-v3.jsonl'), path.join(folder, 'chakra-v3.jsonl'));
  await assert.rejects(imports.importPath(folder, '../chakra v3.jsonl'));
  // Not a .jsonl, or nothing valid in it: refused.
  const empty = path.join(dir, 'buit.jsonl');
  fs.writeFileSync(empty, 'brossa\n');
  await assert.rejects(imports.addImport(folder, empty), /cap conversa vàlida/);
  await assert.rejects(imports.addImport(folder, path.join(dir, 'x.txt')), /\.jsonl/);
});
