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

test('a deleted conversation goes to the trash: listed, restorable, and gone only when the trash is emptied', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-chat-store-trash-'));
  const file = path.join(directory, 'conversations.sqlite');
  try {
    const store = new ChatStore(file);
    const vite = { id: 'vite', title: 'fer un start amb vite amb react', updatedAt: '2026-11-14T22:50:00.000Z', projectPath: '/Users/x/AGENT', messages: [{ role: 'user', text: 'fer un start amb vite' }, { role: 'assistant', text: 'Fet.' }] };
    store.saveMany([vite, { id: 'other', title: 'Altra', updatedAt: '2026-11-14T22:00:00.000Z', messages: [{ role: 'user', text: 'hola' }] }]);
    assert.equal(store.delete('vite', new Date('2026-11-14T23:04:58.000Z')), true);
    assert.deepEqual(store.list().map((session) => session.id), ['other']);
    const trash = store.listDeleted();
    assert.deepEqual(trash.map((session) => [session.id, session.deletedAt, session.messages.length]), [['vite', '2026-11-14T23:04:58.000Z', 2]]);
    // Saving the window's list (which no longer has it) does not bring it back nor lose it.
    store.saveMany([{ id: 'other', title: 'Altra', updatedAt: '2026-11-14T23:10:00.000Z', messages: [{ role: 'user', text: 'hola' }] }]);
    assert.equal(store.listDeleted().length, 1);
    assert.deepEqual(store.restore('vite'), { id: 'vite', title: vite.title, updatedAt: vite.updatedAt, projectPath: vite.projectPath, messages: vite.messages });
    assert.deepEqual(store.listDeleted(), []);
    assert.deepEqual(store.list().map((session) => session.id).sort(), ['other', 'vite']);
    assert.equal(store.restore('vite'), null, 'not in the trash any more');
    store.delete('vite'); store.delete('other');
    assert.equal(store.emptyTrash(), 2);
    assert.deepEqual([store.list(), store.listDeleted()], [[], []]);
    assert.throws(() => store.restore(''), /no és vàlida/);
    store.close();
    // The trash survives reopening the database.
    const again = new ChatStore(file);
    again.saveMany([vite]); again.delete('vite');
    again.close();
    assert.equal(new ChatStore(file).listDeleted().length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the conversations column asks before deleting, and its delete icon is always visible', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
  assert.match(app, /<IconButton icon=\{Trash\} label="Elimina la conversa" position="absolute"[^>]*onClick=\{\(event\) => \{ event\.stopPropagation\(\); setChatToDelete\(session\); \}\}\/>/);
  assert.doesNotMatch(app, /label="Elimina la conversa"[^>]*opacity="0"/);
  assert.match(app, /<DialogHeading icon=\{Trash\} title="Elimina la conversa\?"\/>/);
  assert.match(app, /<DialogHeading icon=\{Trash\} title="Paperera de converses"/);
  assert.match(app, /onClick=\{\(\) => void restoreChatSession\(session\.id\)\}><History size=\{14\}\/>Recupera/);
  assert.match(app, /emptyTrashArmed \? 'Torna a clicar per buidar-la del tot' : 'Buida la paperera'/);
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  for (const channel of ['chat-store:deleted', 'chat-store:restore', 'chat-store:empty-trash']) assert.match(main, new RegExp(`ipcMain\\.handle\\('${channel}'`));
});
