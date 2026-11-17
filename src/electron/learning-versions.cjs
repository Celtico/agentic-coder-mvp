// Learning in versions, «beta → stable», from the verified cases (verified-experiences.jsonl):
//
// - A beta is always trained from the original base model (never on top of another adapter) with every
//   valid case so far, as a LoRA adapter in models/adapters/<base-id>/beta-<N>-<date>/ with a manifest.
//   The chat offers «<base> beta · N casos» (the base with that adapter); the base stays available.
// - A stable version is prepared (≥ 30 cases) the same way, then compared with the base on the benchmark,
//   and only promoted when the user says so, with a name: it is fused into models/mlx/<name>-estable-vN.
//
// Nothing here trains by itself: the main process runs it from the panel's buttons. Commands are run by
// an injected `run(command, args, { onLine, signal })`, so all of this is tested without a model.
const fs = require('node:fs/promises');
const path = require('node:path');
const { toTurnExamples } = require('./learning-trajectory.cjs');
const { slugify } = require('./learning-training.cjs');

const BETA_MIN_CASES = 1;
const STABLE_MIN_CASES = 30;
/** Under this many cases a beta only checks that the whole circuit works. */
const FEW_CASES = 10;

/** Preferències › Aprenentatge: prudent values for a 16 GB Mac (maxTokens: defaultMaxTokens, by this Mac's memory). */
const TRAINING_LIMITS = {
  maxTokens: { min: 512, max: 8192, default: 4096 },
  numLayers: { min: 4, max: 16, default: 8 },
  learningRate: { min: 0.000005, max: 0.00005, default: 0.00001 },
  itersPerCase: { min: 5, max: 100, default: 20 },
  minIters: { min: 10, max: 500, default: 60 },
  maxIters: { min: 20, max: 2000, default: 600 },
  seed: { min: 0, max: 2147483647, default: 7 },
};
const INTEGER_KEYS = ['maxTokens', 'numLayers', 'itersPerCase', 'minIters', 'maxIters', 'seed'];

/**
 * Tokens per example that fit this Mac when training a 9B model (MiMo, measured 17-11-2026 on 16 GB with the
 * engine's chunkwise DeltaNet: 1,536 tokens 11.1 GB of the 12.7 the GPU may use; each 1,024 more ≈ 2.5 GB).
 * A bigger Mac trains longer examples: 24 GB 3,072, 32 GB or more 4,096.
 */
function defaultMaxTokens(memoryBytes = require('node:os').totalmem()) {
  const gb = memoryBytes / 2 ** 30;
  return gb <= 16 ? 1536 : gb <= 24 ? 3072 : 4096;
}

const defaultTrainingPreferences = (memoryBytes) => ({ ...Object.fromEntries(Object.entries(TRAINING_LIMITS).map(([key, limit]) => [key, limit.default])), maxTokens: defaultMaxTokens(memoryBytes) });

function normalizeTrainingPreferences(value, base = defaultTrainingPreferences()) {
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = { ...base };
  for (const [key, limit] of Object.entries(TRAINING_LIMITS)) {
    const number = typeof saved[key] === 'number' ? saved[key] : typeof saved[key] === 'string' && saved[key].trim() ? Number(saved[key]) : NaN;
    if (!Number.isFinite(number)) continue;
    const clamped = Math.min(limit.max, Math.max(limit.min, number));
    result[key] = INTEGER_KEYS.includes(key) ? Math.round(clamped) : clamped;
  }
  if (result.minIters > result.maxIters) result.minIters = result.maxIters;
  return result;
}

/** Iterations for a number of cases: max(minIters, itersPerCase × cases), at most maxIters. */
const itersFor = (cases, preferences) => Math.min(preferences.maxIters, Math.max(preferences.minIters, preferences.itersPerCase * Math.max(1, cases)));

/** What the panel's buttons may do, and why not. */
function learningButtons({ cases = 0, running = false, otherWork = false, candidate = null }) {
  const busy = running ? 'Ja hi ha un entrenament en marxa.' : otherWork ? 'Espera que acabi la resposta o l’avaluació.' : null;
  return {
    beta: { enabled: !busy && cases >= BETA_MIN_CASES, reason: busy || (cases < BETA_MIN_CASES ? 'Cal almenys un cas verificat vàlid.' : null), fewCases: cases > 0 && cases < FEW_CASES },
    stable: { enabled: !busy && cases >= STABLE_MIN_CASES, reason: busy || (cases < STABLE_MIN_CASES ? `Calen ${STABLE_MIN_CASES} casos verificats; n’hi ha ${cases}.` : null) },
    promote: { enabled: !busy && Boolean(candidate?.comparison && !candidate.promoted), reason: busy || (!candidate ? 'Primer prepara l’estable.' : !candidate.comparison ? 'Falta la comparativa amb el model base.' : candidate.promoted ? 'Aquesta candidata ja és estable.' : null) },
  };
}

