// The saved verified cases (userData/learning/verified-experiences.jsonl), one JSON object per line, as the
// learning panel shows and manages them: list, read one in detail, edit its general request and its check,
// and delete it. A deleted case is moved to verified-experiences.deleted.jsonl beside it, never lost. Every
// change rewrites the file atomically (a temporary file in the same folder, then rename), keeps lines it
// cannot read exactly as they were, and runs one at a time with new cases being appended.
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { SECRET_PATTERNS } = require('./learning-dataset.cjs');

const CASE_ID = /^[a-f0-9]{64}$/;
const MAX_TASK = 4000;
const MAX_EVIDENCE = 4000;
const MAX_FILE_BYTES = 20_000_000;

function validCaseId(id) {
  if (typeof id !== 'string' || !CASE_ID.test(id)) throw new Error('L’identificador del cas no és vàlid.');
  return id;
}

// One change at a time per file, also with the append of a new case (src/electron/main.cjs).
const locks = new Map();
function withCasesLock(filePath, work) {
  const key = path.resolve(filePath);
  const previous = locks.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(work);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

async function readLines(filePath) {
  let contents;
  try { contents = await fs.readFile(filePath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (Buffer.byteLength(contents, 'utf8') > MAX_FILE_BYTES) throw new Error('El registre de casos verificats supera el límit de 20 MB.');
  return contents.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    try {
      const record = JSON.parse(line);
      return { line, record: record && typeof record === 'object' && !Array.isArray(record) ? record : null };
    } catch { return { line, record: null }; }
  });
}

async function writeAtomically(filePath, lines) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(lines.length ? lines.join('\n') + '\n' : '', 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  try { await fs.rename(temporary, filePath); }
  catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
  await fs.chmod(filePath, 0o600).catch(() => {});
}

const str = (value) => (typeof value === 'string' ? value : '');
const turnsOf = (record) => (record.trajectory && Array.isArray(record.trajectory.turns) ? record.trajectory.turns.filter((turn) => turn && typeof turn === 'object') : []);
const stepsOf = (turn) => (Array.isArray(turn.steps) ? turn.steps.filter((step) => step && typeof step === 'object' && typeof step.name === 'string') : []);

function summarizeCase(record) {
  const turns = turnsOf(record);
  const steps = turns.reduce((total, turn) => total + stepsOf(turn).length, 0);
  return {
    id: record.id,
    at: typeof record.at === 'string' ? record.at : null,
    model: typeof record.model === 'string' ? record.model : null,
    task: str(record.task) || str(record.prompt),
    evidence: str(record.evidence),
    turns: turns.length,
    steps,
    withoutToolSteps: steps === 0,
    ...(typeof record.editedAt === 'string' ? { editedAt: record.editedAt } : {}),
    ...(record.source === 'manual' ? { source: 'manual' } : {}),
  };
}

/** The limits of a case, the same for one saved from the chat and one written by hand. */
const CASE_LIMITS = { task: 4000, prompt: 12000, answer: 30000, evidence: 4000 };
const SECRET_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/i;

/**
 * A case written by hand in Aprenentatge local › Dades preparades › Crea: each field checked, with what is
 * wrong with it in the window's words (empty, too long, a credential in it). No errors: `errors` is empty.
 */
function validateManualCase(value) {
  const fields = { task: str(value?.task).trim(), prompt: str(value?.prompt).trim(), answer: str(value?.answer).trim(), evidence: str(value?.evidence).trim() };
  const errors = {};
  for (const [name, text] of Object.entries(fields)) {
    if (!text) errors[name] = 'Cal omplir aquest camp.';
    else if (text.length > CASE_LIMITS[name]) errors[name] = `Massa llarg: com a màxim ${CASE_LIMITS[name]} caràcters.`;
    else if (SECRET_PATTERN.test(text)) errors[name] = 'Sembla que conté una credencial: treu-la abans de desar.';
  }
  return { fields, errors };
}

/** The saved cases, newest first. Lines that are not a readable case are counted, not shown. */
async function listCases(filePath) {
  const lines = await readLines(filePath);
  const cases = lines.filter(({ record }) => record && typeof record.id === 'string' && CASE_ID.test(record.id)).map(({ record }) => summarizeCase(record));
  cases.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return { cases, unreadable: lines.length - cases.length };
}

function shortValue(value, limit) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof text !== 'string') return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
function summarizeArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  return Object.fromEntries(Object.entries(args).slice(0, 12).map(([key, value]) => [key, shortValue(value, 160)]));
}

