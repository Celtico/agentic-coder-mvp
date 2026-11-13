const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');

function isWithin(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

async function ensureProjectDirectory(projectRoot, targetDirectory) {
  const root = await fs.realpath(projectRoot);
  const relative = path.relative(path.resolve(projectRoot), path.resolve(targetDirectory));
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('La carpeta de destinació surt del projecte.');
  }

  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('El camí de destinació conté un enllaç o no és una carpeta.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await fs.mkdir(current); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('El camí de destinació conté un enllaç o no és una carpeta.');
    }
    const resolved = await fs.realpath(current);
    if (!isWithin(root, resolved)) throw new Error('La carpeta de destinació surt del projecte.');
  }
  return fs.realpath(current);
}

async function inspectFileForDeletion(projectRoot, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || relativePath.length > 500 || path.isAbsolute(relativePath)) {
    throw new Error('Ruta de fitxer no vàlida.');
  }
  const parts = relativePath.split(/[\\/]/);
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error('No es poden eliminar carpetes ni fitxers ocults.');
  }
  const root = await fs.realpath(projectRoot);
  const target = path.resolve(root, relativePath);
  if (!isWithin(root, target)) throw new Error('La ruta surt del projecte.');
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Només es poden eliminar fitxers normals, no enllaços ni carpetes.');
  if (stat.size > 5_000_000) throw new Error('El fitxer supera el límit de 5 MB per a una còpia de recuperació.');
  const resolved = await fs.realpath(target);
  if (!isWithin(root, resolved)) throw new Error('La ruta resolta surt del projecte.');
  const contents = await fs.readFile(resolved);
  return {
    root,
    target: resolved,
    relativePath,
    size: stat.size,
    mode: stat.mode & 0o777,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}

