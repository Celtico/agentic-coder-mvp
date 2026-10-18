const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, 'history-recovery.ts'), 'utf8');
const compiled = esbuild.transformSync(source, { loader: 'ts', format: 'cjs', target: 'node20' }).code;
const loaded = { exports: {} };
new Function('module', 'exports', compiled)(loaded, loaded.exports);
const { recoverCompletedHistory } = loaded.exports;

test('recovers completed exchanges without replacing or duplicating saved chats', () => {
  const existing = [{
    id: 'existing', title: 'Conversa meva', updatedAt: '2026-10-18T10:00:00.000Z',
    messages: [{ role: 'user', text: 'tasca guardada' }, { role: 'assistant', text: 'resposta guardada' }],
  }];
  const entries = [
    { prompt: 'tasca guardada', answer: 'resposta guardada', at: '2026-10-18T10:00:00.000Z' },
    { prompt: 'tasca recuperable', answer: 'resultat complet', at: '2026-10-18T11:00:00.000Z' },
    { prompt: 'tasca recuperable', answer: 'resultat complet', at: '2026-10-18T11:00:00.000Z' },
  ];

  const recovered = recoverCompletedHistory(existing, entries);
  assert.equal(recovered.length, 2);
  assert.deepEqual(recovered[1], existing[0]);
  assert.equal(recovered[0].title, 'Historial recuperat');
  assert.deepEqual(recovered[0].messages, [
    { role: 'user', text: 'tasca recuperable' },
    { role: 'assistant', text: 'resultat complet' },
  ]);
  assert.equal(recoverCompletedHistory(recovered, entries), recovered, 'second restore should be a no-op');
});

test('ignores invalid entries and limits a recovered session to the latest 100 messages', () => {
  const entries = [
    null,
    { prompt: '', answer: 'resposta' },
    { prompt: 'petició', answer: 'x'.repeat(30001) },
    ...Array.from({ length: 55 }, (_, index) => ({ prompt: `petició ${index}`, answer: `resposta ${index}` })),
  ];

  const [recovered] = recoverCompletedHistory([], entries);
  assert.equal(recovered.messages.length, 100);
  assert.equal(recovered.messages[0].text, 'petició 5');
  assert.equal(recovered.messages[99].text, 'resposta 54');
});