/**
 * About how many tokens a text takes, on the safe side: an example estimated to fit must fit, or training
 * cuts it before its answer. Measured with MiMo's tokenizer (17-11-2026): the agent's turns (code, JSON,
 * Catalan) 3.2 characters a token on average but many examples well under, Chakra UI's documentation 3.6.
 * With 2.6, 2 of the 94 examples of cel's cases still go over 1,536 tokens (at 3.5, 63 did).
 */
const CHARS_PER_TOKEN = Number(process.env.AGENT_CHARS_PER_TOKEN) || 2.6;
const estimateTokens = (text) => Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
const tokensOf = (messages) => messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);

/**
 * One training example (a turn of a case) fitted to `maxTokens`: the agent's system text if there is room,
 * the request, the tool calls with what they returned, and the answer. When it is longer, the system text
 * is cut from its end first (files' contents come last in it), then the tool results, each to an equal
 * share; the request and the answer are never cut. Returns null messages when even then it does not fit.
 */
function fitExample({ messages, system = '' }, maxTokens) {
  const chat = messages.map((message) => ({ ...message }));
  let truncated = false;
  const fixedIndexes = new Set([0, chat.length - 1]);
  let size = tokensOf(chat);
  if (size > maxTokens) {
    const results = chat.map((message, index) => ({ message, index })).filter(({ message, index }) => message.role === 'user' && !fixedIndexes.has(index));
    const fixed = tokensOf(chat.filter((_message, index) => !results.some((result) => result.index === index)));
    const share = results.length ? Math.floor((maxTokens - fixed) / results.length) - 4 : 0;
    if (share < 16 && results.length) return { messages: null, truncated: true };
    for (const { message } of results) {
      if (estimateTokens(message.content) > share) { message.content = `${message.content.slice(0, Math.max(0, Math.floor(share * CHARS_PER_TOKEN) - 20))}\n[retallat]`; truncated = true; }
    }
    size = tokensOf(chat);
    if (size > maxTokens) return { messages: null, truncated: true };
  }
  const room = maxTokens - size - 8;
  let systemText = system;
  if (systemText && estimateTokens(systemText) > room) {
    truncated = true;
    systemText = room >= 200 ? `${systemText.slice(0, Math.floor(room * CHARS_PER_TOKEN) - 20)}\n[retallat]` : '';
  }
  return { messages: systemText ? [{ role: 'system', content: systemText }, ...chat] : chat, truncated };
}

/**
 * A turn too long for `maxTokens`, as one example per step: each of the agent's messages (a tool call, or the
 * answer) is the last message of an example with the request and as many of the steps just before it as fit.
 * Training learns the last message of each example (--mask-prompt), so every step of the turn is learnt,
 * not only its answer. A step that does not fit even alone with the request is left out.
 */
function stepExamples({ messages, system = '' }, maxTokens) {
  const steps = [];
  for (let last = 1; last < messages.length; last++) {
    if (messages[last].role !== 'assistant') continue;
    let fitted = null;
    // From the oldest step to keep down to only this one; a window starts at one of the agent's messages.
    for (let first = 1; first <= last && !fitted?.messages; first++) {
      if (messages[first].role !== 'assistant') continue;
      fitted = fitExample({ messages: [messages[0], ...messages.slice(first, last + 1)], system }, maxTokens);
      if (fitted.messages && first > 1) fitted.truncated = true;
    }
    steps.push({ step: last, ...(fitted || { messages: null, truncated: true }) });
  }
  return steps;
}

/** The examples of one case, one per turn (src/electron/learning-trajectory.cjs), each fitted to `maxTokens`. */
function toTrainingExamples(example, maxTokens) {
  const { examples, skipped } = toTurnExamples(example);
  const built = examples.map((turn) => {
    const whole = fitExample(turn, maxTokens);
    if (whole.messages) return { turn: turn.turn, ...whole, tokens: tokensOf(turn.messages) };
    // Too long whole: one example per step of the agent.
    return { turn: turn.turn, ...whole, tokens: tokensOf(turn.messages), steps: stepExamples(turn, maxTokens) };
  });
  return { built, skipped };
}