async function deleteInspectedProjectFile(snapshot, backupPath, metadataPath) {
  const { root, target, relativePath, size, mode, sha256 } = snapshot;
  const backupRoot = path.resolve(path.dirname(backupPath));
  const resolvedBackupRoot = await fs.realpath(backupRoot).catch(async (error) => {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
    return fs.realpath(backupRoot);
  });
  const resolvedBackupPath = path.join(resolvedBackupRoot, path.basename(backupPath));
  if (isWithin(root, resolvedBackupPath)) throw new Error('La còpia de recuperació ha d’estar fora del projecte.');

  const current = await inspectFileForDeletion(root, relativePath);
  if (current.target !== target || current.sha256 !== sha256) throw new Error('El fitxer ha canviat durant la comprovació; no s’ha eliminat.');
  await fs.mkdir(path.dirname(resolvedBackupPath), { recursive: true, mode: 0o700 });
  await fs.copyFile(target, resolvedBackupPath, fs.constants.COPYFILE_EXCL);
  await fs.chmod(resolvedBackupPath, 0o600);
  const backupHash = createHash('sha256').update(await fs.readFile(resolvedBackupPath)).digest('hex');
  if (backupHash !== sha256) throw new Error(`La còpia no s’ha pogut verificar; el fitxer original continua al seu lloc. Còpia: ${resolvedBackupPath}`);
  if (metadataPath) {
    const metadata = { version: 1, relativePath, sha256, mode, deletedAt: new Date().toISOString() };
    await fs.writeFile(metadataPath, JSON.stringify(metadata), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.chmod(metadataPath, 0o600);
  }
  try {
    const latest = await inspectFileForDeletion(root, relativePath);
    if (latest.sha256 !== sha256) throw new Error('El fitxer ha canviat durant l’eliminació.');
    await fs.unlink(target);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} Còpia recuperable: ${resolvedBackupPath}`);
  }
  return { deleted: true, path: relativePath, bytes: size, backupPath: resolvedBackupPath };
}

async function listDeletedProjectFiles(backupRoot) {
  const root = path.resolve(backupRoot);
  let resolvedRoot;
  try { resolvedRoot = await fs.realpath(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const results = [];
  const walk = async (directory, relativeDirectory = '', depth = 0) => {
    if (depth > 12 || results.length >= 100) return;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const relative = path.join(relativeDirectory, entry.name);
      const absolute = path.join(resolvedRoot, relative);
      if (entry.isDirectory()) { await walk(absolute, relative, depth + 1); continue; }
      if (!entry.isFile() || !relativeDirectory) continue;
      const parts = relative.split(path.sep);
      if (parts.length < 2) continue;
      const metadataPath = path.join(resolvedRoot, parts[0], '.agentic-metadata.json');
      let metadata = null;
      try {
        const parsed = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
        if (parsed?.version === 1 && typeof parsed.relativePath === 'string' && typeof parsed.sha256 === 'string') metadata = parsed;
      } catch {}
      const relativePath = metadata?.relativePath || parts.slice(1).join(path.sep);
      if (metadata && relativePath !== parts.slice(1).join(path.sep)) continue;
      const stat = await fs.lstat(absolute).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 5_000_000) continue;
      const contents = await fs.readFile(absolute);
      const sha256 = createHash('sha256').update(contents).digest('hex');
      if (metadata && metadata.sha256 !== sha256) continue;
      results.push({ id: relative, path: relativePath, bytes: stat.size, deletedAt: metadata?.deletedAt || parts[0], mode: metadata?.mode ?? 0o644 });
      if (results.length >= 100) return;
    }
  };
  await walk(resolvedRoot);
  return results.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)).slice(0, 100);
}

async function restoreDeletedProjectFile(projectRoot, backupRoot, backupId) {
  if (typeof backupId !== 'string' || !backupId || backupId.length > 1000 || path.isAbsolute(backupId)) throw new Error('Identificador de còpia no vàlid.');
  const idParts = backupId.split(/[\\/]/);
  if (idParts.length < 2 || idParts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) throw new Error('Identificador de còpia no vàlid.');
  const root = await fs.realpath(projectRoot);
  const backups = await listDeletedProjectFiles(backupRoot);
  const record = backups.find((item) => item.id === backupId);
  if (!record) throw new Error('La còpia no existeix o no ha superat la verificació.');
  const restoredParts = record.path.split(/[\\/]/);
  if (restoredParts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) throw new Error('La ruta guardada per a la restauració no és vàlida.');
  const backupDirectory = await fs.realpath(backupRoot);
  const backupPath = path.resolve(backupDirectory, backupId);
  if (!isWithin(backupDirectory, backupPath)) throw new Error('La còpia surt del directori autoritzat.');
  const target = path.resolve(root, record.path);
  if (!isWithin(root, target)) throw new Error('El destí surt del projecte.');
  const parts = record.path.split(path.sep);
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    try {
      const stat = await fs.lstat(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('El camí de restauració conté un enllaç o no és una carpeta.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.mkdir(parent);
    }
  }
  const resolvedParent = await fs.realpath(parent);
  if (!isWithin(root, resolvedParent)) throw new Error('La carpeta de destinació surt del projecte.');
  try { await fs.lstat(target); throw new Error('Ja existeix un fitxer o enllaç al destí; no s’ha substituït.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = path.join(resolvedParent, `.${path.basename(target)}.restore-${process.pid}-${Date.now()}.tmp`);
  await fs.copyFile(backupPath, temp, fs.constants.COPYFILE_EXCL);
  await fs.chmod(temp, record.mode & 0o777);
  const hash = createHash('sha256').update(await fs.readFile(temp)).digest('hex');
  if (hash !== createHash('sha256').update(await fs.readFile(backupPath)).digest('hex')) {
    await fs.unlink(temp).catch(() => {});
    throw new Error('La còpia ha canviat durant la restauració; no s’ha creat el fitxer.');
  }
  try { await fs.link(temp, target); }
  catch (error) {
    await fs.unlink(temp).catch(() => {});
    if (error.code === 'EEXIST') throw new Error('Ja existeix un fitxer al destí; no s’ha substituït.');
    throw error;
  }
  await fs.unlink(temp);
  return { restored: true, path: record.path, backupPath };
}

/**
 * Whether a file of the project is there and readable as a file, without throwing: for things that
 * may point to a file deleted since (what the editor had open when the app was closed).
 */
async function projectFileExists(projectRoot, relativePath) {
  try {
    if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) return false;
    const root = await fs.realpath(projectRoot);
    const target = path.resolve(root, relativePath);
    if (!isWithin(root, target)) return false;
    const resolved = await fs.realpath(target);
    return isWithin(root, resolved) && (await fs.stat(resolved)).isFile();
  } catch { return false; }
}

module.exports = { projectFileExists, inspectFileForDeletion, deleteInspectedProjectFile, listDeletedProjectFiles, restoreDeletedProjectFile, ensureProjectDirectory };
