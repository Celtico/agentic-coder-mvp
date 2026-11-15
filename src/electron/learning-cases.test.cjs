const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { listCases, readCase, updateCase, deleteCase, validCaseId, withCasesLock } = require('./learning-cases.cjs');
const { parseVerifiedExperiences, prepareTrainingDataset } = require('./learning-dataset.cjs');

const idOf = (name) => createHash('sha256').update(name).digest('hex');

function record(name, overrides = {}) {
  return {
    id: idOf(name),
    at: '2026-11-14T10:00:00.000Z',
    projectPath: '/tmp/private-project',
    model: 'local-test-model',
    prompt: `Petició ${name}`,
    answer: `Resposta ${name}`,
    evidence: 'build superat',
    task: `Tasca ${name}`,
    verification: 'user-confirmed',
    ...overrides,
  };
}

const withSteps = (name, overrides = {}) => record(name, {
  trajectory: { turns: [
    { request: 'Crea el fitxer', steps: [{ name: 'write_file', arguments: { path: 'a.txt', content: 'x'.repeat(500) }, result: 'ok', ok: true }], answer: 'Fet' },
    { request: 'Prova-ho', steps: [{ name: 'run_tests', arguments: {}, result: 'passed', ok: true }, { name: 'read_file', arguments: { path: 'a.txt' }, result: 'x', ok: false }], answer: `Resposta ${name}` },
  ] },
  ...overrides,
});

async function setup(rows, extraLines = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'learning-cases-'));
  const filePath = path.join(directory, 'verified-experiences.jsonl');
  const deletedPath = path.join(directory, 'verified-experiences.deleted.jsonl');
  await fs.writeFile(filePath, [...rows.map((row) => JSON.stringify(row)), ...extraLines].join('\n') + '\n');
  return { directory, filePath, deletedPath };
}
const countsOf = async (filePath) => prepareTrainingDataset(parseVerifiedExperiences(await fs.readFile(filePath, 'utf8'))).counts;

test('the list shows each case newest first with its request, check, turns, steps and an empty marker', async () => {
  const { filePath } = await setup([record('old', { at: '2026-11-01T00:00:00.000Z' }), withSteps('new', { at: '2026-11-14T00:00:00.000Z' })], ['{not json', '{"id":"short"}']);
  const { cases, unreadable } = await listCases(filePath);
  assert.equal(unreadable, 2);
  assert.deepEqual(cases.map((item) => [item.task, item.turns, item.steps, item.withoutToolSteps]), [['Tasca new', 2, 3, false], ['Tasca old', 0, 0, true]]);
  assert.equal(cases[0].model, 'local-test-model');
  assert.equal(cases[0].evidence, 'build superat');
  assert.deepEqual(await listCases(path.join(path.dirname(filePath), 'missing.jsonl')), { cases: [], unreadable: 0 });
});

test('the detail has every request, the tool calls with short arguments, and the final answer', async () => {
  const { filePath } = await setup([withSteps('one'), record('plain')]);
  const detail = await readCase(filePath, idOf('one'));
  assert.equal(detail.requests.length, 2);
  assert.equal(detail.requests[0].steps[0].name, 'write_file');
  assert.ok(detail.requests[0].steps[0].arguments.content.length <= 161);
  assert.equal(detail.requests[1].steps[1].ok, false);
  assert.equal(detail.answer, 'Resposta one');
  const plain = await readCase(filePath, idOf('plain'));
  assert.deepEqual(plain.requests, [{ request: 'Petició plain', steps: [], answer: 'Resposta plain' }]);
});

test('ids that are not a case id are refused before the file is read', async () => {
  const { filePath, deletedPath } = await setup([record('one')]);
  for (const bad of ['', 'abc', '../etc/passwd', idOf('x').toUpperCase(), null, 42, `${idOf('x')}\n`]) {
    assert.throws(() => validCaseId(bad), /identificador/);
    await assert.rejects(readCase(filePath, bad), /identificador/);
    await assert.rejects(updateCase(filePath, bad, { task: 'a', evidence: 'b' }), /identificador/);
    await assert.rejects(deleteCase(filePath, deletedPath, bad), /identificador/);
  }
  await assert.rejects(deleteCase(filePath, deletedPath, idOf('missing')), /ja no és/);
  await assert.rejects(fs.access(deletedPath));
});

