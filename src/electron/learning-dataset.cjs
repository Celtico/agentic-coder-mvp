const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const { toTurnExamples } = require('./learning-trajectory.cjs');

const MAX_RECORDS = 10_000;
const MAX_INPUT_BYTES = 20_000_000;
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/i,
  /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
];

function normalizeText(value) {
  return value.toLocaleLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseVerifiedExperiences(contents) {
  if (typeof contents !== 'string' || Buffer.byteLength(contents, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error('El registre de casos verificats supera el límit de 20 MB.');
  }
  return contents.split(/\r?\n/).filter(Boolean).slice(-MAX_RECORDS).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return [{ __invalidJSON: true }]; }
  });
}

function prepareTrainingDataset(records) {
  const counts = { input: records.length, unverified: 0, invalid: 0, secrets: 0, duplicates: 0, included: 0 };
  const unique = new Map();
  // The cases left out, and why, so the window can show them (src/app: Dades preparades › Mostra).
  const discarded = [];
  const leaveOut = (record, reason) => {
    const ok = record && typeof record === 'object' && !Array.isArray(record);
    discarded.push({ id: ok && typeof record.id === 'string' ? record.id : null, task: ok ? String(record.task || record.prompt || '').slice(0, 300) : '', reason });
  };
  for (const record of records.slice(-MAX_RECORDS)) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.__invalidJSON === true) { counts.invalid += 1; leaveOut(record, 'invalid'); continue; }
    if (record.verification !== 'user-confirmed') { counts.unverified += 1; leaveOut(record, 'unverified'); continue; }
    if (typeof record.id !== 'string' || !record.id || typeof record.projectPath !== 'string' ||
        typeof record.prompt !== 'string' || typeof record.answer !== 'string' || typeof record.evidence !== 'string' ||
        !record.prompt.trim() || !record.answer.trim() || !record.evidence.trim() ||
        record.prompt.length > 12_000 || record.answer.length > 30_000 || record.evidence.length > 4_000) {
      counts.invalid += 1; leaveOut(record, 'invalid'); continue;
    }
    const trajectory = record.trajectory && typeof record.trajectory === 'object' && Array.isArray(record.trajectory.turns) ? record.trajectory : null;
    const trajectoryText = trajectory ? JSON.stringify(trajectory) : '';
    if (trajectoryText.length > 400_000) { counts.invalid += 1; leaveOut(record, 'invalid'); continue; }
    const task = typeof record.task === 'string' && record.task.trim() ? record.task.trim().slice(0, 4000) : null;
    const text = `${record.prompt}\n${record.answer}\n${record.evidence}\n${task || ''}\n${trajectoryText}`;
    if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) { counts.secrets += 1; leaveOut(record, 'secret'); continue; }
    const projectHash = digest(path.resolve(record.projectPath));
    const duplicateKey = `${projectHash}\n${normalizeText(record.prompt)}\n${normalizeText(record.answer)}`;
    if (unique.has(duplicateKey)) { counts.duplicates += 1; leaveOut(record, 'duplicate'); continue; }
    unique.set(duplicateKey, {
      sourceId: record.id,
      sourceProjectHash: projectHash,
      sourceCreatedAt: typeof record.at === 'string' ? record.at : null,
      sourceModel: typeof record.model === 'string' ? record.model : null,
      prompt: record.prompt.trim(),
      answer: record.answer.trim(),
      evidence: record.evidence.trim(),
      ...(task ? { task } : {}),
      ...(trajectory ? { trajectory } : {}),
      // What the user left out of the training in the case's detail (turns, and steps as «turn:step»).
      ...(Array.isArray(record.excludedTurns) && record.excludedTurns.length ? { excludedTurns: record.excludedTurns.filter(Number.isInteger) } : {}),
      ...(Array.isArray(record.excludedSteps) && record.excludedSteps.length ? { excludedSteps: record.excludedSteps.filter((key) => typeof key === 'string' && /^\d+:\d+$/.test(key)) } : {}),
    });
  }

  const examples = [...unique.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  counts.included = examples.length;
  const ranked = examples.map((example) => ({ example, order: digest(example.sourceProjectHash + example.sourceId) })).sort((a, b) => a.order.localeCompare(b.order));
  const partitions = { train: [], validation: [], test: [] };
  if (ranked.length < 3) partitions.train = ranked.map(({ example }) => example);
  else {
    const testCount = Math.max(1, Math.floor(ranked.length * 0.1));
    const validationCount = Math.max(1, Math.floor(ranked.length * 0.1));
    const trainCount = ranked.length - testCount - validationCount;
    partitions.train = ranked.slice(0, trainCount).map(({ example }) => example);
    partitions.validation = ranked.slice(trainCount, trainCount + validationCount).map(({ example }) => example);
    partitions.test = ranked.slice(trainCount + validationCount).map(({ example }) => example);
  }
  const splitCounts = Object.fromEntries(Object.entries(partitions).map(([name, items]) => [name, items.length]));
  return {
    counts,
    splitCounts,
    trainingReady: counts.included >= 30 && splitCounts.train >= 24 && splitCounts.validation >= 3 && splitCounts.test >= 3,
    partitions,
    discarded,
  };
}

