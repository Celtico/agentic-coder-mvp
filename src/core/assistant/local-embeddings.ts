import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs/promises';

export type EmbeddableExperience = { id: string; prompt: string; answer: string; evidence: string };
export type RankedExperience = EmbeddableExperience & { score: number };
type TensorOutput = { data: Float32Array; dims: number[] };
type FeatureExtractor = (texts: string[], options: { pooling: 'mean'; normalize: true }) => Promise<TensorOutput>;
const EMBEDDING_DIMENSIONS = 384;
const MAX_INDEX_BYTES = 50_000_000;

export function parseEmbeddingIndex(contents: string, modelId: string): Map<string, number[]> {
  if (Buffer.byteLength(contents, 'utf8') > MAX_INDEX_BYTES) return new Map();
  try {
    const value = JSON.parse(contents);
    if (value?.version !== 1 || value?.modelId !== modelId || !value?.embeddings || typeof value.embeddings !== 'object') return new Map();
    return new Map(Object.entries(value.embeddings).slice(0, 10000).flatMap(([id, vector]) =>
      typeof id === 'string' && Array.isArray(vector) && vector.length === EMBEDDING_DIMENSIONS && vector.every((item) => typeof item === 'number' && Number.isFinite(item))
        ? [[id, vector as number[]]] : []));
  } catch { return new Map(); }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return -1;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function rankExperiences(queryVector: number[], values: EmbeddableExperience[], vectors: Map<string, number[]>, minimumScore = 0.2): RankedExperience[] {
  return values.map((value) => ({ ...value, score: cosineSimilarity(queryVector, vectors.get(value.id) || []) }))
    .filter((value) => value.score >= minimumScore)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);
}

/** Independent local semantic search. It is separate from the generative Qwen engine. */
export class LocalExperienceEmbedder {
  private extractor: FeatureExtractor | null = null;
  private loading: Promise<void> | null = null;
  private vectors = new Map<string, number[]>();
  private indexLoaded = false;
  private readonly cacheDir = process.env.AGENT_MODEL_CACHE || path.resolve(__dirname, '../../../models');
  private readonly modelId = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
  private readonly indexPath = process.env.AGENT_EMBEDDING_INDEX_PATH;

  private async load(onStatus: (message: string) => void): Promise<void> {
    if (this.extractor) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      onStatus('Preparant el model local de cerca semàntica…');
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = this.cacheDir;
      env.allowRemoteModels = true;
      const loaded = await pipeline('feature-extraction', this.modelId);
      this.extractor = loaded as unknown as FeatureExtractor;
      onStatus('Model local de cerca semàntica preparat.');
    })();
    try { await this.loading; }
    finally { this.loading = null; }
  }

  async rank(prompt: string, values: EmbeddableExperience[], onStatus: (message: string) => void = () => {}): Promise<RankedExperience[]> {
    if (!values.length) return [];
    await this.load(onStatus);
    await this.loadIndex();
    const extractor = this.extractor;
    if (!extractor) return [];
    const missing = values.filter((value) => !this.vectors.has(value.id));
    for (let offset = 0; offset < missing.length; offset += 24) {
      const batch = missing.slice(offset, offset + 24);
      const output = await extractor(batch.map((value) => value.prompt.slice(0, 1000)), { pooling: 'mean', normalize: true });
      const dimensions = output.dims[1] || 384;
      batch.forEach((value, index) => this.vectors.set(value.id, Array.from(output.data.slice(index * dimensions, (index + 1) * dimensions))));
    }
    if (missing.length) await this.saveIndex(onStatus);
    const query = await extractor([prompt.slice(0, 2000)], { pooling: 'mean', normalize: true });
    const dimensions = query.dims[1] || 384;
    const vector = Array.from(query.data.slice(0, dimensions));
    return rankExperiences(vector, values, this.vectors);
  }

  private async loadIndex(): Promise<void> {
    if (this.indexLoaded) return;
    this.indexLoaded = true;
    if (!this.indexPath) return;
    try {
      const stat = await fs.stat(this.indexPath);
      if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) return;
      this.vectors = parseEmbeddingIndex(await fs.readFile(this.indexPath, 'utf8'), this.modelId);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }

  private async saveIndex(onStatus: (message: string) => void): Promise<void> {
    if (!this.indexPath) return;
    const document = JSON.stringify({ version: 1, modelId: this.modelId, embeddings: Object.fromEntries(this.vectors) });
    if (Buffer.byteLength(document, 'utf8') > MAX_INDEX_BYTES) return;
    const temporaryPath = `${this.indexPath}.${process.pid}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.indexPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(temporaryPath, document, { encoding: 'utf8', mode: 0o600 });
      await fs.chmod(temporaryPath, 0o600);
      await fs.rename(temporaryPath, this.indexPath);
      await fs.chmod(this.indexPath, 0o600);
    } catch {
      try { await fs.rm(temporaryPath, { force: true }); } catch {}
      onStatus('No s’ha pogut desar l’índex semàntic; els vectors d’aquesta sessió només duraran fins que es tanqui l’agent.');
    }
  }
}
