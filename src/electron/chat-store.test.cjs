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

test('SQLite chat store removes conversations omitted from the saved snapshot', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-chat-store-delete-'));
  const file = path.join(directory, 'conversations.sqlite');
  try {
    const store = new ChatStore(file);
    store.saveMany([{ id: 'to-delete', title: 'Conversa', updatedAt: '2026-10-19T12:00:00.000Z', messages: [{ role: 'user', text: 'Hola' }] }]);
    store.saveMany([]);
    assert.deepEqual(store.list(), []);
    assert.equal(store.get('to-delete'), null);
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
