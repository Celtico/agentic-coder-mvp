import path from 'node:path';
import process from 'node:process';

export type EmbeddableExperience = { id: string; prompt: string; answer: string; evidence: string };
export type RankedExperience = EmbeddableExperience & { score: number };
type TensorOutput = { data: Float32Array; dims: number[] };
type FeatureExtractor = (texts: string[], options: { pooling: 'mean'; normalize: true }) => Promise<TensorOutput>;

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

export function rankExperiences(queryVector: number[], values: EmbeddableExperience[], vectors: Map<string, number[]>, minimumScore = 0.25): RankedExperience[] {
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
  private readonly cacheDir = process.env.AGENT_MODEL_CACHE || path.resolve(__dirname, '../../../models');
  private readonly modelId = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

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
    const extractor = this.extractor;
    if (!extractor) return [];
    const missing = values.filter((value) => !this.vectors.has(value.id));
    for (let offset = 0; offset < missing.length; offset += 24) {
      const batch = missing.slice(offset, offset + 24);
      const output = await extractor(batch.map((value) => value.prompt.slice(0, 1000)), { pooling: 'mean', normalize: true });
      const dimensions = output.dims[1] || 384;
      batch.forEach((value, index) => this.vectors.set(value.id, Array.from(output.data.slice(index * dimensions, (index + 1) * dimensions))));
    }
    const query = await extractor([prompt.slice(0, 2000)], { pooling: 'mean', normalize: true });
    const dimensions = query.dims[1] || 384;
    const vector = Array.from(query.data.slice(0, dimensions));
    const liveIds = new Set(values.map((value) => value.id));
    for (const id of this.vectors.keys()) if (!liveIds.has(id)) this.vectors.delete(id);
    return rankExperiences(vector, values, this.vectors);
  }
}
