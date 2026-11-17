// Text handling of the native worker (native-worker.cjs), without a model: the same as mlx_text.py and
// mlx_lm's qwen3_coder tool parser do for the Python worker, so both engines give the agent the same text.
const fs = require('node:fs');
const path = require('node:path');

/** json.dumps(value, ensure_ascii=False): Python's separators, so the text is the Python worker's. */
function pyJson(value) {
  if (Array.isArray(value)) return `[${value.map(pyJson).join(', ')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pyJson(item)}`).join(', ')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

// A model that repeats one piece of text over and over (greedy decoding can get stuck: «Dades de prova» hundreds of
// times inside a file, 16-11-2026) is stopped: the end of its answer is one chunk repeated at least
// REPEAT_MIN_COUNT times in a row, over at least REPEAT_MIN_CHARS characters. Normal code (similar lines, a dozen
// identical short lines, a table) stays far from that. The same rule as mlx_text.repeating_tail.
const REPEAT_MIN_COUNT = 20;
const REPEAT_MIN_CHARS = 600;
const REPEAT_MAX_CHUNK = 400;

function repeatingTail(text) {
  for (let size = 1; size <= REPEAT_MAX_CHUNK; size++) {
    const span = Math.max(REPEAT_MIN_CHARS, size * REPEAT_MIN_COUNT);
    if (span > text.length) break;
    const tail = text.slice(-span);
    if (tail.slice(size) === tail.slice(0, -size)) return true;
  }
  return false;
}

/** Removes the hidden reasoning section (start … end) a reasoning model writes before answering. */
function stripThinking(text, start, end) {
  if (!start || !end) return text;
  for (;;) {
    const head = text.indexOf(start);
    const tail = text.indexOf(end, head >= 0 ? head + start.length : 0);
    if (tail < 0) return text;
    // A template can open the section itself, so the answer may hold only its end.
    text = (head >= 0 ? text.slice(0, head) : '') + text.slice(tail + end.length);
  }
}

// Parameter types that stay text (mlx_lm qwen3_coder.py).
const STRING_TYPES = new Set(['string', 'str', 'text', 'varchar', 'char', 'enum']);

const argumentsOf = (call) => {
  for (const key of ['arguments', 'parameters', 'parameter']) if (call[key] && typeof call[key] === 'object' && !Array.isArray(call[key])) return call[key];
  return {};
};

/**
 * A tool call written as JSON (also after «call:», or inside <function=name>…), as mlx_text._tool_call_objects.
 * In the <parameter=key> form a value is read with the tool's own type when the tool is known: a text
 * parameter stays text even if it looks like JSON (write_file of a package.json, cel 17-11-2026).
 */
