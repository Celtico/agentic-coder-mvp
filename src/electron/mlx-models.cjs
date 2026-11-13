// The local MLX models the app can offer, and where their weights live under the models folder.
// Shared by the app (src/electron/main.cjs) and the benchmark (scripts/evaluate-agent.cjs).
//
// - A model downloaded through the Hugging Face cache lives in .hf/hub/models--<org>--<name>/snapshots/<rev>.
// - Any other model has its own folder: mlx/<folder>.
// - A model of our own (trained here) is a folder mlx/<folder> with an agentic-model.json next to its
//   weights: {"id", "label", "modelId", ...}. It is listed without any change to this file.
const fs = require('node:fs/promises');
const path = require('node:path');

const builtInModels = [
  { id: 'qwen-7b-mlx', label: 'Qwen2.5-Coder 7B · MLX', modelId: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit', runtime: 'mlx', hfCache: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit', aliases: ['7b'] },
  { id: 'gemma-4-12b-mlx', label: 'Gemma 4 12B · MLX', modelId: 'lmstudio-community/gemma-4-12B-it-MLX-4bit', runtime: 'mlx', folder: 'gemma-4-12b-it-4bit', aliases: ['gemma', 'gemma-4-12b'] },
  { id: 'mimo-9b-mlx', label: 'MiMo V2.6 9B · MLX', modelId: 'mlx-community/MiMo-V2.6-Distill-Qwen-9B-OptiQ-4bit', runtime: 'mlx', folder: 'mimo-v2.6-distill-qwen-9b-4bit', aliases: ['mimo', 'mimo-9b'] },
];

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
  const directory = path.join(modelsRoot, 'mlx', model.folder);
  return await hasWeights(directory) ? directory : null;
}

/** Models of our own: every mlx/<folder>/agentic-model.json with an id, a label and weights beside it. */
async function ownModels(modelsRoot) {
  const found = [];
  const root = path.join(modelsRoot, 'mlx');
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(root, entry.name, 'agentic-model.json'), 'utf8'));
      if (typeof meta.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(meta.id) || typeof meta.label !== 'string') continue;
      if (builtInModels.some((model) => model.id === meta.id)) continue;
      found.push({ id: meta.id, label: meta.label.slice(0, 80), modelId: typeof meta.modelId === 'string' ? meta.modelId : meta.id, runtime: 'mlx', folder: entry.name, own: true, aliases: [] });
    } catch { /* not one of ours */ }
  }
  return found.sort((a, b) => a.label.localeCompare(b.label));
}

async function listModels(modelsRoot) {
  return [...builtInModels, ...await ownModels(modelsRoot)];
}

/** Finds a model by id or alias (e.g. "7b", "gemma"). */
async function findModel(modelsRoot, idOrAlias) {
  return (await listModels(modelsRoot)).find((model) => model.id === idOrAlias || model.aliases.includes(idOrAlias)) || null;
}

module.exports = { builtInModels, listModels, findModel, modelDirectory };
