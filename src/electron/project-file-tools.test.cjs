const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { inspectFileForDeletion, deleteInspectedProjectFile, listDeletedProjectFiles, restoreDeletedProjectFile, ensureProjectDirectory } = require('./project-file-tools.cjs');

test('creates missing project folders and rejects symlink folders', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-project-directory-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  const outsideRoot = path.join(tempRoot, 'outside');
  await fs.mkdir(projectRoot);
  await fs.mkdir(outsideRoot);
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const nested = await ensureProjectDirectory(projectRoot, path.join(projectRoot, 'src', 'components'));
  assert.equal(nested, await fs.realpath(path.join(projectRoot, 'src', 'components')));
  await fs.symlink(outsideRoot, path.join(projectRoot, 'linked'));
  await assert.rejects(ensureProjectDirectory(projectRoot, path.join(projectRoot, 'linked', 'nested')), /enllaç/);
  await assert.rejects(ensureProjectDirectory(projectRoot, path.join(tempRoot, 'outside', 'nested')), /surt del projecte/);
});

test('deletion saves a verified private backup before removing a project file', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-delete-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  const filePath = path.join(projectRoot, 'src', 'unused.ts');
  const deletedRoot = path.join(tempRoot, 'backups', 'deleted');
  const backupPath = path.join(deletedRoot, 'stamp', 'src', 'unused.ts');
  const metadataPath = path.join(deletedRoot, 'stamp', '.agentic-metadata.json');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const original = 'export const unused = true;\n';
  await fs.writeFile(filePath, original, { mode: 0o644 });
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const snapshot = await inspectFileForDeletion(projectRoot, 'src/unused.ts');
  const result = await deleteInspectedProjectFile(snapshot, backupPath, metadataPath);

  assert.equal(result.deleted, true);
  assert.equal(result.bytes, Buffer.byteLength(original));
  assert.equal(await fs.readFile(filePath).catch(() => null), null);
  assert.equal(await fs.readFile(backupPath, 'utf8'), original);
  assert.equal((await fs.stat(backupPath)).mode & 0o777, 0o600);

  const backups = await listDeletedProjectFiles(deletedRoot);
  assert.deepEqual(backups.map(({ path: relativePath, bytes }) => ({ path: relativePath, bytes })), [{ path: 'src/unused.ts', bytes: Buffer.byteLength(original) }]);
  const restored = await restoreDeletedProjectFile(projectRoot, deletedRoot, backups[0].id);
  assert.equal(restored.restored, true);
  assert.equal(await fs.readFile(filePath, 'utf8'), original);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o644);
});

test('restoration never overwrites an existing file', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-restore-collision-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  const deletedRoot = path.join(tempRoot, 'backups', 'deleted');
  const backupPath = path.join(deletedRoot, 'stamp', 'file.txt');
  await fs.mkdir(projectRoot);
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.writeFile(backupPath, 'saved version');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const metadataPath = path.join(deletedRoot, 'stamp', '.agentic-metadata.json');
  await fs.writeFile(metadataPath, JSON.stringify({ version: 1, relativePath: 'file.txt', sha256: require('node:crypto').createHash('sha256').update('saved version').digest('hex'), mode: 0o644, deletedAt: '2026-10-18T00:00:00.000Z' }));
  await fs.writeFile(path.join(projectRoot, 'file.txt'), 'current version');
  await assert.rejects(restoreDeletedProjectFile(projectRoot, deletedRoot, 'stamp/file.txt'), /Ja existeix/);
  assert.equal(await fs.readFile(path.join(projectRoot, 'file.txt'), 'utf8'), 'current version');
});

test('deletion is cancelled if the file changes after inspection', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-delete-race-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  const filePath = path.join(projectRoot, 'file.txt');
  const backupPath = path.join(tempRoot, 'backups', 'file.txt');
  await fs.mkdir(projectRoot);
  await fs.writeFile(filePath, 'before');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const snapshot = await inspectFileForDeletion(projectRoot, 'file.txt');
  await fs.writeFile(filePath, 'changed after approval');

  await assert.rejects(deleteInspectedProjectFile(snapshot, backupPath), /ha canviat/);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'changed after approval');
  await assert.rejects(fs.access(backupPath), { code: 'ENOENT' });
});

test('deletion refuses hidden paths, traversal, folders and symlinks', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-delete-path-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(projectRoot);
  await fs.mkdir(path.join(projectRoot, 'folder'));
  await fs.writeFile(path.join(projectRoot, '.env'), 'secret');
  await fs.writeFile(path.join(tempRoot, 'outside.txt'), 'outside');
  await fs.symlink(path.join(tempRoot, 'outside.txt'), path.join(projectRoot, 'link.txt'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  await assert.rejects(inspectFileForDeletion(projectRoot, '../outside.txt'), /No es poden/);
  await assert.rejects(inspectFileForDeletion(projectRoot, '.env'), /No es poden/);
  await assert.rejects(inspectFileForDeletion(projectRoot, 'folder'), /fitxers normals/);
  await assert.rejects(inspectFileForDeletion(projectRoot, 'link.txt'), /enllaços/);
});

test('projectFileExists says whether a file is there, without throwing, and never outside the project', async (t) => {
  const { projectFileExists } = require('./project-file-tools.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-exists-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'App.tsx'), 'x');
  assert.equal(await projectFileExists(root, 'src/App.tsx'), true);
  assert.equal(await projectFileExists(root, 'vite.config.ts'), false, 'a file deleted since');
  assert.equal(await projectFileExists(root, 'src'), false, 'a folder is not a file');
  assert.equal(await projectFileExists(root, '../outside.txt'), false);
  assert.equal(await projectFileExists(root, '/etc/hosts'), false);
  assert.equal(await projectFileExists(root, ''), false);
});

test('the app checks that a remembered file is there before opening it, and forgets it if not', () => {
  const app = require('node:fs').readFileSync(path.join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
  // Every saved tab is checked; one whose file is gone is left out, and the next save forgets it.
  assert.match(app, /for \(const tab of savedList\) if \(await window\.agentic\.fileExists\(tab\)/);
  assert.match(app, /setEditorTabs\(existing\)/);
  assert.match(app, /if \(!\(await window\.agentic\.fileExists\(filePath\)\)\) return;/);
  const main = require('node:fs').readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  assert.match(main, /ipcMain\.handle\('project:exists'/);
});