/** Every valid case (all partitions of a prepared dataset) as training examples, one per turn. */
function buildTrainingExamples(prepared, maxTokens) {
  const all = [...prepared.partitions.train, ...prepared.partitions.validation, ...prepared.partitions.test];
  const examples = [];
  let truncated = 0;
  let dropped = 0;
  let skippedTurns = 0;
  let split = 0;
  let stepsDropped = 0;
  for (const item of all) {
    const { built, skipped } = toTrainingExamples(item, maxTokens);
    skippedTurns += skipped.length;
    for (const turn of built) {
      if (!turn.messages && turn.steps) {
        const kept = turn.steps.filter((step) => step.messages);
        if (!kept.length) { dropped += 1; continue; }
        split += 1;
        stepsDropped += turn.steps.length - kept.length;
        for (const step of kept) {
          if (step.truncated) truncated += 1;
          examples.push({ id: `${item.sourceId}:${turn.turn}:${step.step}`, caseId: item.sourceId, turn: turn.turn, step: step.step, messages: step.messages });
        }
        continue;
      }
      if (!turn.messages) { dropped += 1; continue; }
      if (turn.truncated) truncated += 1;
      examples.push({ id: `${item.sourceId}:${turn.turn}`, caseId: item.sourceId, turn: turn.turn, messages: turn.messages });
    }
  }
  return { examples, caseIds: [...new Set(examples.map((example) => example.caseId))], truncated, dropped, skippedTurns, split, stepsDropped };
}

/** The data folder mlx_lm reads: train.jsonl with every example; valid.jsonl only to watch the loss. */
async function writeTrainingData(directory, examples) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lines = (items) => items.map((example) => JSON.stringify({ messages: example.messages })).join('\n') + '\n';
  await fs.writeFile(path.join(directory, 'train.jsonl'), lines(examples), { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'valid.jsonl'), lines(examples.slice(0, 3)), { mode: 0o600 });
}

/** «Iter 20: Train loss 1.234, Learning Rate 1e-05, It/sec 0.12, Tokens/sec 380.5, …» */
function parseTrainingLine(line) {
  const match = /Iter (\d+): Train loss ([0-9.]+)(?:.*?It\/sec ([0-9.]+))?(?:.*?Tokens\/sec ([0-9.]+))?/.exec(line);
  if (!match) return null;
  return { iteration: Number(match[1]), loss: Number(match[2]), itPerSec: match[3] ? Number(match[3]) : null, tokensPerSec: match[4] ? Number(match[4]) : null };
}

const ADAPTER_FOLDER = /^(beta|candidata)-(\d+)-[0-9TZ-]+$/;

async function readManifests(modelsRoot, baseId) {
  const root = path.join(modelsRoot, 'adapters', baseId);
  const found = [];
  for (const name of await fs.readdir(root).catch(() => [])) {
    if (!ADAPTER_FOLDER.test(name)) continue;
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(root, name, 'manifest.json'), 'utf8'));
      await fs.access(path.join(root, name, 'adapters.safetensors'));
      found.push({ ...manifest, folder: name, adapterPath: path.join(root, name) });
    } catch { /* unfinished or not ours */ }
  }
  return found.sort((a, b) => b.number - a.number);
}

/** The betas of a base, newest first. */
const listBetas = async (modelsRoot, baseId) => (await readManifests(modelsRoot, baseId)).filter((item) => item.kind === 'beta');
/** The newest stable candidate of a base, or null. */
const latestCandidate = async (modelsRoot, baseId) => (await readManifests(modelsRoot, baseId)).find((item) => item.kind === 'candidata') || null;

async function nextNumber(modelsRoot, baseId, kind) {
  let highest = 0;
  for (const name of await fs.readdir(path.join(modelsRoot, 'adapters', baseId)).catch(() => [])) {
    const match = ADAPTER_FOLDER.exec(name);
    if (match && match[1] === kind) highest = Math.max(highest, Number(match[2]));
  }
  return highest + 1;
}

/**
 * The chat's entries for the betas of each base, newest first: the base with that adapter. The newest is
 * `latest` (offered in the selector by default; the others only when switched on in Gestiona els models).
 */
