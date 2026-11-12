const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');

function isWithin(root, target) { return target === root || target.startsWith(root + path.sep); }

function validateRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || path.isAbsolute(value)) throw new Error('La ruta de l’historial no és vàlida.');
  const parts = value.split(/[\\/]/);
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('La ruta de l’historial no és vàlida.');
  return parts;
}

async function inspectSnapshot(groupRoot, relativePath) {
  const parts = validateRelativePath(relativePath);
  const resolvedRoot = await fs.realpath(groupRoot);
  let current = resolvedRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    if (!isWithin(resolvedRoot, current)) return null;
    const stat = await fs.lstat(current).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat || stat.isSymbolicLink()) return null;
    if (index < parts.length - 1 && !stat.isDirectory()) return null;
    if (index === parts.length - 1 && (!stat.isFile() || stat.size > 5_000_000)) return null;
  }
  const stat = await fs.stat(current);
  const bytes = await fs.readFile(current);
  return { path: current, bytes, size: stat.size, mode: stat.mode & 0o777, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function timestampFromStamp(stamp) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(stamp);
  if (!match) return stamp;
  return new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`).toISOString();
}

async function listProjectFileHistory(backupRoot, relativePath) {
  validateRelativePath(relativePath);
  const root = await fs.realpath(backupRoot).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!root) return [];
  const results = [];
  const topEntries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of topEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    if (entry.name === 'deleted') {
      const deletedRoot = path.join(root, entry.name);
      const deletedEntries = await fs.readdir(deletedRoot, { withFileTypes: true }).catch(() => []);
      for (const stamp of deletedEntries) {
        if (!stamp.isDirectory() || stamp.isSymbolicLink() || stamp.name.startsWith('.')) continue;
        const groupRoot = path.join(deletedRoot, stamp.name);
        const snapshot = await inspectSnapshot(groupRoot, relativePath).catch(() => null);
        if (!snapshot) continue;
        let metadata = null;
        try { metadata = JSON.parse(await fs.readFile(path.join(groupRoot, '.agentic-metadata.json'), 'utf8')); } catch {}
        if (metadata?.relativePath && metadata.relativePath !== relativePath) continue;
        if (metadata?.sha256 && metadata.sha256 !== snapshot.sha256) continue;
        results.push({ id: `deleted/${stamp.name}`, path: relativePath, bytes: snapshot.size, savedAt: metadata?.deletedAt || timestampFromStamp(stamp.name), label: 'Fitxer eliminat', sha256: snapshot.sha256 });
      }
      continue;
    }
    const snapshot = await inspectSnapshot(path.join(root, entry.name), relativePath).catch(() => null);
    if (snapshot) results.push({ id: entry.name, path: relativePath, bytes: snapshot.size, savedAt: timestampFromStamp(entry.name), label: 'Versió anterior', sha256: snapshot.sha256 });
  }
  return results.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt))).slice(0, 100);
}

async function listProjectFolderHistory(backupRoot, relativeDirectory = '') {
  if (relativeDirectory) validateRelativePath(relativeDirectory);
  const root = await fs.realpath(backupRoot).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!root) return [];
  const prefix = relativeDirectory ? `${relativeDirectory.replace(/\\/g, '/')}/` : '';
  const results = [];
  const walk = async (groupRoot, directory = groupRoot, relative = '', depth = 0) => {
    if (depth > 20 || results.length >= 1000) return;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name === '.agentic-metadata.json') continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(groupRoot, absolute, child, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const normalized = child.replace(/\\/g, '/');
      if (!normalized.startsWith(prefix)) continue;
      const snapshot = await inspectSnapshot(groupRoot, child).catch(() => null);
      if (!snapshot) continue;
      const stamp = path.basename(groupRoot);
      const deleted = path.basename(path.dirname(groupRoot)) === 'deleted';
      let metadata = null;
      if (deleted) {
        try { metadata = JSON.parse(await fs.readFile(path.join(groupRoot, '.agentic-metadata.json'), 'utf8')); } catch {}
        if (metadata?.version !== 1 || metadata.relativePath !== normalized || metadata.sha256 !== snapshot.sha256) continue;
      }
      const filePath = metadata?.relativePath || normalized;
      if (relativeDirectory && !filePath.startsWith(prefix)) continue;
      results.push({ id: `${deleted ? 'deleted/' : ''}${stamp}`, path: filePath, bytes: snapshot.size, savedAt: metadata?.deletedAt || timestampFromStamp(stamp), label: metadata ? 'Fitxer eliminat' : 'Versió anterior', sha256: snapshot.sha256 });
    }
  };
  const groups = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of groups) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    if (entry.name === 'deleted') {
      const deletedGroups = await fs.readdir(path.join(root, entry.name), { withFileTypes: true }).catch(() => []);
      for (const group of deletedGroups) if (group.isDirectory() && !group.isSymbolicLink()) await walk(path.join(root, entry.name, group.name));
    } else await walk(path.join(root, entry.name));
  }
  return results.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt))).slice(0, 1000);
}

async function readProjectFileHistoryVersion(backupRoot, relativePath, id) {
  validateRelativePath(relativePath);
  if (typeof id !== 'string' || id.length > 300) throw new Error('Identificador d’historial no vàlid.');
  const idParts = id.split('/');
  if (idParts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.')) || (idParts.length > 1 && (idParts.length !== 2 || idParts[0] !== 'deleted'))) throw new Error('Identificador d’historial no vàlid.');
  const record = (await listProjectFileHistory(backupRoot, relativePath)).find((item) => item.id === id);
  if (!record) throw new Error('Aquesta versió ja no existeix o no és vàlida.');
  const root = await fs.realpath(backupRoot);
  const groupRoot = path.join(root, ...idParts);
  const snapshot = await inspectSnapshot(groupRoot, relativePath);
  if (!snapshot || snapshot.sha256 !== record.sha256) throw new Error('La versió de l’historial no ha superat la verificació.');
  return { ...record, content: snapshot.bytes.toString('utf8'), mode: snapshot.mode };
}

module.exports = { listProjectFileHistory, listProjectFolderHistory, readProjectFileHistoryVersion };
