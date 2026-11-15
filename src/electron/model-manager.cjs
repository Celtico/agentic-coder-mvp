// Aprenentatge local › Gestiona els models: what is on this Mac (chat models, dictation models, betas),
// what may be removed and why not, and adding a model from Hugging Face.
//
// - A model added here is a folder mlx/<slug> with an agentic-model.json beside its weights: the same
//   registry the selector already reads (src/electron/mlx-models.cjs, ownModels). Nothing is hard-coded.
// - Removing moves the folder to the macOS Trash (main.cjs, shell.trashItem); it is never deleted here.
// - Nothing here loads a model: sizes come from the disk and the check of a repository from its listing.
const fs = require('node:fs/promises');
const path = require('node:path');

/** Hugging Face repository ids: «org/name». */
const REPO_ID = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;
const validRepoId = (repo) => typeof repo === 'string' && REPO_ID.test(repo.trim()) && !repo.includes('..');

/** The folder (and the id) of a model added from `repo`: its name, lower case, safe as a folder name. */
function slugFor(repo) {
  const name = String(repo).split('/').pop().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '');
  return name.slice(0, 80) || 'model';
}

// A 16 GB Mac: the weights have to fit in the GPU's share of memory with room for the answer.
const MAX_MODEL_BYTES = 12_000_000_000;
// What a model needs to be loaded with MLX; nothing that runs code (no *.py).
const DOWNLOAD_PATTERNS = ['*.json', '*.safetensors', '*.txt', '*.model', '*.jinja', '*.tiktoken'];

/**
 * Whether a Hugging Face repository (its listing from /api/models/<repo>?blobs=true) is a model this app
 * can load: MLX weights (safetensors and a config), a chat model (not speech), and small enough.
 * Returns { ok, problem, bytes, vision }.
 */
function checkRepository(info, repo) {
  if (!info || typeof info !== 'object' || !Array.isArray(info.siblings)) return { ok: false, problem: 'No s’ha trobat aquest model a Hugging Face.' };
  const files = info.siblings.filter((file) => typeof file?.rfilename === 'string');
  const names = files.map((file) => file.rfilename);
  if (!names.includes('config.json') || !names.some((name) => name.endsWith('.safetensors'))) return { ok: false, problem: 'No té els pesos en safetensors amb el seu config.json: no es pot carregar amb MLX.' };
  const tags = Array.isArray(info.tags) ? info.tags.map(String) : [];
  const mlx = info.library_name === 'mlx' || tags.includes('mlx') || /mlx/i.test(repo);
  if (!mlx) return { ok: false, problem: 'No és un model MLX. Busca’n la versió MLX (per exemple a mlx-community).' };
  if (info.pipeline_tag === 'automatic-speech-recognition' || /whisper/i.test(repo)) return { ok: false, problem: 'És un model de dictat: els de dictat es trien a Preferències › Agent › Dictat.' };
  const bytes = downloadBytes(info);
  if (bytes > MAX_MODEL_BYTES) return { ok: false, problem: `Ocupa ${formatBytes(bytes)}: no hi cap a la memòria d’aquest Mac.`, bytes };
  // The listing tells it apart by its processor files or its task; once downloaded the weights decide (hasVision).
  const vision = names.some((name) => /^(preprocessor|processor)_config\.json$/.test(name)) || info.pipeline_tag === 'image-text-to-text' || tags.includes('image-text-to-text');
  return { ok: true, bytes, vision };
}

/** What a download of the repository takes: the files the patterns let through. */
function downloadBytes(info) {
  return (info?.siblings || []).filter((file) => typeof file?.rfilename === 'string' && DOWNLOAD_PATTERNS.some((pattern) => file.rfilename.endsWith(pattern.slice(1)))).reduce((sum, file) => sum + (Number(file.size) || 0), 0);
}

const formatBytes = (bytes) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1).replace('.', ',')} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;

/** The bytes a folder takes on disk (links counted as links, so a Hugging Face cache counts each blob once). */
async function folderBytes(directory) {
  let total = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await folderBytes(item);
    else total += (await fs.lstat(item).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/**
 * Why a model cannot be removed now, or null when it can. `state`: the model chosen in the chat
 * (`selectedId`), the one loaded now (`loadedId`), the app's default (`defaultId`), the bases with betas
 * (`betaBases`), the models an evaluation or a training is using (`busyIds`) and the dictation model
 * Whisper has loaded (`dictationLoadedId`).
 */
function removalBlock(row, state) {
  if (!row.installed) return 'No és en aquest Mac.';
  if (state.busyIds?.has(row.id)) return 'L’està fent servir una avaluació o un entrenament.';
  if (row.kind === 'dictat') return state.dictationLoadedId === row.id ? 'El dictat el té carregat ara; torna-ho a provar d’aquí a uns minuts.' : null;
  if (state.loadedId === row.id) return 'Està carregat ara al xat.';
  if (state.selectedId === row.id) return 'És el model triat al xat: tria’n un altre primer.';
  if (row.kind === 'beta') return null;
  if (state.defaultId === row.id) return 'És el model per defecte de l’app.';
  if (state.betaBases?.has(row.id)) return 'Hi ha betes entrenades sobre aquest model: treu-les primer.';
  return null;
}

/** Where a newly added model goes, and its registry entry (read by mlx-models.cjs, ownModels). */
function addedModel({ repo, label, modelsRoot }) {
  const slug = slugFor(repo);
  return {
    directory: path.join(modelsRoot, 'mlx', slug),
    partial: path.join(modelsRoot, 'mlx', `.${slug}.partial`),
    meta: { id: `hf-${slug}`, label: String(label || '').trim().slice(0, 80) || repo.split('/').pop(), modelId: repo, source: 'huggingface' },
  };
}

/**
 * Whether a chat model is offered in the chat's selector: what was chosen with its switch, or by default
 * every model except the betas that are not the newest of their base. The chosen model is always offered.
 */
function shownInSelector(model, visibility = {}, selectedId = null) {
  if (model.id === selectedId) return true;
  if (typeof visibility[model.id] === 'boolean') return visibility[model.id];
  return !(model.beta && !model.latest);
}

/** Cleans saved switches: only ids to booleans. */
function normalizeVisibility(value) {
  const clean = {};
  if (value && typeof value === 'object') for (const [id, shown] of Object.entries(value)) if (typeof shown === 'boolean' && id.length <= 200) clean[id] = shown;
  return clean;
}

/**
 * Turns a model's switch on or off. Refused for the model chosen in the chat and for the last model the
 * selector would still offer. `models`: the chat models on this Mac. Returns the new switches.
 */
function setShown(visibility, id, shown, { selectedId, models }) {
  if (!models.some((model) => model.id === id)) throw new Error('Aquest model no és en aquest Mac.');
  if (!shown && id === selectedId) throw new Error('És el model triat al xat: tria’n un altre abans d’amagar-lo.');
  const next = { ...visibility, [id]: Boolean(shown) };
  if (!models.some((model) => shownInSelector(model, next, selectedId))) throw new Error('Al selector hi ha de quedar almenys un model.');
  return next;
}

module.exports = { shownInSelector, normalizeVisibility, setShown, validRepoId, slugFor, checkRepository, downloadBytes, folderBytes, removalBlock, addedModel, formatBytes, MAX_MODEL_BYTES, DOWNLOAD_PATTERNS };
