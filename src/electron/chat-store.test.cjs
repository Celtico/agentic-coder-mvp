const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatStore } = require('./chat-store.cjs');

test('SQLite chat store writes and restores conversations across reopen', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-chat-store-'));
  const file = path.join(directory, 'memory', 'conversations.sqlite');
  const original = [{ id: 'one', title: 'Hola', updatedAt: '2026-10-18T12:00:00.000Z', messages: [
    { role: 'user', text: 'Hola' }, { role: 'assistant', text: 'Bon dia' },
  ] }];
  try {
    const first = new ChatStore(file);
    first.saveMany(original);
    first.close();
    const reopened = new ChatStore(file);
    assert.deepEqual(reopened.list(), original);
    reopened.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('SQLite chat store bounds and validates imported session data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-chat-store-'));
  const file = path.join(directory, 'conversations.sqlite');
  try {
    const store = new ChatStore(file);
    store.saveMany([
      { id: 'ok', title: 'Títol', updatedAt: 'not a date', messages: [null, { role: 'system', text: 'ignored' }, { role: 'user', text: 'Hola', error: true }] },
      { title: 'invalid', messages: [] },
    ]);
    assert.deepEqual(store.list().map((session) => session.messages), [[{ role: 'user', text: 'Hola', error: true }]]);
    store.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
