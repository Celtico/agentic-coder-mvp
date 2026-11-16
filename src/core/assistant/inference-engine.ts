import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import fsSync from 'node:fs';
import { LlmTracer, parseOutput, type LlmCallRecord, type TraceContext } from './llm-trace';

export type ChatRole = 'system' | 'user' | 'assistant';
export type ChatTurn = { role: ChatRole; content: string };
export type InferenceToolDefinition = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
/** `images`: files to show the model with the message at index `message` (a model with vision only). */
export type GenerationOptions = { max_new_tokens: number; temperature: number; do_sample: boolean; tools?: InferenceToolDefinition[]; images?: { paths: string[]; message: number } };
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
  /** The Python worker it starts and the name the window shows: MLX on a Mac; CudaInferenceEngine on Linux. */
  protected readonly workerScript: string = 'mlx-worker.py';
  protected readonly runtimeName: string = 'MLX';
  readonly cacheDir = process.env.AGENT_MODEL_CACHE || path.resolve(__dirname, '../../../models/.hf');
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private pending: { resolve: (value: string) => void; reject: (error: Error) => void } | null = null;
  private state: ModelStatus['state'] = 'unloaded';
  private memory: MemoryUsage = { residentBytes: 0, heapBytes: 0, externalBytes: 0 };
  /** Log del model (src/core/assistant/llm-trace.ts): off unless the panel is open or AGENT_LLM_TRACE=1. */
  readonly tracer = new LlmTracer({ enabled: process.env.AGENT_LLM_TRACE === '1', file: process.env.AGENT_LLM_CALLS_LOG || null });
  /** Who is asking (the chat, the reviewer, an evaluation…) and the parts of its system prompt; set by the agent. */
  traceContext: TraceContext = { source: process.env.AGENT_LLM_TRACE_SOURCE || 'xat' };
  private loadSeconds: number | null = null;
  private traced: { id: string; at: string; started: number; messages: ChatTurn[]; options: GenerationOptions; context: TraceContext } | null = null;

  async loadModel(onStatus: (message: string) => void = () => {}): Promise<void> {
    if (this.state === 'ready') return;
    if (this.ready) return this.ready;
    this.state = 'loading';
    this.ready = new Promise<void>((resolve, reject) => {
      const modelPath = process.env.AGENT_MLX_MODEL_PATH;
      const command = modelPath ? this.workerCommand(modelPath) : null;
      if (!command) { reject(new Error(`No s’ha configurat el runtime ${this.runtimeName} ni la carpeta del model.`)); return; }
      onStatus(this.runtimeName === 'MLX' ? 'Iniciant el runtime MLX d’Apple…' : `Iniciant el runtime ${this.runtimeName}…`);
      const child = spawn(command.file, command.args, { stdio: ['pipe', 'pipe', 'pipe'], env: command.env });
      this.child = child;
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
      const lines = readline.createInterface({ input: child.stdout });
      // A process that was stopped (to cancel, or after a timeout) may still report its exit or a late
      // result while a new one is loading; only the current process may change the engine's state.
      const current = () => this.child === child;
      lines.on('line', (line) => {
        if (!current()) return;
        let message: Record<string, unknown>;
        try { message = JSON.parse(line); } catch { return; }
        // An error before «ready» (no runtime, the model already loaded elsewhere…) is the reason it did not load.
        if (message.type === 'result' && typeof message.error === 'string' && this.state === 'loading') { reject(new Error(message.error)); return; }
        if (message.type === 'token' && this.traced && typeof message.text === 'string') { this.tracer.emit({ type: 'token', id: this.traced.id, text: message.text }); return; }
        if (message.type === 'ready') { this.loadSeconds = typeof message.loadSeconds === 'number' ? message.loadSeconds : null; this.state = 'ready'; onStatus(`${this.modelId} carregat amb ${this.runtimeName}${message.adapter ? ' (amb adaptador)' : ''}.`); resolve(); return; }
        if (message.type === 'result' && this.pending) {
          const pending = this.pending; this.pending = null;
          this.finishTrace(message);
          if (typeof message.error === 'string') pending.reject(new Error(message.error));
          else pending.resolve(String(message.text || 'No s’ha generat cap resposta.'));
        }
      });
      child.once('error', (error) => { if (current()) this.state = 'unloaded'; reject(new Error(`No s’ha pogut iniciar el runtime ${this.runtimeName}: ${error.message}`)); });
      child.once('exit', (code) => {
        if (!current()) { reject(new Error(`S’ha aturat el runtime ${this.runtimeName}.`)); return; }
        const wasReady = this.state === 'ready';
        this.state = 'unloaded'; this.child = null;
        const error = new Error(`El procés ${this.runtimeName} s’ha aturat (${code ?? 'sense codi'}). ${stderr.trim()}`);
        if (!wasReady) reject(error);
        this.pending?.reject(error); this.pending = null;
      });
      // «The first time» only the first time in this app session; a model that was unloaded (for the
      // dictation, a training…) is loaded again (src/electron/main.cjs, AGENT_MODEL_RELOAD).
      onStatus(process.env.AGENT_MODEL_RELOAD === '1'
        ? `Carregant ${this.modelId}…`
        : `Carregant ${this.modelId} a la memòria unificada; la primera vegada pot trigar fins a mig minut…`);
    }).catch((error) => { this.state = 'unloaded'; throw error; }).finally(() => { this.ready = null; });
    return this.ready;
  }

  /** The worker process: the runtime's Python with the worker script and the model folder. */
  protected workerCommand(modelPath: string): { file: string; args: string[]; env: NodeJS.ProcessEnv } | null {
    const python = process.env.AGENT_MLX_PYTHON;
    return python ? { file: python, args: ['-u', path.join(__dirname, this.workerScript), modelPath], env: process.env } : null;
  }

  async generateResponse(messages: ChatTurn[], options: GenerationOptions): Promise<string> {
    if (!this.child || this.state !== 'ready') throw new Error(`El model ${this.runtimeName} encara no està carregat.`);
    if (this.pending) throw new Error(`El runtime ${this.runtimeName} ja està generant una resposta.`);
    // Log del model: only with the panel open; otherwise the request is exactly as it always was.
    const traceFields = this.startTrace(messages, options);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.child!.stdin.write(`${JSON.stringify({ messages, tools: options.tools, max_tokens: options.max_new_tokens, temperature: options.do_sample ? options.temperature : 0, ...(options.images?.paths.length ? { images: options.images } : {}), ...traceFields })}\n`, (error) => {
        if (!error) return;
        this.pending = null; reject(error);
      });
    });
  }

  private startTrace(messages: ChatTurn[], options: GenerationOptions): Record<string, unknown> {
    this.traced = null;
    if (!this.tracer.enabled) return {};
    const context = this.traceContext;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.traced = { id, at: new Date().toISOString(), started: Date.now(), messages: messages.map((message) => ({ ...message })), options, context };
    this.tracer.lastCallId = id;
    this.tracer.emit({ type: 'start', id, source: context.source, model: this.modelId, at: this.traced.at });
    return { trace: true, ...(this.tracer.logprobs ? { logprobs: true } : {}), trace_parts: (context.systemParts || []).map((part) => part.text) };
  }

  private finishTrace(message: Record<string, unknown>): void {
    const traced = this.traced;
    this.traced = null;
    if (!traced) return;
    const trace = (message.trace && typeof message.trace === 'object' ? message.trace : {}) as Record<string, any>;
    const counts = (trace.counts || {}) as { messages?: (number | null)[]; tools?: number | null; parts?: (number | null)[] };
    const text = typeof message.text === 'string' ? message.text : null;
    const parsed = parseOutput(text || '');
    const size = (file: string) => { try { return fsSync.statSync(file).size; } catch { return null; } };
    const record: LlmCallRecord = {
      type: 'call', id: traced.id, at: traced.at, source: traced.context.source, model: this.modelId, adapter: process.env.AGENT_MLX_ADAPTER_PATH || null,
      params: { temperature: traced.options.do_sample ? traced.options.temperature : 0, topP: null, maxTokens: traced.options.max_new_tokens, stop: [], seed: null, logprobs: this.tracer.logprobs },
      input: {
        messages: traced.messages.map((item, index) => ({ role: item.role, content: item.content, tokens: counts.messages?.[index] ?? null })),
        parts: (traced.context.systemParts || []).map((part, index) => ({ ...part, tokens: counts.parts?.[index] ?? null })),
        tools: (traced.options.tools || []).map((tool) => tool.function.name), toolTokens: counts.tools ?? null,
        images: (traced.options.images?.paths || []).map((file) => ({ path: file, bytes: size(file) })),
        prompt: typeof trace.prompt === 'string' ? trace.prompt : null, promptTokens: trace.promptTokens ?? null, context: trace.context ?? null,
      },
      output: { raw: typeof trace.raw === 'string' ? trace.raw : null, text, ...parsed, finishReason: trace.finishReason ?? null, error: typeof message.error === 'string' ? message.error : null, ...(Array.isArray(trace.tokens) ? { tokens: trace.tokens } : {}) },
      metrics: { loadSeconds: this.loadSeconds, firstTokenSeconds: trace.firstTokenSeconds ?? null, promptTokens: trace.promptTokens ?? null, cachedTokens: trace.cachedTokens ?? null, promptTps: trace.promptTps ?? null, generationTokens: trace.generationTokens ?? null, generationTps: trace.generationTps ?? null, peakMemoryGb: trace.peakMemoryGb ?? null, seconds: trace.seconds ?? (Date.now() - traced.started) / 1000 },
      backend: trace.backend ?? null,
    };
    // The load time goes with the first call after the model was loaded.
    this.loadSeconds = null;
    this.tracer.record(record);
  }

  async unloadModel(): Promise<void> {
    const child = this.child; this.child = null; this.state = 'unloaded';
    this.pending?.reject(new Error(`S’ha aturat el runtime ${this.runtimeName}.`));
    this.pending = null;
    if (child && !child.killed) child.kill('SIGTERM');
  }
  getModelStatus(): ModelStatus { return { modelId: this.modelId, state: this.state, cacheDir: this.cacheDir }; }
  getMemoryUsage(): MemoryUsage { return this.memory; }
}