async function betaModels(baseModels, modelsRoot) {
  const entries = [];
  for (const base of baseModels) {
    (await listBetas(modelsRoot, base.id)).forEach((beta, index) => entries.push({
      ...base, id: `${base.id}@${beta.folder}`, label: `${base.label} beta ${beta.number} · ${beta.cases} ${beta.cases === 1 ? 'cas' : 'casos'}`,
      adapterPath: beta.adapterPath, beta: true, latest: index === 0, number: beta.number, cases: beta.cases, createdAt: beta.createdAt, baseId: base.id, aliases: [],
    }));
  }
  return entries;
}

/** Deletes a beta that is not the newest one (the newest is the one the chat offers). */
async function deleteBeta(modelsRoot, baseId, folder) {
  if (typeof folder !== 'string' || !ADAPTER_FOLDER.test(folder) || !folder.startsWith('beta-')) throw new Error('Aquesta beta no és vàlida.');
  const betas = await listBetas(modelsRoot, baseId);
  if (!betas.some((beta) => beta.folder === folder)) throw new Error('Aquesta beta ja no hi és.');
  if (betas[0].folder === folder) throw new Error('L’última beta és la que fa servir el xat; només es poden esborrar les anteriors.');
  await fs.rm(path.join(modelsRoot, 'adapters', baseId, folder), { recursive: true, force: true });
  return { deleted: folder };
}

/**
 * Trains one adapter from the base with every valid case. `kind` is 'beta' or 'candidata' (for a stable
 * version). Writes manifest.json; on failure or when stopped, the half-made folder is removed.
 */
