const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ChatStore } = require('./chat-store.cjs');

test('SQLite chat store writes and restores conversations across reopen', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-chat-store-'));
  const file = path.join(directory, 'memory', 'conversations.sqlite');
  const original = [{ id: 'one', title: 'Hola', updatedAt: '2026-10-18T12:00:00.000Z', projectPath: '/tmp/my-project', messages: [
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

test('saving never deletes a conversation it is not given; deleting is asked for one by one', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-chat-store-delete-'));
  const file = path.join(directory, 'conversations.sqlite');
  try {
    const store = new ChatStore(file);
    const today = { id: 'today', title: 'Avui', updatedAt: '2026-11-14T19:24:03.269Z', projectPath: '/Users/x/AGENT', messages: [{ role: 'user', text: 'executa npm i' }] };
    const older = { id: 'older', title: 'Abans', updatedAt: '2026-11-12T17:11:22.699Z', projectPath: '/Users/x/AGENT', messages: [{ role: 'user', text: 'Hola' }] };
    store.saveMany([today, older]);
    // A window with an incomplete list (only a new, empty chat) saves: the others stay.
    store.saveMany([{ id: 'new', title: 'Conversa nova', updatedAt: '2026-11-14T19:29:21.461Z', projectPath: '/Users/x/AGENT', messages: [] }]);
    store.saveMany([]);
    assert.deepEqual(store.list().map((session) => session.id), ['new', 'today', 'older']);
    assert.equal(store.delete('older'), true);
    assert.equal(store.delete('older'), false);
    assert.equal(store.get('older'), null);
    assert.deepEqual(store.list().map((session) => session.id), ['new', 'today']);
    assert.throws(() => store.delete(''), /no és vàlida/);
    store.close();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('SQLite chat store adds project association to an existing database', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-chat-store-migration-'));
  const file = path.join(directory, 'conversations.sqlite');
  try {
    const oldDb = new DatabaseSync(file);
    oldDb.exec(`CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at TEXT NOT NULL, messages_json TEXT NOT NULL
    )`);
    oldDb.close();
    const store = new ChatStore(file);
    store.saveMany([{ id: 'old', title: 'Old', updatedAt: '2026-10-18T12:00:00.000Z', projectPath: '/tmp/project', messages: [] }]);
    assert.equal(store.get('old').projectPath, '/tmp/project');
    store.close();
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