function toolCallObjects(body, tools = null) {
  let text = body.trim();
  if (text.startsWith('call:')) text = text.slice(5).trim();
  const tagged = /^<function=([\w.-]+)>\s*(\{[\s\S]*\})\s*(?:<\/function>)?$/.exec(text);
  if (tagged) return [{ name: tagged[1], arguments: JSON.parse(tagged[2]) }];
  const xml = /^<function=([\w.-]+)>([\s\S]*)<\/function>$/.exec(text);
  if (xml && !xml[2].trim()) return [{ name: xml[1], arguments: {} }];
  if (xml && xml[2].includes('<parameter=')) {
    const args = {};
    const types = (tools || []).find((tool) => tool?.function?.name === xml[1])?.function?.parameters?.properties || {};
    for (const [, key, value] of xml[2].matchAll(/<parameter=([\w.-]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) {
      if (STRING_TYPES.has(String(types[key]?.type || '').trim().toLowerCase())) { args[key] = value; continue; }
      try { args[key] = '[{'.includes(value.trim().slice(0, 1)) && value.trim() ? JSON.parse(value) : value; } catch { args[key] = value; }
    }
    return [{ name: xml[1], arguments: args }];
  }
  const value = JSON.parse(text);
  const calls = Array.isArray(value) ? value : [value];
  if (!calls.every((call) => call && typeof call === 'object' && typeof call.name === 'string')) throw new Error('not a tool call');
  return calls;
}

// mlx_lm/tool_parsers/qwen3_coder.py: <function=name><parameter=key>value</parameter>…</function>, values
// converted with the tool's parameter types.
const BOOL_TYPES = new Set(['boolean', 'bool', 'binary']);
const OBJ_TYPES = new Set(['object', 'array', 'arr']);

function convertParam(value, name, config) {
  if (value.toLowerCase() === 'null') return null;
  const param = config[name];
  if (!param) return value;
  if (!('type' in param)) {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : value; } catch { return value; }
  }
  const type = String(param.type).trim().toLowerCase();
  if (STRING_TYPES.has(type)) return value;
  if (/^(int|uint|long|short|unsigned)/.test(type)) {
    const number = Number(value);
    if (!Number.isFinite(number) || !Number.isInteger(number)) throw new Error(`Invalid integer literal ${value}`);
    return number;
  }
  if (/^(num|float)/.test(type)) {
    const number = Number(value);
    if (Number.isNaN(number)) throw new Error(`Invalid number ${value}`);
    return number;
  }
  if (BOOL_TYPES.has(type)) return value.toLowerCase() === 'true';
  try { return JSON.parse(value); } catch { return value; }
}

function qwen3CoderParser(body, tools) {
  const match = /<function=([\s\S]*?)<\/function>$/.exec(body);
  if (!match) throw new Error('No function provided.');
  const call = match[1];
  const nameMatch = /^\s*([^\s<>]+)>?/.exec(call);
  if (!nameMatch) throw new Error('No function name provided.');
  const name = nameMatch[1];
  const config = (tools || []).find((tool) => tool?.function?.name === name)?.function?.parameters?.properties || {};
  const args = {};
  for (const [, inner] of call.slice(nameMatch[0].length).matchAll(/<parameter=([\s\S]*?)<\/parameter>/g)) {
    const param = /^\s*([^\s<>]+)>?/.exec(inner);
    if (!param) continue;
    let value = inner.slice(param[0].length);
    if (value.startsWith('\n')) value = value.slice(1);
    if (value.endsWith('\n')) value = value.slice(0, -1);
    args[param[1]] = convertParam(value, param[1], config);
  }
  return { name, arguments: args };
}

/** Rewrites the model's tool calls as <tool_call>{json}</tool_call>, the one form the agent reads (mlx_text.normalize_tool_calls). */
function normalizeToolCalls(text, tools, start = '<tool_call>', end = '</tool_call>', parser = null) {
  if (!text.includes(start)) return text;
  let out = '';
  let rest = text;
  while (rest.includes(start)) {
    const at = rest.indexOf(start);
    out += rest.slice(0, at);
    const after = rest.slice(at + start.length);
    const close = end ? after.indexOf(end) : -1;
    const body = close >= 0 ? after.slice(0, close) : after;
    const found = close >= 0 ? end : '';
    rest = close >= 0 ? after.slice(close + end.length) : '';
    try {
      for (const call of toolCallObjects(body, tools)) out += `<tool_call>${pyJson({ name: call.name, arguments: argumentsOf(call) })}</tool_call>`;
      continue;
    } catch { /* not JSON */ }
    try {
      if (!parser) throw new Error('no parser');
      const parsed = parser(body, tools);
      for (const call of Array.isArray(parsed) ? parsed : [parsed]) out += `<tool_call>${pyJson({ name: call.name, arguments: call.arguments || {} })}</tool_call>`;
    } catch {
      out += start + body + found;
    }
  }
  return out + rest;
}

/** The agent's <tool_call>{json}</tool_call> history in the model's own format: tool_calls and tool messages (mlx_text.native_history). */
function nativeHistory(messages) {
  const out = [];
  let pendingTool = null;
  for (const message of messages) {
    if (pendingTool !== null && message.role === 'user') {
      out.push({ role: 'tool', name: pendingTool, content: message.content ?? '' });
      pendingTool = null;
      continue;
    }
    pendingTool = null;
    const content = message.content ?? '';
    if (message.role !== 'assistant' || !content.includes('<tool_call>')) { out.push(message); continue; }
    let text = '';
    const calls = [];
    let rest = content;
    while (rest.includes('<tool_call>')) {
      const at = rest.indexOf('<tool_call>');
      text += rest.slice(0, at);
      const after = rest.slice(at + '<tool_call>'.length);
      const close = after.indexOf('</tool_call>');
      const body = close >= 0 ? after.slice(0, close) : after;
      const found = close >= 0 ? '</tool_call>' : '';
      rest = close >= 0 ? after.slice(close + '</tool_call>'.length) : '';
      try {
        for (const call of toolCallObjects(body)) calls.push({ type: 'function', function: { name: call.name, arguments: call.arguments || {} } });
      } catch {
        text += '<tool_call>' + body + found;
      }
    }
    text += rest;
    if (!calls.length) { out.push(message); continue; }
    out.push({ role: 'assistant', content: text.trim(), tool_calls: calls });
    pendingTool = calls[calls.length - 1].function.name;
  }
  return out;
}

/** The model's tool-call format: declared in tokenizer_config.json, else qwen3_coder when its template writes it (mlx_text.tool_parser_type). */
function toolParserType(modelDir) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer_config.json'), 'utf8')); } catch { /* none */ }
  if (config.tool_parser_type) return config.tool_parser_type;
  let template = typeof config.chat_template === 'string' ? config.chat_template : '';
  try { template += fs.readFileSync(path.join(modelDir, 'chat_template.jinja'), 'utf8'); } catch { /* none */ }
  return template.includes('<tool_call><function=') ? 'qwen3_coder' : null;
}

/** The model's context window from its config (also inside text_config), as mlx_trace.context_limit. */
function contextLimit(modelDir) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(modelDir, 'config.json'), 'utf8'));
    for (const source of [config, config.text_config || {}]) {
      for (const key of ['max_position_embeddings', 'max_sequence_length', 'seq_length']) if (Number.isInteger(source[key])) return source[key];
    }
  } catch { /* no config */ }
  return null;
}

module.exports = { repeatingTail, pyJson, stripThinking, toolCallObjects, qwen3CoderParser, normalizeToolCalls, nativeHistory, toolParserType, contextLimit };
