import path from 'node:path';
import process from 'node:process';

export type ChatRole = 'system' | 'user' | 'assistant';
export type ChatTurn = { role: ChatRole; content: string };
export type GenerationOptions = { max_new_tokens: number; temperature: number; do_sample: boolean };
export type ModelStatus = { modelId: string; state: 'unloaded' | 'loading' | 'ready'; cacheDir: string };
export type MemoryUsage = { residentBytes: number; heapBytes: number; externalBytes: number };

type GeneratedMessage = { role?: string; content?: string };
type GeneratedItem = { generated_text?: string | GeneratedMessage[] };
type TextGenerationPipeline = ((
  messages: ChatTurn[],
  options: GenerationOptions,
) => Promise<GeneratedItem[]>) & { dispose?: () => Promise<void> | void };

/** Stable app-facing contract. Implementations can change without coupling the orchestrator to a runtime. */
export interface InferenceEngine {
  loadModel(onStatus?: (message: string) => void): Promise<void>;
  generateResponse(messages: ChatTurn[], options: GenerationOptions): Promise<string>;
  unloadModel(): Promise<void>;
  getModelStatus(): ModelStatus;
  getMemoryUsage(): MemoryUsage;
}

declare const __dirname: string;

export class TransformersJsInferenceEngine implements InferenceEngine {
  readonly modelId: string;
  readonly cacheDir: string;
  private generator: TextGenerationPipeline | null = null;
  private loading: Promise<void> | null = null;
  private state: ModelStatus['state'] = 'unloaded';

  constructor(modelId = process.env.AGENT_MODEL || 'onnx-community/Qwen2.5-Coder-1.5B-Instruct') {
    this.modelId = modelId;
    this.cacheDir = process.env.AGENT_MODEL_CACHE || path.resolve(__dirname, '../../../models');
  }

  async loadModel(onStatus: (message: string) => void = () => {}): Promise<void> {
    if (this.generator) return;
    if (this.loading) return this.loading;
    this.state = 'loading';
    this.loading = (async () => {
      onStatus(`Carregant model local: ${this.modelId}. La primera execució descarrega els pesos.`);
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = this.cacheDir;
      const loaded = await pipeline('text-generation', this.modelId, { dtype: 'q4' });
      this.generator = loaded as unknown as TextGenerationPipeline;
      this.state = 'ready';
      onStatus('Model local carregat.');
    })();
    try {
      await this.loading;
    } catch (error) {
      this.state = 'unloaded';
      throw error;
    } finally {
      this.loading = null;
    }
  }

  async generateResponse(messages: ChatTurn[], options: GenerationOptions): Promise<string> {
    if (!this.generator) throw new Error('El model local encara no està carregat.');
    const output = await this.generator(messages, options);
    const generated = output?.[0]?.generated_text;
    if (Array.isArray(generated)) {
      const response = [...generated].reverse().find((item) => item.role === 'assistant')?.content;
      return response || 'No s’ha generat cap resposta.';
    }
    return String(generated || 'No s’ha generat cap resposta.');
  }

  async unloadModel(): Promise<void> {
    if (this.loading) await this.loading.catch(() => {});
    await this.generator?.dispose?.();
    this.generator = null;
    this.state = 'unloaded';
  }

  getModelStatus(): ModelStatus {
    return { modelId: this.modelId, state: this.state, cacheDir: this.cacheDir };
  }

  getMemoryUsage(): MemoryUsage {
    const memory = process.memoryUsage();
    return { residentBytes: memory.rss, heapBytes: memory.heapUsed, externalBytes: memory.external };
  }
}