/**
 * The prepared data as the window shows it: each split's cases with their examples (one per turn: the
 * request, the steps, the tokens, and whether it fits) and the turns left out, then the cases left out
 * with their reason. `examplesFor(item)` builds a case's examples (learning-versions.toTrainingExamples).
 */
function datasetView(prepared, examplesFor) {
  const view = (example) => {
    const { built, skipped } = examplesFor(example);
    const turns = example.trajectory?.turns || [];
    return {
      id: example.sourceId, task: example.task || example.prompt.slice(0, 300), prompt: example.prompt, answer: example.answer, evidence: example.evidence,
      examples: built.map((item) => ({ turn: item.turn, request: String(turns[item.turn]?.request || example.prompt).slice(0, 400), steps: item.messages ? item.messages.filter((message) => message.role === 'assistant').length - 1 : 0, tokens: item.tokens, fits: Boolean(item.messages), truncated: Boolean(item.truncated), messages: item.messages || [] })),
      skipped,
    };
  };
  const splits = { train: prepared.partitions.train.map(view), validation: prepared.partitions.validation.map(view), test: prepared.partitions.test.map(view) };
  const all = [...splits.train, ...splits.validation, ...splits.test];
  return {
    counts: { ...prepared.counts, examples: all.reduce((n, item) => n + item.examples.filter((example) => example.fits).length, 0), droppedExamples: all.reduce((n, item) => n + item.examples.filter((example) => !example.fits).length, 0), skippedTurns: all.reduce((n, item) => n + item.skipped.length, 0) },
    splits,
    discarded: prepared.discarded || [],
  };
}

/** The prepared data as one JSONL file: one example per line (a turn of a case), with its case, turn and split. */
function datasetJsonl(prepared, examplesFor) {
  return ['train', 'validation', 'test'].flatMap((split) => prepared.partitions[split].flatMap((example) => examplesFor(example).built.filter((item) => item.messages).map((item) => JSON.stringify({ split, caseId: example.sourceId, turn: item.turn, messages: item.messages })))).join('\n') + '\n';
}

async function writeTrainingCandidate(prepared, candidatesDirectory) {
  if (!prepared || !prepared.counts?.included || !prepared.partitions) throw new Error('No hi ha cap cas verificat apte per preparar.');
  const root = path.resolve(candidatesDirectory);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  const createdAt = new Date().toISOString();
  const version = `dataset-${createdAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const candidateDirectory = path.join(root, version);
  await fs.mkdir(candidateDirectory, { mode: 0o700 });
  try {
    const files = {};
    for (const name of ['train', 'validation', 'test']) {
      const content = prepared.partitions[name].map((item) => JSON.stringify(item)).join('\n') + (prepared.partitions[name].length ? '\n' : '');
      const filePath = path.join(candidateDirectory, `${name}.jsonl`);
      await fs.writeFile(filePath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.chmod(filePath, 0o400);
      files[`${name}.jsonl`] = { records: prepared.partitions[name].length, sha256: digest(content) };
    }
    // The same split in the chat format `mlx_lm.lora --data <folder>/mlx` reads (train, valid, test).
    const mlxDirectory = path.join(candidateDirectory, 'mlx');
    await fs.mkdir(mlxDirectory, { mode: 0o700 });
    for (const [name, file] of [['train', 'train.jsonl'], ['validation', 'valid.jsonl'], ['test', 'test.jsonl']]) {
      const content = prepared.partitions[name].flatMap((item) => toTurnExamples(item).examples.map((example) => JSON.stringify({ messages: example.messages }))).join('\n') + (prepared.partitions[name].length ? '\n' : '');
      const filePath = path.join(mlxDirectory, file);
      await fs.writeFile(filePath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.chmod(filePath, 0o400);
      files[`mlx/${file}`] = { records: prepared.partitions[name].length, sha256: digest(content) };
    }
    await fs.chmod(mlxDirectory, 0o500);
    const datasetHash = digest(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, file]) => `${name}:${file.sha256}`).join('\n'));
    const manifest = {
      schemaVersion: 1,
      datasetVersion: version,
      createdAt,
      source: 'user-confirmed local experiences only',
      counts: prepared.counts,
      splits: prepared.splitCounts,
      trainingReady: prepared.trainingReady,
      files,
      datasetHash,
      withTrajectory: prepared.partitions.train.concat(prepared.partitions.validation, prepared.partitions.test).filter((item) => item.trajectory).length,
      note: 'Candidate data only. No model was trained or changed. Review quality and privacy before any training.',
    };
    const manifestPath = path.join(candidateDirectory, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.chmod(manifestPath, 0o400);
    await fs.chmod(candidateDirectory, 0o500);
    return { directory: candidateDirectory, manifest };
  } catch (error) {
    await fs.chmod(candidateDirectory, 0o700).catch(() => {});
    await fs.rm(candidateDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { parseVerifiedExperiences, prepareTrainingDataset, writeTrainingCandidate, datasetView, datasetJsonl, SECRET_PATTERNS };
