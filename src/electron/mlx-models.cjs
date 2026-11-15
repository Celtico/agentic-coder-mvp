// The local MLX models the app can offer, and where their weights live under the models folder.
// Shared by the app (src/electron/main.cjs) and the benchmark (scripts/evaluate-agent.cjs).
//
// - A model downloaded through the Hugging Face cache lives in .hf/hub/models--<org>--<name>/snapshots/<rev>.
// - Any other model has its own folder: mlx/<folder>.
// - A model of our own (trained here) is a folder mlx/<folder> with an agentic-model.json next to its
//   weights: {"id", "label", "modelId", ...}. It is listed without any change to this file.
const fs = require('node:fs/promises');
const path = require('node:path');

// The engine of each platform: MLX on a Mac (Apple Silicon); on Linux, CUDA (PyTorch + transformers on
// NVIDIA GPUs, src/core/assistant/cuda-worker.py). A Linux model is a Hugging Face safetensors folder
// under models/hf/<folder>, added from Gestiona els models; the Mac's MLX models are not offered there.
const engineFor = (platform = process.platform) => platform === 'darwin' ? 'mlx' : 'cuda';
/** The folder under models/ where each engine keeps the models it can load. */
const modelsFolder = (platform = process.platform) => engineFor(platform) === 'mlx' ? 'mlx' : 'hf';
/** The Python that runs the engine: models/.mlx-venv on a Mac, models/.cuda-venv on Linux. */
const enginePython = (modelsRoot, platform = process.platform) => path.join(modelsRoot, engineFor(platform) === 'mlx' ? '.mlx-venv' : '.cuda-venv', 'bin', 'python');

const builtInModels = [
  { id: 'qwen-7b-mlx', label: 'Qwen2.5-Coder 7B · MLX', modelId: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit', runtime: 'mlx', hfCache: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit', aliases: ['7b'] },
  { id: 'gemma-4-12b-mlx', label: 'Gemma 4 12B · MLX', modelId: 'lmstudio-community/gemma-4-12B-it-MLX-4bit', runtime: 'mlx', folder: 'gemma-4-12b-it-4bit', aliases: ['gemma', 'gemma-4-12b'] },
  { id: 'mimo-9b-mlx', label: 'MiMo V2.6 9B · MLX', modelId: 'mlx-community/MiMo-V2.6-Distill-Qwen-9B-OptiQ-4bit', runtime: 'mlx', folder: 'mimo-v2.6-distill-qwen-9b-4bit', aliases: ['mimo', 'mimo-9b'] },
  // The same model with its vision tower (4-bit, about 6 GB); offered once its weights are in mlx/<folder>.
  { id: 'mimo-9b-vl-mlx', label: 'MiMo V2.6 9B amb visió · MLX', modelId: 'nativ-community/MiMo-V2.6-Distill-Qwen-9B-MLX-4bit', runtime: 'mlx', folder: 'mimo-v2.6-distill-qwen-9b-vl-4bit', aliases: ['mimo-vl'] },
];

// The base model of the app: MiMo V2.6 9B (13-11-2026 benchmark: 9/10 open tasks, close to Gemma 4 12B's
// 10/10 in about half its time per task). The others stay selectable.
const DEFAULT_MODEL_ID = 'mimo-9b-mlx';

/** The model to use when none is chosen (or the chosen one is gone): the base one, or else the first listed. */
const defaultModel = (models) => models.find((model) => model.id === DEFAULT_MODEL_ID) || models[0];

async function hasWeights(directory) {
  try {
    await fs.access(path.join(directory, 'config.json'));
    return (await fs.readdir(directory)).some((name) => name.endsWith('.safetensors'));
  } catch { return false; }
}

/** The folder with the model's weights, or null when they are not on this machine. */
async function modelDirectory(model, modelsRoot) {
  if (model.hfCache) {
    const snapshots = path.join(modelsRoot, '.hf', 'hub', `models--${model.hfCache.replace('/', '--')}`, 'snapshots');
    for (const snapshot of await fs.readdir(snapshots).catch(() => [])) {
      if (await hasWeights(path.join(snapshots, snapshot))) return path.join(snapshots, snapshot);
    }
    return null;
  }
  const directory = path.join(modelsRoot, model.dir || 'mlx', model.folder);
  return await hasWeights(directory) ? directory : null;
}

/**
 * Whether the weights in `directory` can see images: the config describes a vision tower and the weights
 * have it (a text-only quant of a vision model keeps the config's image tokens but not the tower).
 */
async function hasVision(directory) {
  if (!directory) return false;
  try {
    const config = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
    if (!config.vision_config || typeof config.vision_config !== 'object') return false;
    const isVisionWeight = (name) => /(?:^|\.)(?:vision_tower|visual|vision_model)\./.test(name);
    try {
      const index = JSON.parse(await fs.readFile(path.join(directory, 'model.safetensors.index.json'), 'utf8'));
      return Object.keys(index.weight_map || {}).some(isVisionWeight);
    } catch {
      // One file of weights: its header lists the tensors.
      const handle = await fs.open(path.join(directory, 'model.safetensors'));
      try {
        const head = Buffer.alloc(8);
        await handle.read(head, 0, 8, 0);
        const length = Number(head.readBigUInt64LE(0));
        if (length <= 0 || length > 50_000_000) return false;
        const header = Buffer.alloc(length);
        await handle.read(header, 0, length, 8);
        return Object.keys(JSON.parse(header.toString('utf8'))).some(isVisionWeight);
      } finally { await handle.close(); }
    }
  } catch { return false; }
}

/** Models of our own: every mlx/<folder>/agentic-model.json with an id, a label and weights beside it. */
async function ownModels(modelsRoot, platform = process.platform) {
  const found = [];
  const dir = modelsFolder(platform);
  const root = path.join(modelsRoot, dir);
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(root, entry.name, 'agentic-model.json'), 'utf8'));
      if (typeof meta.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(meta.id) || typeof meta.label !== 'string') continue;
      if (builtInModels.some((model) => model.id === meta.id)) continue;
      found.push({ id: meta.id, label: meta.label.slice(0, 80), modelId: typeof meta.modelId === 'string' ? meta.modelId : meta.id, runtime: engineFor(platform), dir, folder: entry.name, own: true, aliases: [] });
    } catch { /* not one of ours */ }
  }
  return found.sort((a, b) => a.label.localeCompare(b.label));
}

// The newest beta of each base (src/electron/learning-versions.cjs): the base's weights with an adapter.
async function listModels(modelsRoot, platform = process.platform) {
  const { betaModels } = require('./learning-versions.cjs');
  // The built-in models are MLX conversions: a Mac's. On Linux every model is one added from Hugging Face.
  const builtIn = engineFor(platform) === 'mlx' ? builtInModels : [];
  const own = await ownModels(modelsRoot, platform);
  // Betas are trained on the built-in models on a Mac (as always), on the added ones on Linux.
  return [...builtIn, ...await betaModels(engineFor(platform) === 'mlx' ? builtIn : own, modelsRoot), ...own];
}

/** Finds a model by id or alias (e.g. "7b", "gemma"). */
async function findModel(modelsRoot, idOrAlias, platform = process.platform) {
  return (await listModels(modelsRoot, platform)).find((model) => model.id === idOrAlias || model.aliases.includes(idOrAlias)) || null;
}

module.exports = { engineFor, modelsFolder, enginePython, builtInModels, listModels, findModel, modelDirectory, hasVision, DEFAULT_MODEL_ID, defaultModel };
