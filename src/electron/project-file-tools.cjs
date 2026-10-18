const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');

function isWithin(root, target) {
  return target === root || target.startsWith(root + path.sep);
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

async function deleteInspectedProjectFile(snapshot, backupPath) {
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
  if (current.target !== target || current.sha256 !== sha256) throw new Error('El fitxer ha canviat des de la confirmació; no s’ha eliminat.');
  await fs.mkdir(path.dirname(resolvedBackupPath), { recursive: true, mode: 0o700 });
  await fs.copyFile(target, resolvedBackupPath, fs.constants.COPYFILE_EXCL);
  await fs.chmod(resolvedBackupPath, 0o600);
  const backupHash = createHash('sha256').update(await fs.readFile(resolvedBackupPath)).digest('hex');
  if (backupHash !== sha256) throw new Error(`La còpia no s’ha pogut verificar; el fitxer original continua al seu lloc. Còpia: ${resolvedBackupPath}`);
  try {
    const latest = await inspectFileForDeletion(root, relativePath);
    if (latest.sha256 !== sha256) throw new Error('El fitxer ha canviat durant l’eliminació.');
    await fs.unlink(target);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} Còpia recuperable: ${resolvedBackupPath}`);
  }
  return { deleted: true, path: relativePath, bytes: size, backupPath: resolvedBackupPath };
}

module.exports = { inspectFileForDeletion, deleteInspectedProjectFile };
