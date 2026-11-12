const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { listProjectFileHistory, listProjectFolderHistory, readProjectFileHistoryVersion } = require('./project-history.cjs');

async function makeBackupRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('lists prior saved file versions newest-first and reads them for comparison', async (t) => {
  const root = await makeBackupRoot(t);
  const older = '2026-10-18T20-00-00-000Z-1';
  const newer = '2026-10-19T09-30-00-000Z-2';
  await fs.mkdir(path.join(root, older, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, newer, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, older, 'src', 'App.jsx'), 'const old = true;');
  await fs.writeFile(path.join(root, newer, 'src', 'App.jsx'), 'const newer = true;');

  const versions = await listProjectFileHistory(root, 'src/App.jsx');
  assert.deepEqual(versions.map((version) => version.id), [newer, older]);
  assert.equal(versions[0].label, 'Versió anterior');
  const content = await readProjectFileHistoryVersion(root, 'src/App.jsx', older);
  assert.equal(content.content, 'const old = true;');
});

test('includes deleted-file backups and verifies their metadata', async (t) => {
  const root = await makeBackupRoot(t);
  const stamp = '2026-10-19T10-00-00-000Z-3';
  const bytes = Buffer.from('deleted version');
  const group = path.join(root, 'deleted', stamp);
  await fs.mkdir(path.join(group, 'src'), { recursive: true });
  await fs.writeFile(path.join(group, 'src', 'App.jsx'), bytes);
  await fs.writeFile(path.join(group, '.agentic-metadata.json'), JSON.stringify({ version: 1, relativePath: 'src/App.jsx', sha256: createHash('sha256').update(bytes).digest('hex'), deletedAt: '2026-10-19T10:00:00.000Z' }));

  const versions = await listProjectFileHistory(root, 'src/App.jsx');
  assert.equal(versions.length, 1);
  assert.equal(versions[0].id, `deleted/${stamp}`);
  assert.equal(versions[0].label, 'Fitxer eliminat');
  assert.equal((await readProjectFileHistoryVersion(root, 'src/App.jsx', versions[0].id)).content, 'deleted version');
});

test('lists saved and deleted files inside a selected directory', async (t) => {
  const root = await makeBackupRoot(t);
  const savedStamp = '2026-10-19T10-10-00-000Z-5';
  const deletedStamp = '2026-10-19T10-20-00-000Z-6';
  await fs.mkdir(path.join(root, savedStamp, 'src', 'components'), { recursive: true });
  await fs.writeFile(path.join(root, savedStamp, 'src', 'components', 'Button.tsx'), 'export const oldButton = true;');
  const deletedGroup = path.join(root, 'deleted', deletedStamp);
  const deletedBytes = Buffer.from('deleted note');
  await fs.mkdir(path.join(deletedGroup, 'src', 'components'), { recursive: true });
  await fs.writeFile(path.join(deletedGroup, 'src', 'components', 'Note.tsx'), deletedBytes);
  await fs.writeFile(path.join(deletedGroup, '.agentic-metadata.json'), JSON.stringify({ version: 1, relativePath: 'src/components/Note.tsx', sha256: createHash('sha256').update(deletedBytes).digest('hex'), deletedAt: '2026-10-19T10:20:00.000Z' }));
  await fs.mkdir(path.join(root, '2026-10-19T10-30-00-000Z-7', 'src'), { recursive: true });
  await fs.writeFile(path.join(root, '2026-10-19T10-30-00-000Z-7', 'src', 'outside.ts'), 'outside selected folder');

  const versions = await listProjectFolderHistory(root, 'src/components');
  assert.equal(versions.length, 2);
  assert.deepEqual(new Set(versions.map((version) => version.path)), new Set(['src/components/Button.tsx', 'src/components/Note.tsx']));
  assert.ok(versions.some((version) => version.label === 'Fitxer eliminat' && version.id === `deleted/${deletedStamp}`));
  assert.ok(versions.every((version) => version.path.startsWith('src/components/')));
});

test('rejects unsafe paths, unknown versions, and tampered deleted copies', async (t) => {
  const root = await makeBackupRoot(t);
  await assert.rejects(listProjectFileHistory(root, '../outside'), /no és vàlida/);
  await assert.rejects(readProjectFileHistoryVersion(root, 'file.txt', 'missing'), /no existeix/);
  const stamp = '2026-10-19T10-00-00-000Z-4';
  const group = path.join(root, 'deleted', stamp);
  await fs.mkdir(group, { recursive: true });
  await fs.writeFile(path.join(group, 'file.txt'), 'tampered');
  await fs.writeFile(path.join(group, '.agentic-metadata.json'), JSON.stringify({ version: 1, relativePath: 'file.txt', sha256: 'wrong', deletedAt: '2026-10-19T10:00:00.000Z' }));
  assert.deepEqual(await listProjectFileHistory(root, 'file.txt'), []);
});
