// The model on a Mac without Python: the same job and the same JSON protocol as mlx-worker.py (one request
// per line on stdin; «ready», «token» and «result» on stdout), with the native MLX engine (@celticopetit/mlx-node, through @celticopetit/node-mlx-lm). Run by
// NativeInferenceEngine in a process of its own, so a GPU failure does not take the app with it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const text = require('./native-text.cjs');

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const modelDir = process.argv[2];

let chat;
let loadSeconds;
try {
  // Only one model on the GPU on this Mac at a time (the same lock as mlx_lock.py); kept until this process ends.
  const lockFile = process.env.AGENT_MLX_LOCK || path.join(os.homedir(), '.agentic-coder', 'mlx.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const { addon } = require('@celticopetit/mlx-node');
  addon.lock(lockFile, process.env.AGENT_MLX_LOCK_LABEL || 'model MLX', Number(process.env.AGENT_MLX_LOCK_TIMEOUT || 30));
} catch (error) {
  emit({ type: 'result', error: error.message });
  process.exit(1);
}
const adapterPath = process.env.AGENT_MLX_ADAPTER_PATH || null;
try {
  const started = performance.now();
  const { ChatModel } = require('@celticopetit/node-mlx-lm');
  chat = new ChatModel(modelDir);
  // An optional LoRA adapter goes on top of the base weights, which are never modified.
  if (adapterPath) chat.model.loadAdapters(adapterPath);
  loadSeconds = Math.round((performance.now() - started) / 10) / 100;
} catch (error) {
  emit({ type: 'result', error: `No s’ha pogut carregar MLX: ${error.message}` });
  process.exit(1);
}
emit({ type: 'ready', adapter: adapterPath, loadSeconds });

// Reasoning off unless AGENT_MLX_THINKING=1, as in mlx-worker.py: the template does not open the section
// and its first token is banned, so the model answers directly.
const THINKING = process.env.AGENT_MLX_THINKING === '1';
const tokenId = (token) => chat.tokenizer.token_to_id(token);
const thinkStart = tokenId('<think>') != null && tokenId('</think>') != null ? '<think>' : null;
const thinkEnd = thinkStart ? '</think>' : null;
const ban = !THINKING && thinkStart ? [tokenId(thinkStart)] : [];
// The tool-call format of the model; Qwen 3.5's XML differs from the agent's JSON, so its history goes back
// to it in its own format (mlx_text.native_history).
const parserType = text.toolParserType(modelDir);
const parser = parserType === 'qwen3_coder' ? text.qwen3CoderParser : null;
const nativeFormatDiffers = parserType !== null && !['json_tools', 'qwen3'].includes(parserType);
// Prompt cache limits of the Python worker (LRUPromptCache: 8 entries, AGENT_MLX_PROMPT_CACHE_BYTES or 1 GB).
const cacheBytes = Number(process.env.AGENT_MLX_PROMPT_CACHE_BYTES || 1e9);
const CONTEXT_LIMIT = text.contextLimit(modelDir);

const countTokens = (value) => { try { return chat.encode(value || '').length; } catch { return null; } };
const partCounts = (messages, tools, parts) => ({
  messages: messages.map((message) => countTokens(typeof message.content === 'string' ? message.content : text.pyJson(message.content))),
  tools: tools ? countTokens(text.pyJson(tools)) : 0,
  parts: (parts || []).map(countTokens),
});
const imagePaths = (request) => (Array.isArray(request?.images?.paths) ? request.images.paths : []).filter((file) => typeof file === 'string' && fs.existsSync(file));

function generate(request, messages, tools, onPiece) {
  const prompt = chat.prompt(messages, { tools: tools ?? undefined, enable_thinking: THINKING });
  const ids = chat.encode(prompt);
  const maxTokens = Number(request.max_tokens ?? 700);
  const started = performance.now();
  let first = null;
  let answer = '';
  let repeating = false;
  let checked = 0;
  for (const piece of chat.streamIds(ids, { maxTokens, temperature: Number(request.temperature ?? 0), ban, cache: cacheBytes > 0, cacheBytes })) {
    if (first === null) first = performance.now();
    answer += piece;
    onPiece(piece);
    // Stuck repeating the same text: stop here (checked every 64 new characters).
    if (answer.length - checked >= 64) {
      checked = answer.length;
      if (text.repeatingTail(answer)) { repeating = true; break; }
    }
  }
  const end = performance.now();
  const stats = chat.model.lastPrompt || { reused: 0, total: ids.length };
  const generated = chat.model.lastGenerated ?? null;
  return { prompt, answer, ids, stats, generated, maxTokens, started, first, end, repeating };
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  try {
    const request = JSON.parse(line);
    let messages = request.messages || [];
    if (nativeFormatDiffers) messages = text.nativeHistory(messages);
    const tools = request.tools || null;
    // Only models without vision run here (the app keeps the Python worker for those), as mlx_vision.choose_backend says.
    if (imagePaths(request).length) { emit({ type: 'result', error: 'Aquest model no pot veure imatges: tria un model amb visió.' }); return; }
    const trace = Boolean(request.trace);
    // The text as it comes, always: the chat shows it while the model writes (and the Model log when it is open).
    const run = generate(request, messages, tools, (piece) => emit({ type: 'token', text: piece }));
    const result = text.normalizeToolCalls(text.stripThinking(run.answer, thinkStart, thinkEnd), tools, '<tool_call>', '</tool_call>', parser).trim();
    // «length» when the answer was cut at max_tokens, as mlx-worker.py says, so the agent does not act on half an answer.
    // «repetition» when it was stopped for repeating the same text (mlx_text.repeating_tail).
    const finishReason = run.repeating ? 'repetition' : run.generated !== null && run.generated >= run.maxTokens ? 'length' : 'stop';
    if (!trace) { emit({ type: 'result', text: result, finishReason }); return; }
    const firstSeconds = run.first === null ? null : (run.first - run.started) / 1000;
    const generationTokens = run.generated ?? null;
    const round = (value, digits = 2) => (value === null || !Number.isFinite(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits);
    emit({
      type: 'result', text: result, finishReason,
      trace: {
        promptTokens: run.stats.total, cachedTokens: run.stats.reused,
        promptTps: firstSeconds ? round((run.stats.total - run.stats.reused) / firstSeconds) : null,
        generationTokens, generationTps: generationTokens && run.first !== null && run.end > run.first ? round((generationTokens - 1) / ((run.end - run.first) / 1000)) : null,
        peakMemoryGb: round(chat.model.memory().peak / 1e9, 3),
        finishReason,
        seconds: round((run.end - run.started) / 1000, 3), firstTokenSeconds: round(firstSeconds, 3),
        prompt: run.prompt, raw: run.answer, backend: 'native', context: CONTEXT_LIMIT,
        counts: partCounts(messages, tools, request.trace_parts),
      },
    });
  } catch (error) {
    emit({ type: 'result', error: `Error generant amb MLX: ${error.message}` });
  }
});
