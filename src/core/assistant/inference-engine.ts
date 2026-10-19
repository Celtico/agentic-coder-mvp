import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

export type ChatRole = 'system' | 'user' | 'assistant';
export type ChatTurn = { role: ChatRole; content: string };
export type InferenceToolDefinition = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type GenerationOptions = { max_new_tokens: number; temperature: number; do_sample: boolean; tools?: InferenceToolDefinition[] };
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

/** Native Apple Silicon backend. It keeps one MLX Python process alive for the whole chat task. */
export class MlxInferenceEngine implements InferenceEngine {
  readonly modelId = process.env.AGENT_MODEL || 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit';
  readonly cacheDir = process.env.AGENT_MODEL_CACHE || path.resolve(__dirname, '../../../models/.hf');
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending: { resolve: (value: string) => void; reject: (error: Error) => void } | null = null;
  private state: ModelStatus['state'] = 'unloaded';
  private memory: MemoryUsage = { residentBytes: 0, heapBytes: 0, externalBytes: 0 };

  async loadModel(onStatus: (message: string) => void = () => {}): Promise<void> {
    if (this.state === 'ready') return;
    if (this.ready) return this.ready;
    this.state = 'loading';
    this.ready = new Promise<void>((resolve, reject) => {
      const python = process.env.AGENT_MLX_PYTHON;
      const modelPath = process.env.AGENT_MLX_MODEL_PATH;
      if (!python || !modelPath) { reject(new Error('No s’ha configurat el runtime MLX ni la carpeta del model.')); return; }
      onStatus('Iniciant el runtime MLX d’Apple…');
      const child = spawn(python, ['-u', path.join(__dirname, 'mlx-worker.py'), modelPath], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
      this.child = child;
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        let message: Record<string, unknown>;
        try { message = JSON.parse(line); } catch { return; }
        if (message.type === 'ready') { this.state = 'ready'; onStatus('Qwen2.5-Coder 7B carregat amb MLX.'); resolve(); return; }
        if (message.type === 'result' && this.pending) {
          const pending = this.pending; this.pending = null;
          if (typeof message.error === 'string') pending.reject(new Error(message.error));
          else pending.resolve(String(message.text || 'No s’ha generat cap resposta.'));
        }
      });
      child.once('error', (error) => { this.state = 'unloaded'; reject(new Error(`No s’ha pogut iniciar Python/MLX: ${error.message}`)); });
      child.once('exit', (code) => {
        const wasReady = this.state === 'ready';
        this.state = 'unloaded'; this.child = null;
        const error = new Error(`El procés MLX s’ha aturat (${code ?? 'sense codi'}). ${stderr.trim()}`);
        if (!wasReady) reject(error);
        this.pending?.reject(error); this.pending = null;
      });
      onStatus('Carregant Qwen2.5-Coder 7B a la memòria unificada…');
    }).catch((error) => { this.state = 'unloaded'; throw error; }).finally(() => { this.ready = null; });
    return this.ready;
  }

  async generateResponse(messages: ChatTurn[], options: GenerationOptions): Promise<string> {
    if (!this.child || this.state !== 'ready') throw new Error('El model MLX encara no està carregat.');
    if (this.pending) throw new Error('El runtime MLX ja està generant una resposta.');
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.child!.stdin.write(`${JSON.stringify({ messages, tools: options.tools, max_tokens: options.max_new_tokens, temperature: options.do_sample ? options.temperature : 0 })}\n`, (error) => {
        if (!error) return;
        this.pending = null; reject(error);
      });
    });
  }

  async unloadModel(): Promise<void> {
    const child = this.child; this.child = null; this.state = 'unloaded';
    this.pending?.reject(new Error('S’ha aturat el runtime MLX.'));
    this.pending = null;
    if (child && !child.killed) child.kill('SIGTERM');
  }
  getModelStatus(): ModelStatus { return { modelId: this.modelId, state: this.state, cacheDir: this.cacheDir }; }
  getMemoryUsage(): MemoryUsage { return this.memory; }
}

export class TransformersJsInferenceEngine implements InferenceEngine {
  readonly modelId: string;
  readonly cacheDir: string;
  readonly modelPath: string;
  private generator: TextGenerationPipeline | null = null;
  private loading: Promise<void> | null = null;
  private state: ModelStatus['state'] = 'unloaded';

  constructor(modelId = process.env.AGENT_MODEL || 'onnx-community/Qwen2.5-Coder-1.5B-Instruct') {
    this.modelId = modelId;
    this.cacheDir = process.env.AGENT_MODEL_CACHE || path.resolve(__dirname, '../../../models');
    this.modelPath = process.env.AGENT_MODEL_PATH || path.resolve(this.cacheDir, 'onnx-community/Qwen2.5-Coder-1.5B-Instruct');
  }

  async loadModel(onStatus: (message: string) => void = () => {}): Promise<void> {
    if (this.generator) return;
    if (this.loading) return this.loading;
    this.state = 'loading';
    this.loading = (async () => {
      onStatus(`Carregant el model local ${this.modelId}…`);
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = this.cacheDir;
      env.allowRemoteModels = false;
      try {
        await fs.access(path.join(this.modelPath, 'config.json'));
        await fs.access(path.join(this.modelPath, 'onnx', 'model_q4.onnx'));
      } catch {
        throw new Error(`No s’ha trobat el model local complet a ${this.modelPath}.`);
      }
      const loaded = await pipeline('text-generation', this.modelPath, { dtype: 'q4' });
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
    const output = await this.generator(messages, { max_new_tokens: options.max_new_tokens, temperature: options.temperature, do_sample: options.do_sample });
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