/** One case as the detail view shows it: each request, its tool calls with short arguments, and the final answer. */
async function readCase(filePath, id) {
  validCaseId(id);
  const found = (await readLines(filePath)).find(({ record }) => record && record.id === id);
  if (!found) throw new Error('Aquest cas ja no és al registre.');
  const record = found.record;
  const turns = turnsOf(record);
  const requests = turns.length
    ? turns.map((turn) => ({
      request: str(turn.request),
      steps: stepsOf(turn).map((step) => ({ name: step.name, ok: step.ok === true, arguments: summarizeArguments(step.arguments), result: shortValue(str(step.result), 300) })),
      answer: str(turn.answer),
    }))
    : [{ request: str(record.prompt), steps: [], answer: str(record.answer) }];
  return { ...summarizeCase(record), prompt: str(record.prompt), answer: str(record.answer), requests };
}

/** Changes the general request and the check of one case. The id stays: it names the case that was saved. */
async function updateCase(filePath, id, changes) {
  validCaseId(id);
  if (!changes || typeof changes !== 'object') throw new Error('Els canvis del cas no són vàlids.');
  const { task, evidence } = changes;
  if (typeof task !== 'string' || typeof evidence !== 'string') throw new Error('Cal indicar la petició general i la comprovació.');
  const cleanTask = task.trim();
  const cleanEvidence = evidence.trim();
  if (!cleanTask || !cleanEvidence) throw new Error('La petició general i la comprovació no poden quedar buides.');
  if (cleanTask.length > MAX_TASK || cleanEvidence.length > MAX_EVIDENCE) throw new Error('El text supera el límit de mida.');
  if (SECRET_PATTERNS.some((pattern) => pattern.test(`${cleanTask}\n${cleanEvidence}`))) throw new Error('Sembla que el text conté una credencial. Treu-la abans de desar.');
  return withCasesLock(filePath, async () => {
    const lines = await readLines(filePath);
    const index = lines.findIndex(({ record }) => record && record.id === id);
    if (index < 0) throw new Error('Aquest cas ja no és al registre.');
    const record = { ...lines[index].record, task: cleanTask, evidence: cleanEvidence, editedAt: new Date().toISOString() };
    lines[index] = { line: JSON.stringify(record), record };
    await writeAtomically(filePath, lines.map((item) => item.line));
    return summarizeCase(record);
  });
}

/** Moves one case to the deleted file (first) and then rewrites the register without it. */
async function deleteCase(filePath, deletedPath, id) {
  validCaseId(id);
  return withCasesLock(filePath, async () => {
    const lines = await readLines(filePath);
    const removed = lines.filter(({ record }) => record && record.id === id);
    if (!removed.length) throw new Error('Aquest cas ja no és al registre.');
    await fs.mkdir(path.dirname(deletedPath), { recursive: true });
    const deletedAt = new Date().toISOString();
    await fs.appendFile(deletedPath, removed.map(({ record }) => JSON.stringify({ ...record, deletedAt })).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(deletedPath, 0o600).catch(() => {});
    await writeAtomically(filePath, lines.filter(({ record }) => !(record && record.id === id)).map((item) => item.line));
    return { id, deleted: removed.length };
  });
}

module.exports = { validCaseId, withCasesLock, listCases, readCase, updateCase, deleteCase, summarizeCase, validateManualCase, CASE_LIMITS, SECRET_PATTERN };