// `imported`: examples loaded from .jsonl files (Dades JSON, src/electron/learning-imports.cjs), trained beside the cases.
async function trainAdapter({ kind, base, prepared, preferences, modelsRoot, python, launcher = null, run, onProgress = () => {}, signal, now = () => new Date(), imported = { examples: [], dropped: 0 } }) {
  if (kind !== 'beta' && kind !== 'candidata') throw new Error('Tipus d’entrenament desconegut.');
  const built = buildTrainingExamples(prepared, preferences.maxTokens);
  const needed = kind === 'beta' ? BETA_MIN_CASES : STABLE_MIN_CASES;
  if (built.caseIds.length < needed) throw new Error(`Calen ${needed} casos vàlids que hi càpiguen; n’hi ha ${built.caseIds.length}${built.dropped ? ` (${built.dropped} exemples no hi caben ni retallats)` : ''}.`);
  const number = await nextNumber(modelsRoot, base.id, kind);
  const started = now();
  const folder = `${kind}-${number}-${started.toISOString().replace(/[:.]/g, '-')}`;
  const adapterPath = path.join(modelsRoot, 'adapters', base.id, folder);
  const examples = [...built.examples, ...imported.examples];
  const iters = itersFor(examples.length, preferences);
  const parameters = { iters, batchSize: 1, numLayers: preferences.numLayers, learningRate: preferences.learningRate, maxTokens: preferences.maxTokens, seed: preferences.seed, gradCheckpoint: true, maskPrompt: true };
  await fs.mkdir(adapterPath, { recursive: true });
  try {
    await writeTrainingData(path.join(adapterPath, 'data'), examples);
    const fromFiles = imported.examples.length ? ` i ${imported.examples.length} de Dades JSON` : '';
    onProgress({ step: 'train', message: `Entrenant ${kind === 'beta' ? 'la beta' : 'la candidata a estable'} ${number} des de ${base.label} amb ${built.examples.length} ${built.examples.length === 1 ? 'cas' : 'casos'}${fromFiles} (${iters} iteracions)…`, progress: 0 });
    let last = null;
    const args = [...(launcher ? [launcher] : ['-m', 'mlx_lm']), 'lora', '--model', base.directory, '--train', '--data', path.join(adapterPath, 'data'), '--adapter-path', adapterPath,
      '--iters', String(iters), '--batch-size', '1', '--num-layers', String(preferences.numLayers), '--learning-rate', String(preferences.learningRate),
      '--max-seq-length', String(preferences.maxTokens), '--grad-checkpoint', '--mask-prompt', '--seed', String(preferences.seed),
      '--steps-per-report', '5', '--steps-per-eval', String(Math.max(20, iters)), '--save-every', String(Math.max(50, iters))];
    const result = await run(python, args, {
      signal,
      onLine: (line) => {
        const parsed = parseTrainingLine(line);
        if (parsed) last = parsed;
        const seconds = Math.round((now() - started) / 1000);
        onProgress({ step: 'train', message: parsed ? `Iteració ${parsed.iteration}/${iters} · pèrdua ${parsed.loss} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : line.slice(0, 300), ...(parsed ? { progress: Math.min(1, parsed.iteration / iters), iteration: parsed.iteration, loss: parsed.loss } : {}) });
      },
    });
    if (signal?.aborted) throw new Error('Entrenament aturat.');
    if (result.code !== 0) throw new Error(`L’entrenament ha fallat (codi ${result.code}): ${String(result.output).slice(-600)}`);
    const manifest = {
      kind, number, base: { id: base.id, modelId: base.modelId, label: base.label }, cases: built.caseIds.length, examples: examples.length, imported: { examples: imported.examples.length, dropped: imported.dropped, files: [...new Set(imported.examples.map((example) => example.file))] }, caseIds: built.caseIds,
      truncated: built.truncated, dropped: built.dropped, skippedTurns: built.skippedTurns, createdAt: started.toISOString(), durationSeconds: Math.round((now() - started) / 1000),
      parameters, finalLoss: last ? last.loss : null,
    };
    await fs.writeFile(path.join(adapterPath, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await fs.rm(path.join(adapterPath, 'data'), { recursive: true, force: true });
    return { ...manifest, folder, adapterPath };
  } catch (error) {
    await fs.rm(adapterPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Writes the benchmark comparison (base vs candidate) into the candidate's manifest. */
async function recordComparison(candidate, comparison) {
  const file = path.join(candidate.adapterPath, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.comparison = { base: comparison.base, candidate: comparison.candidate, at: new Date().toISOString() };
  await fs.writeFile(file, JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Promotes a compared candidate: fused into models/mlx/<name>-estable-vN, listed as «<name> · estable vN». */
async function promoteStable({ candidate, name, base, modelsRoot, python, launcher = null, run, now = () => new Date() }) {
  if (!candidate?.comparison) throw new Error('Falta la comparativa amb el model base: prepara l’estable abans.');
  if (candidate.promoted) throw new Error('Aquesta candidata ja s’ha promocionat.');
  const cleanName = String(name || '').trim();
  if (!cleanName || cleanName.length > 60) throw new Error('Tria un nom (fins a 60 caràcters).');
  const slug = `${slugify(cleanName)}-estable`;
  let version = 1;
  // A stable version goes with the engine's models: models/mlx on a Mac, models/hf on Linux.
  const modelsDir = require('./mlx-models.cjs').modelsFolder();
  for (const entry of await fs.readdir(path.join(modelsRoot, modelsDir)).catch(() => [])) {
    const match = new RegExp(`^${slug}-v(\\d+)$`).exec(entry);
    if (match) version = Math.max(version, Number(match[1]) + 1);
  }
  const folder = `${slug}-v${version}`;
  const savePath = path.join(modelsRoot, modelsDir, folder);
  await fs.mkdir(path.dirname(savePath), { recursive: true });
  const result = await run(python, [...(launcher ? [launcher] : ['-m', 'mlx_lm']), 'fuse', '--model', base.directory, '--adapter-path', candidate.adapterPath, '--save-path', savePath], {});
  if (result.code !== 0) { await fs.rm(savePath, { recursive: true, force: true }).catch(() => {}); throw new Error(`No s’ha pogut fusionar (codi ${result.code}).`); }
  const meta = {
    id: folder, label: `${cleanName} · estable v${version}`, modelId: `local/${folder}`, version, name: cleanName, stable: true,
    base: { id: base.id, modelId: base.modelId }, adapterPath: candidate.adapterPath, cases: candidate.cases, caseIds: candidate.caseIds,
    comparison: candidate.comparison, parameters: candidate.parameters, createdAt: now().toISOString(),
  };
  await fs.writeFile(path.join(savePath, 'agentic-model.json'), JSON.stringify(meta, null, 2));
  const file = path.join(candidate.adapterPath, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.promoted = { folder, label: meta.label, at: meta.createdAt };
  await fs.writeFile(file, JSON.stringify(manifest, null, 2));
  return meta;
}

module.exports = {
  defaultMaxTokens,
  BETA_MIN_CASES, STABLE_MIN_CASES, FEW_CASES, TRAINING_LIMITS, defaultTrainingPreferences, normalizeTrainingPreferences, itersFor,
  learningButtons, estimateTokens, CHARS_PER_TOKEN, fitExample, toTrainingExamples, buildTrainingExamples, writeTrainingData, parseTrainingLine,
  listBetas, latestCandidate, betaModels, deleteBeta, trainAdapter, recordComparison, promoteStable,
};
