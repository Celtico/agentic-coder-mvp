const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { inspectFileForDeletion, deleteInspectedProjectFile } = require('./project-file-tools.cjs');

test('deletion saves a verified private backup before removing a project file', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-delete-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  const filePath = path.join(projectRoot, 'src', 'unused.ts');
  const backupPath = path.join(tempRoot, 'backups', 'src', 'unused.ts');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const original = 'export const unused = true;\n';
  await fs.writeFile(filePath, original, { mode: 0o644 });
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const snapshot = await inspectFileForDeletion(projectRoot, 'src/unused.ts');
  const result = await deleteInspectedProjectFile(snapshot, backupPath);

  assert.equal(result.deleted, true);
  assert.equal(result.bytes, Buffer.byteLength(original));
  assert.equal(await fs.readFile(filePath).catch(() => null), null);
  assert.equal(await fs.readFile(backupPath, 'utf8'), original);
  assert.equal((await fs.stat(backupPath)).mode & 0o777, 0o600);
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