test('editing changes the request and the check, keeps the other lines as they were, and updates the counts', async () => {
  const { filePath } = await setup([record('one'), record('two', { evidence: ' ' })], ['{not json']);
  assert.deepEqual(await countsOf(filePath), { input: 3, unverified: 0, invalid: 2, secrets: 0, duplicates: 0, included: 1 });
  const updated = await updateCase(filePath, idOf('two'), { task: '  Nova tasca ', evidence: ' tests verds ' });
  assert.equal(updated.task, 'Nova tasca');
  assert.equal(updated.evidence, 'tests verds');
  const lines = (await fs.readFile(filePath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[2], '{not json');
  assert.equal(JSON.parse(lines[1]).id, idOf('two'));
  assert.ok(JSON.parse(lines[1]).editedAt);
  assert.deepEqual(await countsOf(filePath), { input: 3, unverified: 0, invalid: 1, secrets: 0, duplicates: 0, included: 2 });
  await assert.rejects(updateCase(filePath, idOf('one'), { task: 'x', evidence: ' ' }), /buides/);
  await assert.rejects(updateCase(filePath, idOf('one'), { task: 'x', evidence: 'token sk-abcdefghijklmnopqrstuvwxyz' }), /credencial/);
  await assert.rejects(updateCase(filePath, idOf('one'), { task: 'x'.repeat(4001), evidence: 'ok' }), /límit/);
});

test('deleting moves the case to the deleted file and the counts drop', async () => {
  const { filePath, deletedPath } = await setup([record('one'), record('two'), record('dup', { prompt: 'Petició one', answer: 'Resposta one' })]);
  assert.deepEqual(await countsOf(filePath), { input: 3, unverified: 0, invalid: 0, secrets: 0, duplicates: 1, included: 2 });
  assert.deepEqual(await deleteCase(filePath, deletedPath, idOf('dup')), { id: idOf('dup'), deleted: 1 });
  assert.deepEqual(await countsOf(filePath), { input: 2, unverified: 0, invalid: 0, secrets: 0, duplicates: 0, included: 2 });
  await deleteCase(filePath, deletedPath, idOf('one'));
  const deleted = (await fs.readFile(deletedPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(deleted.map((item) => item.id), [idOf('dup'), idOf('one')]);
  assert.ok(deleted.every((item) => item.deletedAt && item.prompt));
  assert.deepEqual((await listCases(filePath)).cases.map((item) => item.id), [idOf('two')]);
  await deleteCase(filePath, deletedPath, idOf('two'));
  assert.equal(await fs.readFile(filePath, 'utf8'), '');
});

test('the rewrite is atomic: no temporary file is left and a failed rename leaves the file untouched', async () => {
  const { directory, filePath } = await setup([record('one'), record('two')]);
  const before = await fs.readFile(filePath, 'utf8');
  await updateCase(filePath, idOf('one'), { task: 'canvi', evidence: 'ok' });
  assert.deepEqual((await fs.readdir(directory)).sort(), ['verified-experiences.jsonl']);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);

  const originalRename = fs.rename;
  const changed = await fs.readFile(filePath, 'utf8');
  fs.rename = async () => { throw Object.assign(new Error('disc ple'), { code: 'ENOSPC' }); };
  try { await assert.rejects(updateCase(filePath, idOf('two'), { task: 'un altre', evidence: 'ok' }), /disc ple/); }
  finally { fs.rename = originalRename; }
  assert.equal(await fs.readFile(filePath, 'utf8'), changed);
  assert.notEqual(changed, before);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['verified-experiences.jsonl']);
});

test('changes and appends on the same file run one after another, so none is lost', async () => {
  const { filePath, deletedPath } = await setup([record('one'), record('two'), record('three')]);
  const append = (name) => withCasesLock(filePath, () => fs.appendFile(filePath, JSON.stringify(record(name)) + '\n'));
  await Promise.all([
    updateCase(filePath, idOf('one'), { task: 'primer', evidence: 'ok' }),
    append('four'),
    deleteCase(filePath, deletedPath, idOf('two')),
    append('five'),
    updateCase(filePath, idOf('three'), { task: 'tercer', evidence: 'ok' }),
  ]);
  const { cases } = await listCases(filePath);
  assert.deepEqual(cases.map((item) => item.task).sort(), ['Tasca five', 'Tasca four', 'primer', 'tercer']);
});

test('a case written by hand: every field required, the same limits and the same credential check as a saved one', () => {
  const cases = require('./learning-cases.cjs');
  const good = { task: 'Afegir un botó de Chakra', prompt: 'posa un Button a App.tsx', answer: 'import { Button } from "@chakra-ui/react"', evidence: 'build ok' };
  assert.deepEqual(cases.validateManualCase(good).errors, {});
  assert.deepEqual(cases.validateManualCase(good).fields, good);
  assert.deepEqual(Object.keys(cases.validateManualCase({ ...good, prompt: '  ', evidence: '' }).errors).sort(), ['evidence', 'prompt']);
  assert.match(cases.validateManualCase({ ...good, answer: 'x'.repeat(30001) }).errors.answer, /Massa llarg: com a màxim 30000/);
  assert.match(cases.validateManualCase({ ...good, answer: 'clau ghp_abcdefghijklmnopqrstuvwxyz0123' }).errors.answer, /credencial/);
  assert.equal(Object.keys(cases.validateManualCase(null).errors).length, 4);
});

test('a manual case is saved as a verified case marked «manual», and listed as such', async (t) => {
  const cases = require('./learning-cases.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-manual-case-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'verified-experiences.jsonl');
  const record = { id: 'b'.repeat(64), at: '2026-11-15T09:40:00Z', prompt: 'posa un Button', answer: 'fet', evidence: 'build ok', task: 'Botó', verification: 'user-confirmed', source: 'manual' };
  await fs.writeFile(file, JSON.stringify(record) + '\n');
  const listed = await cases.listCases(file);
  assert.equal(listed.cases[0].source, 'manual');
  // The main process accepts it through the same handler as «Desa com a cas verificat», with the checks first.
  const main = require('node:fs').readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  assert.match(main, /if \(value\.source === 'manual'\) \{\n\s*const \{ errors \} = learningCases\.validateManualCase\(value\);/);
  assert.match(main, /verification: 'user-confirmed', \.\.\.\(value\.source === 'manual' \? \{ source: 'manual' \} : \{\}\) \};/);
});
