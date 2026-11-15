import fsSync from 'node:fs';
import path from 'node:path';

/**
 * Log del model: a record of each call to the model, to see what goes in, what comes out and what was
 * measured. It only watches: nothing here changes the messages, the options or the answer, and nothing
 * of it goes to the history or to the training data. It is on only while the panel is open (or for an
 * evaluation started with the panel open).
 */
export type TracePart = { source: string; text: string };
export type TraceContext = { source: string; systemParts?: TracePart[] };
export type TraceToolCall = { name: string; arguments: unknown };
export type LlmCallRecord = {
  type: 'call'; id: string; at: string; source: string; model: string; adapter: string | null;
  params: { temperature: number; topP: number | null; maxTokens: number; stop: string[]; seed: number | null; logprobs: boolean };
  input: { messages: { role: string; content: string; tokens: number | null }[]; parts: (TracePart & { tokens: number | null })[]; tools: string[]; toolTokens: number | null; images: { path: string; bytes: number | null }[]; prompt: string | null; promptTokens: number | null; context: number | null };
  output: { raw: string | null; text: string | null; toolCalls: TraceToolCall[]; answer: string; parseErrors: string[]; finishReason: string | null; error: string | null; tokens?: { t: string; p: number; top: [string, number][] }[] };
  metrics: { loadSeconds: number | null; firstTokenSeconds: number | null; promptTokens: number | null; promptTps: number | null; generationTokens: number | null; generationTps: number | null; peakMemoryGb: number | null; seconds: number | null };
  backend: string | null;
};
export type LlmToolRecord = { type: 'tool'; callId: string; at: string; name: string; arguments: unknown; ok: boolean; ms: number; result: string };
export type LlmTraceEvent = { type: 'start'; id: string; source: string; model: string; at: string } | { type: 'token'; id: string; text: string } | { type: 'call'; call: LlmCallRecord } | { type: 'tool'; tool: LlmToolRecord };

/**
 * The system prompt cut into where each piece came from: the named parts (AGENTS.md, the verified cases,
 * the project's files…) where they are found in it, in order, and the rest is the prompt template's own
 * text. The pieces put together are exactly the system prompt.
 */
export function splitSystem(system: string, named: TracePart[], template: string): TracePart[] {
  const found: { start: number; end: number; source: string }[] = [];
  for (const part of named) {
    const text = part.text?.trim();
    if (!text) continue;
    let from = 0;
    while (from <= system.length) {
      const start = system.indexOf(text, from);
      if (start < 0) break;
      const end = start + text.length;
      if (!found.some((item) => start < item.end && end > item.start)) { found.push({ start, end, source: part.source }); break; }
      from = start + 1;
    }
  }
  found.sort((a, b) => a.start - b.start);
  const pieces: TracePart[] = [];
  let at = 0;
  for (const item of found) {
    if (item.start > at) pieces.push({ source: template, text: system.slice(at, item.start) });
    pieces.push({ source: item.source, text: system.slice(item.start, item.end) });
    at = item.end;
  }
  if (at < system.length) pieces.push({ source: template, text: system.slice(at) });
  return pieces;
}

/**
 * What the app reads in an answer: the tool calls (<tool_call>{json}</tool_call>, the one form the agent
 * reads after the worker's normalising), the calls it could not read, and the text around them.
 */
export function parseOutput(text: string): { toolCalls: TraceToolCall[]; answer: string; parseErrors: string[] } {
  const toolCalls: TraceToolCall[] = [];
  const parseErrors: string[] = [];
  const answer = text.replace(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g, (_match, body: string) => {
    try {
      const value = JSON.parse(body.trim());
      const calls = Array.isArray(value) ? value : [value];
      for (const call of calls) {
        if (call && typeof call.name === 'string') toolCalls.push({ name: call.name, arguments: call.arguments ?? {} });
        else parseErrors.push(`Crida sense nom: ${body.trim().slice(0, 200)}`);
      }
    } catch (error) {
      parseErrors.push(`No és JSON (${error instanceof Error ? error.message : String(error)}): ${body.trim().slice(0, 200)}`);
    }
    return '';
  }).trim();
  return { toolCalls, answer, parseErrors };
}

/** Rotation: past this size the log becomes llm-calls.1.jsonl (the older one is dropped). */
export const LOG_MAX_BYTES = 20 * 1024 * 1024;

export function appendRecord(file: string, record: LlmCallRecord | LlmToolRecord, maxBytes = LOG_MAX_BYTES): void {
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fsSync.statSync(file).size >= maxBytes) fsSync.renameSync(file, file.replace(/\.jsonl$/, '.1.jsonl'));
  } catch { /* no log yet */ }
  fsSync.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/** The switch of the log and where it goes. One per engine; the worker turns it on and off. */
export class LlmTracer {
  enabled: boolean;
  logprobs = false;
  file: string | null;
  onEvent: (event: LlmTraceEvent) => void = () => {};
  lastCallId: string | null = null;
  constructor({ enabled = false, file = null }: { enabled?: boolean; file?: string | null } = {}) {
    this.enabled = enabled;
    this.file = file;
  }
  emit(event: LlmTraceEvent): void {
    try { this.onEvent(event); } catch { /* the log never stops the work */ }
  }
  record(record: LlmCallRecord | LlmToolRecord): void {
    if (this.file) { try { appendRecord(this.file, record); } catch { /* the log never stops the work */ } }
    this.emit(record.type === 'call' ? { type: 'call', call: record } : { type: 'tool', tool: record });
  }
  /** A tool the agent ran after the last call: its result as the app gives it back to the model. */
  tool(name: string, args: unknown, ok: boolean, ms: number, result: unknown): void {
    if (!this.enabled || !this.lastCallId) return;
    const text = typeof result === 'string' ? result : JSON.stringify(result ?? null);
    this.record({ type: 'tool', callId: this.lastCallId, at: new Date().toISOString(), name, arguments: args, ok, ms, result: text.length > 20000 ? `${text.slice(0, 20000)}…` : text });
  }
}