/**
 * Linux with NVIDIA GPUs: the same engine with cuda-worker.py (PyTorch + transformers, 4-bit, every GPU),
 * the same JSON protocol, tool-call reading and Log del model. Chosen with AGENT_MODEL_RUNTIME=cuda.
 */
export class CudaInferenceEngine extends MlxInferenceEngine {
  protected readonly workerScript = 'cuda-worker.py';
  protected readonly runtimeName = 'CUDA';
}

/**
 * A Mac without Python: the same engine with native-worker.cjs (the native MLX engine in native/, run by this
 * Node or Electron binary as Node), the same JSON protocol, tool-call reading and Log del model. Chosen with
 * AGENT_MODEL_RUNTIME=native, for the models it supports (src/electron/mlx-models.cjs, runtimeFor).
 */
export class NativeInferenceEngine extends MlxInferenceEngine {
  protected readonly workerScript = 'native-worker.cjs';
  protected readonly runtimeName = 'MLX natiu';
  protected workerCommand(modelPath: string) {
    return { file: process.execPath, args: [path.join(__dirname, this.workerScript), modelPath], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
  }
}

export class TransformersJsInferenceEngine implements InferenceEngine {
  readonly modelId: string;
  readonly cacheDir: string;
  readonly modelPath: string;
  private generator: TextGenerationPipeline | null = null;
  private loading: Promise<void> | null = null;
  private state: ModelStatus['state'] = 'unloaded';

  constructor(modelId = process.env.AGENT_MODEL || '') {
    this.modelId = modelId;
    this.cacheDir = process.env.AGENT_MODEL_CACHE || path.resolve(__dirname, '../../../models');
    this.modelPath = process.env.AGENT_MODEL_PATH || path.resolve(this.cacheDir, modelId);
  }

  async loadModel(onStatus: (message: string) => void = () => {}): Promise<void> {
    if (this.generator) return;
    if (this.loading) return this.loading;
    this.state = 'loading';
    this.loading = (async () => {
      onStatus(`Carregant el model local ${this.modelId}; la primera vegada pot trigar fins a mig minut…`);
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
