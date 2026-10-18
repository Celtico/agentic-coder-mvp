const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MAX_SESSIONS = 50;
const MAX_MESSAGES = 100;
const MAX_TEXT = 100000;

function cleanSession(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 200) return null;
  if (!Array.isArray(value.messages)) return null;
  if (value.messages.some((message) => message && typeof message.text === 'string' && message.text.length > MAX_TEXT)) return null;
  const messages = value.messages.slice(-MAX_MESSAGES).flatMap((message) => {
    if (!message || (message.role !== 'user' && message.role !== 'assistant') || typeof message.text !== 'string') return [];
    if (message.text.length > MAX_TEXT) return [];
    return [{ role: message.role, text: message.text, ...(message.error === true ? { error: true } : {}) }];
  });
  return {
    id: value.id,
    title: typeof value.title === 'string' ? value.title.slice(0, 200) : 'Conversa nova',
    updatedAt: typeof value.updatedAt === 'string' && !Number.isNaN(Date.parse(value.updatedAt)) ? value.updatedAt : new Date().toISOString(),
    ...(typeof value.projectPath === 'string' && value.projectPath.length <= 4096 ? { projectPath: value.projectPath } : {}),
    messages,
  };
}

class ChatStore {
  constructor(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      project_path TEXT,
      messages_json TEXT NOT NULL
    )`);
    if (!this.db.prepare('PRAGMA table_info(chat_sessions)').all().some((column) => column.name === 'project_path')) {
      this.db.exec('ALTER TABLE chat_sessions ADD COLUMN project_path TEXT');
    }
    this.listStatement = this.db.prepare('SELECT id, title, updated_at, project_path, messages_json FROM chat_sessions ORDER BY updated_at DESC');
    this.getStatement = this.db.prepare('SELECT id, title, updated_at, project_path, messages_json FROM chat_sessions WHERE id = ?');
    this.upsertStatement = this.db.prepare(`INSERT INTO chat_sessions (id, title, updated_at, project_path, messages_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at, project_path=excluded.project_path, messages_json=excluded.messages_json`);
    this.deleteStatement = this.db.prepare('DELETE FROM chat_sessions WHERE id = ?');
    try { fs.chmodSync(filePath, 0o600); } catch {}
  }

  list() {
    return this.listStatement.all().flatMap((row) => {
      try {
        const session = cleanSession({ id: row.id, title: row.title, updatedAt: row.updated_at, projectPath: row.project_path, messages: JSON.parse(row.messages_json) });
        return session ? [session] : [];
      } catch { return []; }
    }).slice(0, MAX_SESSIONS);
  }

  get(id) {
    const row = this.getStatement.get(id);
    if (!row) return null;
    try { return cleanSession({ id: row.id, title: row.title, updatedAt: row.updated_at, projectPath: row.project_path, messages: JSON.parse(row.messages_json) }); }
    catch { return null; }
  }

  saveMany(values) {
    if (!Array.isArray(values)) throw new TypeError('L’historial de converses no és vàlid.');
    const sessions = values.slice(0, MAX_SESSIONS).map(cleanSession).filter(Boolean);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const ids = new Set(sessions.map((session) => session.id));
      for (const session of sessions) this.upsertStatement.run(session.id, session.title, session.updatedAt, session.projectPath || null, JSON.stringify(session.messages));
      for (const row of this.listStatement.all()) if (!ids.has(row.id)) this.deleteStatement.run(row.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return sessions.length;
  }

  close() { this.db.close(); }
}

module.exports = { ChatStore, cleanSession };
