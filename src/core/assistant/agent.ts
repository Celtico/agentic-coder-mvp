import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { CudaInferenceEngine, MlxInferenceEngine, NativeInferenceEngine, TransformersJsInferenceEngine, type ChatTurn, type InferenceEngine, type InferenceToolDefinition } from './inference-engine';
import { prompt as promptText, toolDescriptions } from './prompts';
import { splitSystem, type TraceContext } from './llm-trace';
import { LocalExperienceEmbedder, type EmbeddableExperience, type RankedExperience } from './local-embeddings';

// 'draft': an answer the reviewer sent back; the window keeps it in case the user stops the work.
/**
 * What the agent tells the window while it works: an activity, its plan, the reviewer's finished draft, or
 * its progress (the iteration it is on, 1-based, of the limit in force, and the tool it runs, if any).
 */
export type AgentStatus = { type: 'status' | 'plan' | 'draft' | 'review'; message: string } | { type: 'progress'; iteration: number; maxIterations: number; tool?: string };
export type AgentToolCall =
  | { name: 'list_files' | 'run_tests' }
  | { name: 'create_git_commit'; arguments: { message: string } }
  | { name: 'read_file'; arguments: { path: string } }
  | { name: 'search_text'; arguments: { query: string } }
  | { name: 'web_search'; arguments: { query: string } }
  | { name: 'read_web_page'; arguments: { url: string } }
  | { name: 'list_mcp_tools' }
  | { name: 'call_mcp_tool'; arguments: { server: string; tool: string; arguments: Record<string, unknown> } }
  | { name: 'delegate_tasks'; arguments: { tasks: string[] } }
  | { name: 'write_file'; arguments: { path: string; content: string } }
  | { name: 'delete_file'; arguments: { path: string } }
  | { name: 'run_project_script'; arguments: { script: string } }
  | { name: 'install_package'; arguments: { packageName: string; dev: boolean } }
  | { name: 'run_npx'; arguments: { packageName: string; args: string[] } }
  | { name: 'install_dependencies' }
  | { name: 'inspect_browser'; arguments: { url: string; actions?: BrowserAction[] } }
  | { name: 'start_project'; arguments: { script: string } }
  | { name: 'stop_project' };
export type AgentToolExecutor = (tool: AgentToolCall) => Promise<unknown>;
export type AgentTrajectoryStep = { name: string; arguments: Record<string, unknown>; result: string; ok: boolean };
export type AgentTrajectory = { prompt: string; model: string; system: string; steps: AgentTrajectoryStep[]; answer: string };

type AgentAction = { type: 'final'; content: string } | { type: 'plan'; content: string } | { type: 'tool_call'; name: string; arguments?: unknown; plan?: string };
type BrowserTarget = { by: 'role' | 'label' | 'placeholder' | 'text' | 'testId'; value: string; role?: 'button' | 'link' | 'checkbox' | 'radio' | 'textbox' | 'heading' | 'option' };
type BrowserAction = { type: 'click' | 'assertVisible'; target: BrowserTarget } | { type: 'fill'; target: BrowserTarget; value: string } | { type: 'assertText'; text: string };
type ExperienceRanker = { rank(prompt: string, values: EmbeddableExperience[], onStatus?: (message: string) => void): Promise<RankedExperience[]> };

const objectParameters = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });
const stringParameter = (description: string, maxLength = 500): Record<string, unknown> => ({ type: 'string', description, maxLength });
const agentToolDefinitions: InferenceToolDefinition[] = [
  { type: 'function', function: { name: 'list_files', description: '', parameters: objectParameters({}) } },
  { type: 'function', function: { name: 'delegate_tasks', description: '', parameters: objectParameters({ tasks: { type: 'array', minItems: 1, maxItems: 3, items: stringParameter('One independent, concrete subtask for a delegated agent.', 1000) } }, ['tasks']) } },
  { type: 'function', function: { name: 'read_file', description: '', parameters: objectParameters({ path: stringParameter('Project-relative file path.') }, ['path']) } },
  { type: 'function', function: { name: 'search_text', description: '', parameters: objectParameters({ query: stringParameter('Text to search for.', 200) }, ['query']) } },
  { type: 'function', function: { name: 'call_mcp_tool', description: '', parameters: objectParameters({ server: stringParameter('Server name.', 40), tool: stringParameter('Tool name.', 80), arguments: { type: 'object', description: 'Arguments for the tool.' } }, ['server', 'tool']) } },
  { type: 'function', function: { name: 'read_web_page', description: '', parameters: objectParameters({ url: stringParameter('The full https address of the page.', 500) }, ['url']) } },
  { type: 'function', function: { name: 'web_search', description: '', parameters: objectParameters({ query: stringParameter('A concise, non-sensitive web search query.', 200) }, ['query']) } },
  { type: 'function', function: { name: 'write_file', description: '', parameters: objectParameters({ path: stringParameter('Project-relative file path.'), content: stringParameter('Complete file contents.', 24000) }, ['path', 'content']) } },
  { type: 'function', function: { name: 'delete_file', description: '', parameters: objectParameters({ path: stringParameter('Project-relative file path.') }, ['path']) } },
  { type: 'function', function: { name: 'run_tests', description: '', parameters: objectParameters({}) } },
  { type: 'function', function: { name: 'run_project_script', description: '', parameters: objectParameters({ script: { ...stringParameter('Existing package.json script name.', 64), pattern: '^[a-zA-Z0-9:_-]+$' } }, ['script']) } },
  { type: 'function', function: { name: 'start_project', description: '', parameters: objectParameters({ script: { type: 'string', enum: ['dev', 'start', 'preview'] } }, ['script']) } },
  { type: 'function', function: { name: 'stop_project', description: '', parameters: objectParameters({}) } },
  { type: 'function', function: { name: 'create_git_commit', description: '', parameters: objectParameters({ message: stringParameter('Commit message.', 200) }, ['message']) } },
  { type: 'function', function: { name: 'install_dependencies', description: '', parameters: objectParameters({}) } },
  { type: 'function', function: { name: 'run_npx', description: '', parameters: objectParameters({ packageName: stringParameter('Package name only.', 214), args: { type: 'array', items: { type: 'string' }, description: 'Arguments after the package name.' } }, ['packageName', 'args']) } },
  { type: 'function', function: { name: 'install_package', description: '', parameters: objectParameters({ packageName: stringParameter('Package name only.', 214), dev: { type: 'boolean', description: 'Whether to install as a development dependency.' } }, ['packageName', 'dev']) } },
  { type: 'function', function: { name: 'inspect_browser', description: '', parameters: objectParameters({
    url: { ...stringParameter('URL on localhost, 127.0.0.1, or ::1.', 2000), pattern: '^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]{1,5})?([/?#].*)?$' },
    actions: { type: 'array', maxItems: 12, items: { type: 'object', properties: {
      type: { type: 'string', enum: ['click', 'fill', 'assertVisible', 'assertText'] },
      target: { type: 'object', properties: {
        by: { type: 'string', enum: ['role', 'label', 'placeholder', 'text', 'testId'] },
        value: stringParameter('Accessible name, label, placeholder, visible text, or test id.', 200),
        role: { type: 'string', enum: ['button', 'link', 'checkbox', 'radio', 'textbox', 'heading', 'option'] },
      }, required: ['by', 'value'], additionalProperties: false },
      value: stringParameter('Value to enter in a field.', 1000),
      text: stringParameter('Visible text that must appear on the page.', 1000),
    }, required: ['type'], additionalProperties: false } },
  }, ['url']) } },
];

/**
 * Small models (around 1.5B parameters) lose the thread with the full instructions, sixteen tools and
 * 20 KB of project files: they answer with a tutorial instead of acting. For them the agent sends short
 * instructions, the few tools needed to build something, and a small slice of the project.
 */
const COMPACT_TOOL_NAMES = new Set(['list_files', 'read_file', 'write_file', 'run_project_script', 'start_project', 'install_package']);
const COMPACT_CONTEXT_BYTES = 4000;
const COMPACT_MANIFEST_ENTRIES = 80;
/** The engine for a runtime: «cuda» on Linux with NVIDIA GPUs, «transformers» for ONNX in Node, else MLX (a Mac). */
export function createEngine(runtime: string | undefined): InferenceEngine {
  if (runtime === 'cuda') return new CudaInferenceEngine();
  if (runtime === 'native') return new NativeInferenceEngine();
  if (runtime === 'transformers') return new TransformersJsInferenceEngine();
  return new MlxInferenceEngine();
}

export function isSmallModel(modelId: string): boolean {
  if (process.env.AGENT_COMPACT === '1') return true;
  if (process.env.AGENT_COMPACT === '0') return false;
  const size = /(\d+(?:\.\d+)?)\s*B(?![a-z])/i.exec(modelId);
  return size ? Number(size[1]) <= 3 : false;
}

/**
 * What the model actually answered at each step, for working out why a task was not completed. Local
 * only: written under the app's own logs/ folder (ignored by Git), or wherever AGENT_TURN_LOG points;
 * AGENT_TURN_LOG=off disables it.
 */
const TURN_LOG = process.env.AGENT_TURN_LOG === 'off' ? null : process.env.AGENT_TURN_LOG || path.resolve(__dirname, '../../../logs/agent-turns.jsonl');
async function logTurn(entry: Record<string, unknown>): Promise<void> {
  if (!TURN_LOG || process.env.NODE_TEST_CONTEXT) return;
  try {
    await fs.mkdir(path.dirname(TURN_LOG), { recursive: true });
    await fs.appendFile(TURN_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* a log that cannot be written must not break the task */ }
}

/** The user's own words in a request: without URLs, code blocks, inline code or pasted command lines. */
export function requestWords(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\b(?:https?|file):\/\/\S+|\bwww\.\S+/gi, ' ')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:[$>#]\s*)?(?:npx|npm|pnpm|yarn|bun|bunx|node|git|cd|curl|brew|pip|python3?)\s/i.test(line) && !/^\s*#/.test(line))
    .join('\n');
}

/** Pieces of an instruction joined by blank lines: a piece left empty leaves no gap. */
/** The tools as the model receives them: the schema from the code with the descriptions of prompts/tools.md. */
function describedTools(tools: InferenceToolDefinition[]): InferenceToolDefinition[] {
  const descriptions = toolDescriptions();
  return tools.map((tool) => ({ ...tool, function: { ...tool.function, description: descriptions[tool.function.name] ?? '' } }));
}

function tidyBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * A text the model wrote, without any tool call in it: the `<tool_call>…</tool_call>` blocks, the tags of
 * its XML call format and any JSON object that names a tool or an action. What is left is prose, or
 * nothing; a call (even to a tool that does not exist, like «plan») is never shown as a plan or as text.
 */
export function withoutToolCalls(text: string): string {
  let rest = String(text || '')
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, ' ')
    .replace(/<\/?(?:tool_call|function(?:=[^>]*)?|parameter(?:=[^>]*)?)>/gi, ' ')
    .replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```/gi, ' ');
  // Bare JSON objects that are calls or actions ({"name": …} / {"type": …}).
  for (let start = rest.indexOf('{'); start !== -1; start = rest.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < rest.length; end += 1) {
      const character = rest[end];
      if (inString) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') inString = false; continue; }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}' && --depth === 0) {
        const candidate = rest.slice(start, end + 1);
        if (/^\{\s*"(?:name|type)"\s*:/.test(candidate)) { rest = `${rest.slice(0, start)} ${rest.slice(end + 1)}`; start -= 1; }
        break;
      }
    }
  }
  return rest.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Whether an answer says the work is done without any tool having run in the turn: a request for work, no
 * tool call yet, and an answer (prose or «final») instead of a call. Marked in the turn log.
 */
export function claimedDoneWithoutTools({ toolCallsRun, requestedWork, action }: { toolCallsRun: number; requestedWork: boolean; action: { type: string } | null }): boolean {
  return requestedWork && toolCallsRun === 0 && (!action || action.type === 'final');
}

function parseAction(raw: string): AgentAction | null {
  const parseCandidate = (candidate: string): AgentAction | null => {
    try {
      const value: unknown = JSON.parse(candidate.trim());
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const action = value as Record<string, unknown>;
      if (action.type === 'final' && typeof action.content === 'string') return { type: 'final', content: action.content };
      if (action.type === 'plan' && typeof action.content === 'string') return { type: 'plan', content: action.content };
      // Some models name the arguments «parameters» or «parameter» (MiMo with vision, 15-11-2026).
      const args = action.arguments ?? action.parameters ?? action.parameter;
      if (action.type === 'tool_call' && typeof action.name === 'string') return { type: 'tool_call', name: action.name, arguments: args };
      // The bare {"name", "arguments"} form counts only for a real tool: a package.json the model
      // quotes in its answer also has a "name", and it is not a call.
      if (typeof action.name === 'string' && agentToolDefinitions.some((tool) => tool.function.name === action.name)) return { type: 'tool_call', name: action.name, arguments: args };
    } catch {}
    return null;
  };

  // Models often write a file's content with real line breaks inside the JSON string, which is not
  // valid JSON. Escape control characters that sit inside a string before parsing.
  const repairStrings = (candidate: string): string => {
    let out = '';
    let inString = false;
    let escaped = false;
    for (const character of candidate) {
      if (inString) {
        if (escaped) { escaped = false; out += character; continue; }
        if (character === '\\') { escaped = true; out += character; continue; }
        if (character === '"') { inString = false; out += character; continue; }
        if (character === '\n') { out += '\\n'; continue; }
        if (character === '\r') { out += '\\r'; continue; }
        if (character === '\t') { out += '\\t'; continue; }
        out += character;
        continue;
      }
      if (character === '"') inString = true;
      out += character;
    }
    return out;
  };
  // Small models often drop the last closing brace of a long call; one or two missing ones are put back.
  const closeBraces = (candidate: string): AgentAction | null => {
    const text = candidate.trimEnd();
    if (!text.startsWith('{')) return null;
    for (const tail of ['}', '}}', '"}}', ']}', ']}}']) {
      const action = parseCandidate(text + tail) || parseCandidate(repairStrings(text + tail));
      if (action) return action;
    }
    return null;
  };
  const parseLenient = (candidate: string): AgentAction | null => parseCandidate(candidate) || parseCandidate(repairStrings(candidate)) || closeBraces(candidate);
  // Every complete top-level {...} in a text, in order.
  const topLevelObjects = (text: string): string[] => {
    const found: string[] = [];
    for (let start = 0; start < text.length; start += 1) {
      if (text[start] !== '{') continue;
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let end = start; end < text.length; end += 1) {
        const character = text[end];
        if (inString) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') inString = true;
        else if (character === '{') depth += 1;
        else if (character === '}') {
          depth -= 1;
          if (depth === 0) { found.push(text.slice(start, end + 1)); start = end; break; }
        }
      }
    }
    return found;
  };

  // MiMo (Qwen 3.5 inside) sometimes writes the agent's JSON action and closes it with the tags of its
  // own XML call format («…"}</parameter></function></tool_call>»): those closing tags are dropped,
  // and the braces they stand for are put back by the lenient parse below.
  const normalized = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').replace(/(?:\s*<\/(?:parameter|function|tool_call)>)+\s*$/i, '');
  // A model may send several calls in one answer, some of them empty (MiMo writes
  // `{"name":"write_file","arguments":{}}` a few times before the real one). The first call that is
  // valid is the one that runs; the next step comes in the next turn. If none is valid, the first
  // one is returned, and the loop tells the model it was not valid.
  let firstCall: AgentAction | null = null;
  for (const match of raw.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)) {
    let action: AgentAction | null = null;
    try {
      const value: unknown = JSON.parse(match[1].trim());
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const call = value as Record<string, unknown>;
        if (typeof call.name === 'string') action = { type: 'tool_call', name: call.name, arguments: call.arguments ?? call.parameters ?? call.parameter };
      }
    } catch {
      // <function=name>{json}</function> inside the block, the closing </function> sometimes left out.
      const tagged = /^<function=([\w.-]+)>\s*(\{[\s\S]*\})\s*(?:<\/function>)?$/.exec(match[1].trim());
      if (tagged) { try { action = { type: 'tool_call', name: tagged[1], arguments: JSON.parse(tagged[2]) }; } catch { /* not JSON either */ } }
      // A file's content with real line breaks, or a missing closing brace.
      action ??= parseLenient(match[1]);
    }
    if (action?.type !== 'tool_call') continue;
    if (validateToolCall(action)) return action;
    firstCall ??= action;
  }
  if (firstCall) return firstCall;
  const directAction = parseLenient(normalized);
  if (directAction) return directAction;

  // Some small models concatenate several JSON actions; accept only the first
  // complete object at the very start of the response, then let the agent loop
  // ask the model for its next step. Never mine arbitrary prose for JSON.
  if (normalized.startsWith('{')) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < normalized.length; index += 1) {
      const character = normalized[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          const leadingAction = parseLenient(normalized.slice(0, index + 1));
          // A plan followed by the call that carries it out is that call, with its plan: answering
          // only the plan would ask the model for the call it already wrote, and some models then
          // repeat the same pair forever.
          if (leadingAction?.type === 'plan') {
            for (const candidate of topLevelObjects(normalized.slice(index + 1))) {
              const next = parseLenient(candidate);
              if (next?.type === 'tool_call') return { ...next, plan: leadingAction.content };
            }
          }
          if (leadingAction) return leadingAction;
          break;
        }
      }
    }
  }

  // Explanations before JSON remain inert unless the JSON is in an explicit fence.
  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const fenced = match[1];
    const wholeBlockAction = parseLenient(fenced);
    if (wholeBlockAction) return wholeBlockAction;

    // Small local models sometimes put several separate tool-call objects in
    // one JSON fence. Parse only complete top-level objects from that explicit
    // action block, then let the normal agent loop execute one call at a time.
    for (let start = 0; start < fenced.length; start += 1) {
      if (fenced[start] !== '{') continue;
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let end = start; end < fenced.length; end += 1) {
        const character = fenced[end];
        if (inString) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') inString = true;
        else if (character === '{') depth += 1;
        else if (character === '}') {
          depth -= 1;
          if (depth === 0) {
            const fencedAction = parseLenient(fenced.slice(start, end + 1));
            if (fencedAction) return fencedAction;
            start = end;
            break;
          }
        }
      }
    }
  }

  // Last resort: the model explained itself and wrote its actions in the middle of the prose, without a
  // fence. Only objects that declare themselves ("type":"tool_call" / "plan") count, so a snippet of
  // code or a quoted file never becomes an action; the tool call is still validated before it runs.
  let embeddedPlan: string | undefined;
  for (const candidate of topLevelObjects(raw)) {
    if (!/"type"\s*:\s*"(?:tool_call|plan)"/.test(candidate)) continue;
    const action = parseLenient(candidate);
    if (action?.type === 'plan') embeddedPlan ??= action.content;
    else if (action?.type === 'tool_call') return { ...action, plan: embeddedPlan };
  }
  if (embeddedPlan) return { type: 'plan', content: embeddedPlan };
  return null;
}

/**
 * A call's arguments in the types its tool declares, where a model wrote them as text: «"false"» for a
 * yes/no, «"3"» for a number, «"[…]"» / «"{…}"» for a list or an object (MiMo with vision looped on
 * install_package with «"dev": "false"», 15-11-2026). Driven only by each tool's schema, the same for every
 * tool and model; anything ambiguous is left as it is, for the validation to refuse. The call the model
 * wrote is not changed: only what is checked and run.
 */
export function coerceArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const schema = agentToolDefinitions.find((tool) => tool.function.name === name)?.function.parameters as { properties?: Record<string, { type?: string }> } | undefined;
  const properties = schema?.properties;
  if (!properties) return args;
  const coerced: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(args)) {
    const type = properties[key]?.type;
    if (typeof value !== 'string' || !type || type === 'string') continue;
    const text = value.trim();
    if (type === 'boolean' && /^(true|false)$/i.test(text)) coerced[key] = text.toLowerCase() === 'true';
    else if (type === 'integer' && /^-?\d+$/.test(text)) coerced[key] = Number(text);
    else if (type === 'number' && /^-?\d+(?:\.\d+)?$/.test(text)) coerced[key] = Number(text);
    else if ((type === 'array' && text.startsWith('[')) || (type === 'object' && text.startsWith('{'))) {
      try { const parsed: unknown = JSON.parse(text); if (type === 'array' ? Array.isArray(parsed) : parsed && typeof parsed === 'object' && !Array.isArray(parsed)) coerced[key] = parsed; } catch { /* left as it is */ }
    }
  }
  return coerced;
}

function validateToolCall(action: Extract<AgentAction, { type: 'tool_call' }>): AgentToolCall | null {
  if (action.name === 'list_files' || action.name === 'run_tests' || action.name === 'stop_project') return { name: action.name };
  if (!action.arguments || typeof action.arguments !== 'object' || Array.isArray(action.arguments)) return null;
  const args = coerceArguments(action.name, action.arguments as Record<string, unknown>);
  if (action.name === 'create_git_commit' && typeof args.message === 'string' && args.message.trim().length > 0 && args.message.length <= 200) return { name: 'create_git_commit', arguments: { message: args.message.trim() } };
  if (action.name === 'read_file' && typeof args.path === 'string' && args.path.length > 0 && args.path.length <= 500) return { name: 'read_file', arguments: { path: args.path } };
  if (action.name === 'delete_file' && typeof args.path === 'string' && args.path.length > 0 && args.path.length <= 500) return { name: 'delete_file', arguments: { path: args.path } };
  if (action.name === 'search_text' && typeof args.query === 'string' && args.query.trim().length > 0 && args.query.length <= 200) return { name: 'search_text', arguments: { query: args.query } };
  if (action.name === 'list_mcp_tools') return { name: 'list_mcp_tools' };
  if (action.name === 'call_mcp_tool' && typeof args.server === 'string' && /^[\w-]{1,40}$/.test(args.server) && typeof args.tool === 'string' && /^[\w.-]{1,80}$/.test(args.tool)) {
    const toolArguments = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments as Record<string, unknown> : {};
    if (JSON.stringify(toolArguments).length <= 4000) return { name: 'call_mcp_tool', arguments: { server: args.server, tool: args.tool, arguments: toolArguments } };
  }
  if (action.name === 'read_web_page' && typeof args.url === 'string' && /^https?:\/\/\S{4,490}$/i.test(args.url.trim())) return { name: 'read_web_page', arguments: { url: args.url.trim() } };
  if (action.name === 'web_search' && typeof args.query === 'string' && args.query.trim().length > 0 && args.query.trim().length <= 200 && !/[\r\n\0]/.test(args.query)) return { name: 'web_search', arguments: { query: args.query.trim() } };
  if (action.name === 'delegate_tasks' && Array.isArray(args.tasks) && args.tasks.length > 0 && args.tasks.length <= 3 && args.tasks.every((task) => typeof task === 'string' && task.trim().length > 0 && task.trim().length <= 1000)) {
    const tasks = args.tasks.map((task) => (task as string).trim());
    if (new Set(tasks.map((task) => task.toLocaleLowerCase())).size !== tasks.length) return null;
    return { name: 'delegate_tasks', arguments: { tasks } };
  }
  if (action.name === 'write_file' && typeof args.path === 'string' && args.path.length > 0 && args.path.length <= 500 && typeof args.content === 'string' && args.content.length <= 24000) return { name: 'write_file', arguments: { path: args.path, content: args.content } };
  // A dev server never exits: run as a plain script it would hold the agent until the timeout.
  // Models often pick run_project_script for it, so those scripts are started in the background instead.
  if (action.name === 'run_project_script' && typeof args.script === 'string' && /^(dev|start|preview)$/.test(args.script)) return { name: 'start_project', arguments: { script: args.script } };
  if (action.name === 'run_project_script' && typeof args.script === 'string' && /^[a-zA-Z0-9:_-]{1,64}$/.test(args.script)) return { name: 'run_project_script', arguments: { script: args.script } };
  if (action.name === 'start_project' && typeof args.script === 'string' && /^(dev|start|preview)$/.test(args.script)) return { name: 'start_project', arguments: { script: args.script } };
  if (action.name === 'install_dependencies') return { name: 'install_dependencies' };
  if (action.name === 'run_npx' && typeof args.packageName === 'string' && args.packageName.length <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[\w.^~-]{1,30})?$/i.test(args.packageName)) {
    const extra = Array.isArray(args.args) ? args.args : [];
    if (extra.length <= 10 && extra.every((item) => typeof item === 'string' && item.length <= 120 && !/[\r\n\0;&|`$<>]/.test(item))) return { name: 'run_npx', arguments: { packageName: args.packageName, args: extra as string[] } };
  }
  if (action.name === 'install_package' && typeof args.packageName === 'string' && args.packageName.length <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(args.packageName) && typeof args.dev === 'boolean') return { name: 'install_package', arguments: { packageName: args.packageName, dev: args.dev } };
  if (action.name === 'inspect_browser' && typeof args.url === 'string' && args.url.length <= 2000 && /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#][^\s]*)?$/i.test(args.url)) {
    if (args.actions === undefined) return { name: 'inspect_browser', arguments: { url: args.url } };
    if (!Array.isArray(args.actions) || args.actions.length > 12) return null;
    const actions: BrowserAction[] = [];
    for (const rawAction of args.actions) {
      if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) return null;
      const item = rawAction as Record<string, unknown>;
      if (item.type === 'assertText' && typeof item.text === 'string' && item.text.length > 0 && item.text.length <= 1000) { actions.push({ type: 'assertText', text: item.text }); continue; }
      if (!['click', 'fill', 'assertVisible'].includes(String(item.type)) || !item.target || typeof item.target !== 'object' || Array.isArray(item.target)) return null;
      const target = item.target as Record<string, unknown>;
      if (!['role', 'label', 'placeholder', 'text', 'testId'].includes(String(target.by)) || typeof target.value !== 'string' || !target.value.trim() || target.value.length > 200) return null;
      if (target.by === 'role' && !['button', 'link', 'checkbox', 'radio', 'textbox', 'heading', 'option'].includes(String(target.role))) return null;
      const safeTarget: BrowserTarget = { by: target.by as BrowserTarget['by'], value: target.value, ...(target.by === 'role' ? { role: target.role as BrowserTarget['role'] } : {}) };
      if (item.type === 'fill') {
        if (typeof item.value !== 'string' || item.value.length > 1000) return null;
        actions.push({ type: 'fill', target: safeTarget, value: item.value });
      } else actions.push({ type: item.type as 'click' | 'assertVisible', target: safeTarget });
    }
    return { name: 'inspect_browser', arguments: { url: args.url, actions } };
  }
  return null;
}

const experienceStopWords = new Set('amb als aquelles aquest aquesta això cap com del dels des dins el ella elles en era es està fer fins hi i les més mateix molt no on per però que qui se ser si sobre són te tot una unes uns va van'.split(' '));

function words(text: string): Set<string> {
  return new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((word) => !experienceStopWords.has(word)));
}

type GitIgnoreRule = { base: string; pattern: RegExp; negated: boolean; directoryOnly: boolean };

function gitIgnorePattern(pattern: string): { regex: RegExp; directoryOnly: boolean } | null {
  let value = pattern.trim();
  if (!value || value.startsWith('#')) return null;
  let directoryOnly = false;
  if (value.endsWith('/') && !value.endsWith('\\/')) {
    directoryOnly = true;
    value = value.slice(0, -1);
  }
  const anchored = value.startsWith('/');
  if (anchored) value = value.slice(1);
  const hasSlash = value.includes('/');
  let source = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\' && index + 1 < value.length) {
      source += value[++index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (character === '*') {
      if (value[index + 1] === '*') {
        index += 1;
        if (value[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else source += '.*';
      } else source += '[^/]*';
    } else if (character === '?') source += '[^/]';
    else if (character === '[') {
      const close = value.indexOf(']', index + 1);
      if (close > index + 1) {
        source += value.slice(index, close + 1);
        index = close;
      } else source += '\\[';
    } else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const body = anchored || hasSlash ? `^${source}$` : `(?:^|/)${source}$`;
  try { return { regex: new RegExp(body), directoryOnly }; } catch { return null; }
}

function parseGitIgnore(contents: string, base: string): GitIgnoreRule[] {
  return contents.split(/\r?\n/).slice(0, 2000).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return [];
    const negated = trimmed.startsWith('!');
    const patternText = negated ? trimmed.slice(1) : trimmed;
    const compiled = gitIgnorePattern(patternText);
    return compiled ? [{ base, pattern: compiled.regex, negated, directoryOnly: compiled.directoryOnly }] : [];
  });
}

function isGitIgnored(absolutePath: string, isDirectory: boolean, rules: GitIgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    const relative = path.relative(rule.base, absolutePath).split(path.sep).join('/');
    if (!relative || relative === '..' || relative.startsWith('../')) continue;
    const candidates = [relative];
    if (rule.directoryOnly || !isDirectory) {
      const parts = relative.split('/');
      for (let index = 1; index < parts.length; index += 1) candidates.push(parts.slice(0, index).join('/'));
    }
    if (candidates.some((candidate) => rule.pattern.test(candidate))) ignored = !rule.negated;
  }
  return ignored;
}

function formatBrowserInspection(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const value = result as Record<string, unknown>;
  if (value.cancelled === true) return 'La inspecció del navegador s’ha cancel·lat; no s’ha obert cap pàgina.';
  if (typeof value.error === 'string') return `La inspecció del navegador ha fallat: ${value.error}`;
  if (value.inspected !== true) return null;

  const status = typeof value.status === 'number' ? `HTTP ${value.status}` : 'codi HTTP no disponible';
  const lines = [`Inspecció completada: ${status}.`];
  if (typeof value.url === 'string') lines.push(`Adreça: ${value.url}`);
  if (typeof value.title === 'string') lines.push(`Títol: ${value.title || '(sense títol)'}`);
  if (Array.isArray(value.actionResults) && value.actionResults.length) {
    lines.push(`Accions de navegador: ${value.actionResults.length} completades.`);
    for (const item of value.actionResults) {
      if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).description === 'string') lines.push(`- ${(item as Record<string, unknown>).description}`);
    }
  }
  const errors = [
    ['consola', value.consoleErrors],
    ['pàgina', value.pageErrors],
    ['xarxa', value.requestFailures],
  ] as const;
  for (const [label, entries] of errors) {
    const list = Array.isArray(entries) ? entries : [];
    lines.push(list.length ? `Errors de ${label}: ${JSON.stringify(list)}` : `Errors de ${label}: cap.`);
  }
  if (typeof value.screenshotPath === 'string') lines.push(`Captura: ${value.screenshotPath}`);
  return lines.join('\n');
}

/**
 * What to do about a page that started but does not work, read from its console: the error usually
 * names the file and the cause, and that is where the model has to look, not at index.html.
 */
export function pageFixHint(result: unknown): string {
  const page = result && typeof result === 'object' ? (result as { page?: { consoleErrors?: unknown } }).page : null;
  const errors = Array.isArray(page?.consoleErrors) ? page.consoleErrors.filter((item): item is string => typeof item === 'string') : [];
  if (errors.length === 0) return promptText('page-hint-no-error');
  const first = errors[0];
  const hints: string[] = [promptText('page-hint-console-error', { error: first.slice(0, 300) })];
  const file = /\bat\s+([\w./-]+\.(?:tsx?|jsx?|mjs|css|html)):(\d+)/.exec(first) || /([\w./-]+\.(?:tsx?|jsx?|mjs)):(\d+)/.exec(first);
  if (file) hints.push(promptText('page-hint-file', { file: file[1], line: file[2] }));
  else hints.push(promptText('page-hint-changed-file'));
  const missingExport = /does not provide an export named '([^']+)'/.exec(first);
  if (missingExport) hints.push(promptText('page-hint-missing-export', { name: missingExport[1] }));
  if (/useContext returned .?undefined|forgot to wrap/i.test(first)) hints.push(promptText('page-hint-provider'));
  if (/is not defined/.test(first)) hints.push(promptText('page-hint-not-defined'));
  if (/Failed to resolve import|Cannot find module/i.test(first)) hints.push(promptText('page-hint-missing-import'));
  return hints.filter(Boolean).join(' ');
}

function explicitLocalInspectionRequest(prompt: string): AgentToolCall | null {
  if (!/\b(?:inspect(?:a|e|ion)?|inspecciona(?:r)?|revisa|comprova|comprueba|verify|verifica)\b/i.test(prompt)) return null;
  if (/\b(?:click|clic|clica|prem|omple|fill|type|escriu|submit|envia|selecciona|select|marca|check|assert|formulari|form|bot[oó]|button|camp|field|aparegui|mostri)\b/i.test(prompt)) return null;
  const match = prompt.match(/https?:\/\/[^\s"'<>]+/i);
  if (!match) return null;
  const url = match[0].replace(/[),.;]+$/, '');
  const action = validateToolCall({ type: 'tool_call', name: 'inspect_browser', arguments: { url } });
  return action && action.name === 'inspect_browser' ? action : null;
}

async function explicitProjectStartRequest(prompt: string, projectRoot: string): Promise<AgentToolCall | null> {
  if (!/^\s*(?:engega|inicia|arrenca|start|run)\b/i.test(prompt)) return null;
  if (!/\b(?:app|application|project|projecte|proyecto|aplicaci[oó]|notes|web|servidor|server)\b/i.test(prompt)) return null;
  const namedScript = prompt.match(/\b(?:npm\s+run|script(?:\s+de)?|amb el script|with the script|using)\s+(dev|start|preview)\b/i)?.[1]?.toLowerCase();
  let scripts: Record<string, unknown> = {};
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
    if (manifest && typeof manifest.scripts === 'object' && manifest.scripts) scripts = manifest.scripts;
  } catch {}
  const script = namedScript && typeof scripts[namedScript] === 'string'
    ? namedScript
    : ['dev', 'start', 'preview'].find((name) => typeof scripts[name] === 'string');
  if (!script) return null;
  return { name: 'start_project', arguments: { script } };
}

/** One `## Title` section of SKILLS.md: a profile or a way of working the user has written down. */
export type ProjectSkill = { title: string; triggers: string[]; body: string };

const plain = (value: string) => value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** SKILLS.md is split by its `## ` headings; an optional first line `Paraules: a, b` adds trigger words. */
export function parseSkills(markdown: string): ProjectSkill[] {
  const skills: ProjectSkill[] = [];
  for (const section of markdown.split(/^##\s+/m).slice(1)) {
    const [heading, ...rest] = section.split('\n');
    const title = heading.trim();
    if (!title) continue;
    let lines = rest;
    let triggers: string[] = [];
    const first = lines.findIndex((line) => line.trim());
    const match = first >= 0 ? /^(?:paraules|quan|keywords?)\s*:\s*(.+)$/i.exec(lines[first].trim()) : null;
    if (match) { triggers = match[1].split(',').map((word) => plain(word.trim())).filter(Boolean); lines = lines.slice(first + 1); }
    skills.push({ title, triggers, body: lines.join('\n').trim() });
  }
  return skills;
}

/** The skills a message calls for: named with @, by its whole title, by a trigger word or by a long word of the title. */
export function matchSkills(skills: ProjectSkill[], prompt: string, limit = 2): ProjectSkill[] {
  const text = ` ${plain(prompt)} `;
  const words = new Set(text.split(/[^a-z0-9@+#.]+/).filter(Boolean));
  const scored = skills.map((skill) => {
    const title = plain(skill.title);
    const titleWords = title.split(/[^a-z0-9+#.]+/).filter((word) => word.length >= 4 && !['senior', 'specialist', 'especialista', 'engineer', 'manager', 'designer', 'architect', 'director'].includes(word));
    const score = text.includes(`@${title}`) || text.includes(`@${title.replace(/\s+/g, '-')}`) ? 4
      : text.includes(` ${title} `) ? 3
      : skill.triggers.some((word) => text.includes(word)) ? 2
      : titleWords.some((word) => words.has(word)) ? 1 : 0;
    return { skill, score };
  }).filter((item) => item.score > 0);
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((item) => item.skill);
}

export class LocalCodingAgent {
  private readonly onStatus: (status: AgentStatus) => void;
  private readonly engine: InferenceEngine;
  private readonly historyDir: string;
  private readonly verifiedExperiencesPath?: string;
  private readonly experienceRanker: ExperienceRanker;
  private experienceEmbeddingsUnavailable = false;
  /** Splitting a job among copies of the same local model: off unless switched on (AGENT_DELEGATION=1). */
  allowDelegation = process.env.AGENT_DELEGATION === '1';
  /** A second profile, the reviewer, reads what the programmer wrote before the answer is given (AGENT_REVIEW=0 turns it off). */
  reviewChanges = process.env.AGENT_REVIEW !== '0' && !process.env.NODE_TEST_CONTEXT;
  /** The public search engine is off unless switched on (AGENT_WEB_SEARCH=1): it rarely returned anything useful. Reading a given address is always available. */
  webSearch = process.env.AGENT_WEB_SEARCH === '1';
  /** Preferències › Model: the length of an answer and the steps of a task (the small models keep their own). */
  answerTokens = 2400;
  maxIterations = 28;

  constructor({ onStatus = () => {}, engine = createEngine(process.env.AGENT_MODEL_RUNTIME), verifiedExperiencesPath = process.env.AGENT_VERIFIED_EXPERIENCES_PATH, experienceRanker = new LocalExperienceEmbedder() }: {
    onStatus?: (status: AgentStatus) => void;
    engine?: InferenceEngine;
    verifiedExperiencesPath?: string;
    experienceRanker?: ExperienceRanker;
  } = {}) {
    this.onStatus = onStatus;
    this.engine = engine;
    this.historyDir = path.join(os.homedir(), '.agentic-coder', 'memory');
    this.verifiedExperiencesPath = verifiedExperiencesPath;
    this.experienceRanker = experienceRanker;
  }

  async unloadModel(): Promise<void> { await this.engine.unloadModel(); }

  /**
   * What happened in the last request: every tool the model called, with its arguments and result,
   * and the final answer. When the user approves the result it is kept as a verified case, so a later
   * training run learns the sequence of steps that worked, not only the final text.
   */
  lastTrajectory: AgentTrajectory | null = null;
  private trajectorySteps: AgentTrajectoryStep[] | null = null;
  private trajectorySystem = '';
  private askDepth = 0;

  /** The engine, told who is asking (Log del model). Only a label: the call itself is not changed. */
  private traced(context: TraceContext): InferenceEngine {
    const engine = this.engine as InferenceEngine & { traceContext?: TraceContext };
    if ('traceContext' in engine) engine.traceContext = context;
    return engine;
  }

  async ask(prompt: string, projectRoot: string, executeTool: AgentToolExecutor, conversationHistory: ChatTurn[] = [], options: { allowDelegation?: boolean; recordHistory?: boolean; images?: string[] } = {}): Promise<string> {
    const topLevel = this.askDepth === 0;
    if (topLevel) { this.trajectorySteps = []; this.trajectorySystem = ''; this.lastTrajectory = null; }
    this.askDepth += 1;
    try {
      const answer = await this.runAsk(prompt, projectRoot, executeTool, conversationHistory, options);
      if (topLevel) this.lastTrajectory = { prompt, model: this.engine.getModelStatus().modelId, system: this.trajectorySystem.slice(0, 30000), steps: this.trajectorySteps || [], answer };
      return answer;
    } finally {
      this.askDepth -= 1;
      if (topLevel) this.trajectorySteps = null;
    }
  }

  private async runAsk(prompt: string, projectRoot: string, executeTool: AgentToolExecutor, conversationHistory: ChatTurn[] = [], options: { allowDelegation?: boolean; recordHistory?: boolean; images?: string[] } = {}): Promise<string> {
    if (!prompt.trim()) throw new Error('Escriu una tasca.');
    if (options.allowDelegation === undefined) options = { ...options, allowDelegation: this.allowDelegation };
    const directInspection = explicitLocalInspectionRequest(prompt);
    if (directInspection) {
      const inspectionUrl = directInspection.name === 'inspect_browser' ? directInspection.arguments.url : '';
      this.onStatus({ type: 'status', message: `Inspeccionant ${inspectionUrl}…` });
      let result: unknown;
      try { result = await executeTool(directInspection); }
      catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
      const answer = formatBrowserInspection(result) || 'La inspecció no ha retornat cap resultat verificat.';
      await fs.mkdir(this.historyDir, { recursive: true });
      await fs.appendFile(path.join(this.historyDir, 'sessions.jsonl'), JSON.stringify({
        at: new Date().toISOString(), model: this.engine.getModelStatus().modelId, prompt, answer,
      }) + '\n');
      this.onStatus({ type: 'status', message: 'Inspecció completada amb el resultat retornat per l’eina.' });
      return answer;
    }
    const directProjectStart = await explicitProjectStartRequest(prompt, projectRoot);
    if (directProjectStart?.name === 'start_project') {
      const startScript = directProjectStart.arguments.script;
      this.onStatus({ type: 'status', message: `Iniciant el projecte amb npm run ${startScript}…` });
      let result: unknown;
      try { result = await executeTool(directProjectStart); }
      catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
      const value = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      const startAnswer = typeof value.error === 'string'
        ? `No he pogut iniciar l’app: ${value.error}`
        : value.cancelled === true
          ? 'L’inici s’ha cancel·lat; no s’ha iniciat cap servidor.'
        : value.started !== true
          ? `El projecte no s’ha iniciat. Resultat de l’eina: ${JSON.stringify(result)}`
          : typeof value.url === 'string'
            ? `Projecte iniciat amb npm run ${startScript}. Adreça local: ${value.url}. ${value.openedInAppBrowser === true ? 'S’ha obert al navegador integrat.' : 'L’eina no ha confirmat que s’obrís al navegador integrat.'}`
            : `npm run ${startScript} s’ha iniciat, però la seva sortida encara no conté cap adreça local. Sortida: ${String(value.output || '(buida)').slice(0, 1500)}`;
      // What the app saw when it looked at the started page.
      const answer = typeof value.pageVerdict === 'string' && value.pageVerdict ? `${startAnswer}\n\n${value.pageVerdict}` : startAnswer;
      await fs.mkdir(this.historyDir, { recursive: true });
      await fs.appendFile(path.join(this.historyDir, 'sessions.jsonl'), JSON.stringify({
        at: new Date().toISOString(), model: this.engine.getModelStatus().modelId, prompt, answer,
      }) + '\n');
      this.onStatus({ type: 'status', message: 'Resultat real de l’inici del projecte registrat.' });
      return answer;
    }
    const compact = isSmallModel(this.engine.getModelStatus().modelId);
    const context = compact
      ? await this.collectContext(projectRoot, COMPACT_CONTEXT_BYTES, COMPACT_MANIFEST_ENTRIES)
      : await this.collectContext(projectRoot);
    const verifiedExperiences = compact ? '' : await this.collectVerifiedExperiences(prompt, projectRoot);
    // Without this the model tends to assume a project already exists and looks for a way to start it.
    const manifestFiles = context.manifest.split('\n').filter((line) => line && !line.endsWith('/') && !line.startsWith('…'));
    const hasEntry = manifestFiles.some((file) => /^(?:index\.html|(?:src\/)?(?:index|main|app)\.(?:tsx?|jsx?|mjs|cjs|py|php|go|rs))$/i.test(file.split(path.sep).join('/')));
    const codeFiles = manifestFiles.filter((file) => !/\.(?:md|txt)$/i.test(file));
    const projectState = codeFiles.length === 0
      ? promptText('context-folder-empty')
      : !hasEntry
        ? promptText('context-folder-no-entry', { files: manifestFiles.length })
        : promptText('context-folder-project', { files: manifestFiles.length });
    // AGENTS.md at the root of the project is the user's own standing instructions for it.
    // Every other file stays data: only this one, by name, is obeyed.
    let projectInstructions = '';
    for (const name of ['AGENTS.md', 'agents.md', 'Agents.md']) {
      try {
        const text = (await fs.readFile(path.join(projectRoot, name), 'utf8')).trim().slice(0, compact ? 1200 : 4000);
        if (text) { projectInstructions = promptText('context-agents-md', { text }); break; }
      } catch { /* no instructions file */ }
    }
    // A web address in the message is read by the app itself, before the model starts: whether the
    // page gets read does not depend on the model remembering to ask for it.
    let requestedPages = '';
    const addresses = [...new Set((prompt.match(/https?:\/\/[^\s<>"')\]]+/gi) || []).map((address) => address.replace(/[.,;:!?]+$/, '')))]
      .filter((address) => !/^https?:\/\/(?:localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(address)).slice(0, 2);
    for (const address of addresses) {
      this.onStatus({ type: 'status', message: `Llegint ${address.slice(0, 90)}…` });
      try {
        const page = await executeTool({ name: 'read_web_page', arguments: { url: address } }) as { text?: unknown; title?: unknown } | null;
        const text = page && typeof page.text === 'string' ? page.text.trim() : '';
        if (text) requestedPages += `\n\n--- ${address}${typeof page?.title === 'string' && page.title ? ` (${page.title})` : ''}\n${text.slice(0, compact ? 1500 : 6000)}`;
        else requestedPages += `\n\n--- ${address}\n(la pàgina no ha retornat text llegible)`;
      } catch (error) { requestedPages += `\n\n--- ${address}\n(no s’ha pogut llegir: ${error instanceof Error ? error.message : String(error)})`; }
    }
    if (requestedPages) requestedPages = promptText('context-web-pages', { pages: requestedPages });
    // mcp.json: programs the project plugs in to give the agent knowledge it lacks (a library's own
    // documentation, for instance). Their tools are listed up front so the model knows they exist.
    let mcpTools = '';
    if (!compact) {
      let declared = false;
      for (const name of ['mcp.json', '.mcp.json']) { try { await fs.access(path.join(projectRoot, name)); declared = true; break; } catch { /* not there */ } }
      if (declared) {
        this.onStatus({ type: 'status', message: 'Connectant amb els servidors MCP del projecte…' });
        try {
          const listed = await executeTool({ name: 'list_mcp_tools' }) as { servers?: { server?: unknown; error?: unknown; tools?: { name?: unknown; description?: unknown; parameters?: unknown; required?: unknown }[] }[] } | null;
          const lines: string[] = [];
          for (const server of Array.isArray(listed?.servers) ? listed.servers : []) {
            if (typeof server.server !== 'string') continue;
            if (typeof server.error === 'string') { lines.push(`- ${server.server}: no disponible (${server.error.slice(0, 160)})`); continue; }
            for (const tool of Array.isArray(server.tools) ? server.tools.slice(0, 12) : []) {
              if (typeof tool.name !== 'string') continue;
              const parameters = Array.isArray(tool.parameters) ? tool.parameters.filter((item): item is string => typeof item === 'string').join(', ') : '';
              lines.push(`- servidor "${server.server}", eina "${tool.name}"${parameters ? ` (arguments: ${parameters})` : ''}: ${typeof tool.description === 'string' ? tool.description.slice(0, 160) : ''}`);
            }
          }
          if (lines.length) mcpTools = promptText('context-mcp', { servers: lines.join('\n').slice(0, 3500) });
        } catch { /* the project works without its MCP servers */ }
      }
    }
    // SKILLS.md, next to AGENTS.md: the user's own catalogue of profiles and ways of working. The model
    // always sees the titles; the full text of a skill is added only when the message calls for it.
    let projectSkills = '';
    for (const name of ['SKILLS.md', 'skills.md', 'Skills.md']) {
      try {
        const skills = parseSkills(await fs.readFile(path.join(projectRoot, name), 'utf8'));
        if (skills.length === 0) continue;
        const active = matchSkills(skills, prompt);
        if (active.length > 0) this.onStatus({ type: 'status', message: `Perfil actiu: ${active.map((skill) => skill.title).join(' + ')}` });
        const perSkill = compact ? 800 : 2500;
        projectSkills = [
          active.length > 0 ? promptText('context-skills-active', { which: active.length === 1 ? 'aquest perfil' : 'aquests perfils', skills: active.map((skill) => `## ${skill.title}\n${skill.body.slice(0, perSkill)}`).join('\n\n') }) : '',
          compact ? '' : promptText('context-skills-list', { titles: skills.map((skill) => skill.title).join(' · ').slice(0, 1500) }),
        ].filter(Boolean).join('\n\n');
        break;
      } catch { /* no skills file */ }
    }
    const baseSystem = compact ? tidyBlankLines(promptText('system-compact', { folder: path.resolve(projectRoot), projectState, projectInstructions, projectSkills, requestedPages, files: context.manifest || '(la carpeta és buida)', contents: context.contents ? promptText('context-compact-contents', { contents: context.contents }) : '' })) : tidyBlankLines(promptText('system', { model: this.engine.getModelStatus().modelId, runtime: process.env.AGENT_MODEL_RUNTIME === 'transformers' ? 'Transformers.js' : process.env.AGENT_MODEL_RUNTIME === 'cuda' ? 'CUDA (Linux)' : 'MLX d’Apple', folder: path.resolve(projectRoot), projectState, delegation: options.allowDelegation === false
        ? promptText('system-delegated-agent')
        : promptText('system-delegation'), web: this.webSearch ? promptText('system-web-search') : promptText('system-web-pages'), delegationTools: options.allowDelegation === false ? promptText('system-tools-no-delegation') : promptText('system-tools-delegation'), projectInstructions, projectSkills, mcpTools, requestedPages, files: context.manifest || '(no s’han trobat fitxers visibles)', contents: context.contents || '(no hi ha fitxers de text compatibles dins del límit)', experiences: verifiedExperiences || '(no n’hi ha cap de prou similar)' }));
    // With a model that sees images, the text of prompts/vision.md (if there is any) follows the instructions.
    // Its HTML comments are notes for whoever edits it, not text for the model.
    const visionText = process.env.AGENT_MODEL_VISION === '1' ? promptText('vision').replace(/<!--[\s\S]*?-->/g, '').trim() : '';
    const system = visionText ? `${baseSystem}\n\n${visionText}` : baseSystem;
    // Log del model (only while it is on): who asks, and where each piece of the system prompt comes from.
    const traceOn = Boolean((this.engine as { tracer?: { enabled?: boolean } }).tracer?.enabled);
    const systemTrace: TraceContext = {
      source: this.askDepth > 1 ? 'agent delegat' : (process.env.AGENT_LLM_TRACE_SOURCE || 'xat'),
      systemParts: traceOn ? splitSystem(system, [
        { source: 'AGENTS.md', text: projectInstructions }, { source: 'SKILLS.md', text: projectSkills }, { source: 'eines MCP', text: mcpTools },
        { source: 'casos verificats recuperats', text: verifiedExperiences }, { source: 'pàgines demanades', text: requestedPages },
        { source: 'llista de fitxers', text: context.manifest || '' }, { source: 'contingut de fitxers', text: context.contents || '' }, { source: 'prompts/vision.md', text: visionText },
      ], compact ? 'prompts/system-compact.md' : 'prompts/system.md') : [],
    };

    await this.engine.loadModel((message) => this.onStatus({ type: 'status', message }));
    const recentHistory = conversationHistory.slice(-100).flatMap((turn) => {
      if (!turn || !['user', 'assistant'].includes(turn.role) || typeof turn.content !== 'string') return [];
      const content = turn.content.trim();
      if (!content || content.length > 2000 || (turn.role === 'assistant' && /(?:"type"\s*:\s*"tool_call"|<tool_call>|<\|tool_call\|>)/i.test(content))) return [];
      return [{ role: turn.role, content } as ChatTurn];
    });
    if (this.askDepth === 1) this.trajectorySystem = system;
    const messages: ChatTurn[] = [
      { role: 'system', content: system },
      ...recentHistory,
      { role: 'user', content: prompt },
    ];
    // Images of this request (files written by the app) go with the user's message of this request only:
    // not with the history of later ones, nor to the reviewer or the delegated agents.
    const imageInput = options.images?.length ? { paths: options.images.slice(0, 4), message: messages.length - 1 } : undefined;
    // A real app creation needs more than a few model turns (inspect, create
    // source files, install, check, start, then inspect in the local browser).
    // The small model gets a short leash; the larger one has room for real files and longer jobs.
    const answerTokens = compact ? 700 : this.answerTokens;
    const maxIterations = compact ? 16 : this.maxIterations;
    const followUpRefersToUnfinishedTask = /\b(?:el que t['’]he demanat|el que he demanat|la tasca|aquesta tasca|continua|segueix|fes-ho|fesho|acaba-ho|acabal|mira el que diu|ell mateix t['’]explica|que quadri|quadra|no ho ha fet|no ho has fet|do what i asked|continue|finish it|make it work)\b/i.test(prompt);
    const unfinishedPriorCodingRequest = followUpRefersToUnfinishedTask
      ? [...conversationHistory].reverse().find((turn) => turn?.role === 'user' && typeof turn.content === 'string' && /\b(?:app|application|aplicaci[oó]|projecte|project|proyecto)\b/i.test(turn.content) && /\b(?:fes|crea|crear|fer|faci|build|create|implement|fix|modifica|canvia|programa)\b/i.test(turn.content))?.content
      : undefined;
    const effectivePrompt = unfinishedPriorCodingRequest
      ? `${unfinishedPriorCodingRequest}\n\nSeguiment actual de l’usuari: ${prompt}`
      : prompt;
    // What the user asks for is read from their own words: pasted URLs, code and command lines are left
    // out, so a word inside them («…/chakra-ui-refactor», «npm run build») does not change the request.
    const intentPrompt = requestWords(prompt);
    const intentEffectivePrompt = requestWords(effectivePrompt);
    const explicitNoChange = /\b(?:do not (?:change|modify|edit)|don't (?:change|modify|edit)|no (?:modifiquis|canviïs|edites)|sense (?:canviar|modificar)|sin (?:cambiar|modificar)|no modifiques)\b/i.test(intentPrompt);
    const requestedAction = /\b(?:fes|crea|executa|prova|corregeix|canvia|modifica|actualitza|inicia|atura|instal·la|instaŀla|instal\.la|instala|installa|implementa|afegeix|elimina|esborra|prepara|revisa|compila|commit|run|start|stop|fix|change|modify|implement|create|install|build|test|posa|posar|embolica|envolta|arrenca|engega|obre|treu|mou|escriu|reanomena|substitueix|usa|pon|poner|envuelve|arranca|abre|quita|mueve|escribe|renombra|sustituye|añade|agrega|borra|ejecuta|lanza|inicia)\b/i.test(intentEffectivePrompt);
    const unnecessaryQuestion = /\b(?:vols que|vols que ho|hauria de|necessito saber|em pots dir|pots indicar|would you like me to|do you want me to|should i|can you provide|could you clarify|please tell me which)\b/i;
    // «Posa'l en marxa» (start it) is not a change to the code; «posa un botó» is.
    const implementationVerb = /\b(?:fix|correct|change|modify|implement|update|create|creates|creating|build|make|write|generate|scaffold|crea|crear|creare|crearàs|construeix|construir|haz|hacer|fes|facis|faci|fer|feu|fem|munta|muntar|genera|generar|desenvolupa|desarrolla|programa|corregeix|corregir|canvia|cambia|modifica|actualitza|actualiza|refactor|bug|error|(?:posa|posar|pon|poner)(?!(?:['’][a-z]+)?\s+en\s+(?:marxa|funcionament|marcha|funcionamiento)\b)|embolica|envolta|treu|mou|escriu|reanomena|substitueix|envuelve|quita|mueve|escribe|renombra|sustituye|añade|agrega|borra)\b/i;
    const appTargetMentioned = /\b(?:app|application)\b|aplicaci[oó](?=$|[^\p{L}\p{N}_])/iu.test(intentEffectivePrompt);
    const projectTargetMentioned = appTargetMentioned || /\b(?:project|projecte|proyecto)\b/i.test(intentEffectivePrompt);
    const creationModeMentioned = /\b(?:from scratch|de zero|desde cero|de cero|new|nou|nuevo|create|creating|crea|crear|build|construeix|haz)\b|nova(?=$|[^\p{L}\p{N}_])/iu.test(intentEffectivePrompt);
    const directAppImperative = appTargetMentioned && /\b(?:fes|facis|faci|fer|feu|fem)\b/i.test(intentEffectivePrompt);
    const requestedProjectCreation = !explicitNoChange && projectTargetMentioned && implementationVerb.test(intentPrompt) && (creationModeMentioned || directAppImperative);
    const requestedCommitOnly = /^\s*(?:fes|crea|crear|create|make|do)\s+(?:un\s+)?commit\b/i.test(intentPrompt);
    const requestedCodeChange = !explicitNoChange && (requestedProjectCreation || (!requestedCommitOnly && implementationVerb.test(intentPrompt)));
    const requestedValidation = /\b(?:test|tests|proves|prova|pruebas|prueba|lint|typecheck|build|compila|compilar|validate|validar|verify|verifica|comprova|comprueba)\b/i.test(intentEffectivePrompt);
    let toolOutputSize = 0;
    let answer = '';
    let plan = '';
    let projectChangedSinceCheck = false;
    let changeApplied = false;
    let writeFileAttempted = false;
    let writeFileError = '';
    let checkPassed = false;
    let failedCheckToRetry: AgentToolCall | null = null;
    let lastToolActivity = '';
    // Tool calls run in this turn: an answer that says it is done before any is a «claimed done» (turn log).
    let toolCallsRun = 0;
    let planPublished = false;
    const appliedProjectFiles = new Set<string>();
    let lastPageVerdict = '';
    let reviewed = false;
    let toolsRun = 0;
    let reviewNote = '';
    let completionNudges = 0;
    const maxCompletionNudges = 4;
    const completedToolCalls = new Map<string, string>();
    // The failed check the agent has just told the model not to repeat; asking for it again right away means it is stuck.
    let nudgedCheck: string | null = null;
    const incompleteAnswer = () => {
      if (requestedCodeChange && !changeApplied) {
        if (writeFileAttempted && writeFileError) return `No he pogut completar la tasca: l’eina d’escriptura ha retornat aquest error real: ${writeFileError}`;
        if (!writeFileAttempted) return `No he pogut completar la tasca: no s’ha aplicat cap canvi ni he escrit cap fitxer. La carpeta seleccionada és ${path.resolve(projectRoot)} i no he rebut cap error d’accés, perquè no he arribat a cridar l’eina d’escriptura. No consideris el pla com a feina feta.`;
        return 'No he pogut completar la tasca: no s’ha aplicat cap canvi perquè l’eina d’escriptura no ha confirmat cap fitxer. No consideris el pla com a feina feta.';
      }
      if (requestedProjectCreation && !hasApplicationEntry()) return 'No he pogut completar la creació: s’ha escrit algun fitxer, però falta un punt d’entrada de l’aplicació. No consideris un manifest o una configuració com una app acabada.';
      if (requestedValidation && changeApplied && !checkPassed) return 'No he pogut completar la tasca: he aplicat un canvi, però no he verificat que les proves passin. Revisa el canvi abans de considerar-la acabada.';
      return 'No he pogut completar la tasca dins del límit d’intents. Revisa els resultats disponibles abans de considerar-la acabada.';
    };
    const hasApplicationEntry = () => [...appliedProjectFiles].some((file) => /^(?:(?:src\/)?(?:pages\/(?:index|_app)|app\/(?:page|layout))|src\/app\/(?:page|layout)|(?:src\/)?(?:index|main|App))\.(?:tsx?|jsx?|html)$/i.test(file));
    const missingWork = () => requestedProjectCreation && !hasApplicationEntry()
      ? changeApplied
        ? promptText('nudge-app-entry-missing')
        : promptText('nudge-app-no-files', { folder: path.resolve(projectRoot) })
      : requestedCodeChange && !changeApplied
        ? promptText('nudge-no-change')
        : requestedValidation && changeApplied && !checkPassed
        ? promptText('nudge-not-validated')
        : null;
    let automaticProjectInspectionCompleted = false;
    const inspectProjectForCreation = async (planningText = '') => {
      const planningProse = withoutToolCalls(planningText);
      if (!planPublished && planningProse) {
        planPublished = true;
        this.onStatus({ type: 'plan', message: planningProse.slice(0, 3000) });
      }
      automaticProjectInspectionCompleted = true;
      this.onStatus({ type: 'status', message: 'Inspeccionant la carpeta abans de crear l’app…' });
      let result: unknown;
      try { result = await executeTool({ name: 'list_files' }); }
      catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
      const bounded = JSON.stringify(result).slice(0, 12000);
      messages.push(
        // Written as the model's own calls come back in the history (<tool_call>{json}</tool_call>): a JSON
        // action here taught the model to answer in that form, which it then broke (15-11-2026).
        { role: 'assistant', content: `<tool_call>${JSON.stringify({ name: 'list_files', arguments: {} })}</tool_call>` },
        { role: 'user', content: promptText('nudge-after-list-files', { result: bounded }) },
      );
    };
    // Profiles: the programmer is the loop below. The reviewer is the same local model with other
    // instructions and none of the programmer's conversation: it sees the request, the files as they
    // are on disk and what the app saw on the page, and can send the programmer back once.
    const reviewChanges = async (): Promise<string | null> => {
      // Only files written in this request are reviewed: after an install or a command that ended well
      // there is nothing for the reviewer to read, and it would send the programmer back for nothing.
      if (!this.reviewChanges || compact || reviewed || !changeApplied || appliedProjectFiles.size === 0 || options.recordHistory === false) return null;
      reviewed = true;
      this.onStatus({ type: 'status', message: 'Revisor: comprovant el que ha escrit el programador…' });
      const files: string[] = [];
      let budget = 9000;
      for (const file of appliedProjectFiles) {
        if (budget <= 0) break;
        try {
          const text = (await fs.readFile(path.join(projectRoot, file), 'utf8')).slice(0, Math.min(3000, budget));
          budget -= text.length;
          files.push(`--- ${file}\n${text}`);
        } catch { files.push(`--- ${file}\n(no s’ha pogut llegir)`); }
      }
      const reviewMessages: ChatTurn[] = [
        { role: 'system', content: promptText('review-system') },
        { role: 'user', content: tidyBlankLines(promptText('review-request', { request: prompt.slice(0, 1500), projectInstructions, files: files.join('\n\n') || '(cap)', page: lastPageVerdict ? promptText('review-page-seen', { page: lastPageVerdict.slice(0, 1200) }) : promptText('review-page-not-opened') })) },
      ];
      let verdict = '';
      try { verdict = await this.traced({ source: 'revisor' }).generateResponse(reviewMessages, { max_new_tokens: 350, temperature: 0.1, do_sample: false, tools: [] }); }
      catch { return null; }
      await logTurn({ iteration: 'review', compact, lastInput: reviewMessages[1].content.slice(0, 1500), raw: verdict.slice(0, 1500), parsed: 'review' });
      let problems: string[] = [];
      try {
        const parsed = JSON.parse(verdict.slice(verdict.indexOf('{'), verdict.lastIndexOf('}') + 1)) as { ok?: unknown; problems?: unknown };
        if (parsed.ok === false && Array.isArray(parsed.problems)) problems = parsed.problems.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 3).map((item) => item.trim().slice(0, 400));
      } catch { /* an unreadable verdict never blocks the answer */ }
      if (problems.length === 0) { reviewNote = 'Revisor: ha llegit els fitxers escrits i no hi ha trobat cap problema.'; return null; }
      reviewNote = `Revisor: ha demanat corregir això abans d’acabar: ${problems.join(' · ')}`;
      this.onStatus({ type: 'status', message: `Revisor: ${problems.length === 1 ? 'ha trobat un problema' : `ha trobat ${problems.length} problemes`}; el programador ho corregeix…` });
      return promptText('review-fixes', { problems: problems.map((item, index) => `${index + 1}. ${item}`).join('\n'), recheck: lastPageVerdict ? promptText('review-fix-recheck-page') : '' });
    };
    // Asked to do something, the model sometimes answers with the plan and stops there. A plan is not
    // an answer: it is told to carry it out, and if it never does, the reply says so plainly.
    // (A word ending in «é» has no \b after it in JavaScript: the future tense is matched with letter look-arounds.)
    // A «Pla:»/«Plan:» heading, or an answer that ends announcing it starts («Començo.»), is a plan
    // whatever the request said.
    const planMarkers = (text: string) => /(?:^|\n)\s*(?:[#*_>\s]*)(?:pla|plan)\s*(?:\*\*)?\s*:/i.test(text) || /(?:^|[\s.!])(?:Començo|Empiezo|Comienzo|Vaig)\.\s*$/u.test(text.trim());
    const onlyAPlan = (text: string) => toolsRun === 0 && !changeApplied
      && ((requestedAction && (/^\s*(?:pla\b|plan\b)/i.test(text) || /(?<!\p{L})\p{L}{3,}(?:aré|eré|iré)(?!\p{L})/iu.test(text) || /\bI(?:'ll| will)\b/.test(text))) || planMarkers(text));
    const carryOutPlan = promptText('nudge-carry-out-plan');
    const planNeverRun = 'He escrit el pla però no he arribat a executar-ne cap pas: no he instal·lat res ni he tocat cap fitxer. Torna-m’ho a demanar, si pot ser dient el primer pas concret (per exemple «instal·la el paquet que necessites»).';
    for (let iteration = 0; iteration < maxIterations + 2; iteration += 1) {
      const modelActivity = iteration === 0
        ? 'El model està analitzant la tasca i el projecte…'
        : lastToolActivity
          ? `El model està revisant el resultat: ${lastToolActivity}…`
          : plan
            ? `El model està triant l’acció següent segons el pla: ${plan}`
            : 'El model està decidint el pas següent…';
      this.onStatus({ type: 'progress', iteration: Math.min(iteration + 1, maxIterations), maxIterations });
      this.onStatus({ type: 'status', message: modelActivity });
      const availableTools = compact
        ? agentToolDefinitions.filter((item) => COMPACT_TOOL_NAMES.has(item.function.name))
        : agentToolDefinitions.filter((item) => (options.allowDelegation !== false || item.function.name !== 'delegate_tasks') && (this.webSearch || item.function.name !== 'web_search'));
      const startedAt = Date.now();
      const raw = await this.traced(systemTrace).generateResponse(messages, { max_new_tokens: answerTokens, temperature: 0.2, do_sample: false, images: imageInput, tools: describedTools(availableTools) });
      const action = parseAction(raw);
      // An answer with no call while no tool has run yet in a turn that asks for work: it says it is done
      // without having done anything. Marked in the log, so the evaluation and the history can count it.
      const claimedWithoutTools = claimedDoneWithoutTools({ toolCallsRun, requestedWork: requestedAction || requestedCodeChange, action });
      await logTurn({ iteration, compact, seconds: Math.round((Date.now() - startedAt) / 1000), promptChars: messages.reduce((n, m) => n + m.content.length, 0), prompt: iteration === 0 ? prompt.slice(0, 500) : undefined, lastInput: messages[messages.length - 1]?.content.slice(0, 600), raw: String(raw).slice(0, 3000), parsed: action ? action.type === 'tool_call' ? `tool_call:${action.name}` : action.type : 'unparsed', ...(claimedWithoutTools ? { claimedDoneWithoutTools: true } : {}) });
      if (!action) {
        const rawProse = withoutToolCalls(raw);
        if (requestedCodeChange && !planPublished && /\b(?:pla|passos|pass|primer|abans de|per completar|plan|steps|first|to complete)\b/i.test(rawProse)) {
          planPublished = true;
          this.onStatus({ type: 'plan', message: rawProse.slice(0, 3000) });
        }
        if (requestedProjectCreation && !hasApplicationEntry() && !automaticProjectInspectionCompleted) {
          messages.push({ role: 'assistant', content: raw });
          await inspectProjectForCreation(raw);
          continue;
        }
        if (onlyAPlan(raw)) {
          if (completionNudges < maxCompletionNudges) { completionNudges += 1; messages.push({ role: 'assistant', content: raw }, { role: 'user', content: carryOutPlan }); continue; }
          answer = planNeverRun;
          break;
        }
        const unmet = missingWork();
        if (unmet && completionNudges < maxCompletionNudges) {
          completionNudges += 1;
          messages.push({ role: 'assistant', content: raw }, { role: 'user', content: unmet });
          continue;
        }
        if (!unmet) {
          const fixes = await reviewChanges();
          if (fixes) { this.onStatus({ type: 'draft', message: raw.slice(0, 30000) }); messages.push({ role: 'assistant', content: raw }, { role: 'user', content: fixes }); continue; }
        }
        answer = unmet ? incompleteAnswer() : raw;
        break;
      }
      if (action.type === 'plan') {
        plan = (withoutToolCalls(action.content) || action.content).slice(0, 1000);
        if (!planPublished) this.onStatus({ type: 'plan', message: plan });
        planPublished = true;
        messages.push({ role: 'assistant', content: promptText('assistant-plan-brief', { plan }) }, { role: 'user', content: promptText('nudge-execute-plan') });
        continue;
      }
      if (action.type === 'final') {
        if (requestedCodeChange && !planPublished && /\b(?:pla|passos|pass|primer|abans de|per completar|plan|steps|first|to complete)\b/i.test(action.content)) {
          planPublished = true;
          this.onStatus({ type: 'plan', message: action.content.slice(0, 3000) });
        }
        if (requestedAction && unnecessaryQuestion.test(action.content) && completionNudges < maxCompletionNudges) {
          completionNudges += 1;
          messages.push({ role: 'assistant', content: raw }, { role: 'user', content: promptText('nudge-no-questions') });
          continue;
        }
        if (requestedProjectCreation && !hasApplicationEntry() && !automaticProjectInspectionCompleted) {
          messages.push({ role: 'assistant', content: raw });
          await inspectProjectForCreation(raw);
          continue;
        }
        if (onlyAPlan(action.content)) {
          if (completionNudges < maxCompletionNudges) { completionNudges += 1; messages.push({ role: 'assistant', content: raw }, { role: 'user', content: carryOutPlan }); continue; }
          answer = planNeverRun;
          break;
        }
        const unmet = missingWork();
        if (unmet && completionNudges < maxCompletionNudges) {
          completionNudges += 1;
          messages.push({ role: 'assistant', content: raw }, { role: 'user', content: unmet });
          continue;
        }
        if (!unmet) {
          const fixes = await reviewChanges();
          if (fixes) { this.onStatus({ type: 'draft', message: action.content.slice(0, 30000) }); messages.push({ role: 'assistant', content: raw }, { role: 'user', content: fixes }); continue; }
        }
        answer = unmet ? incompleteAnswer() : action.content;
        break;
      }
      const tool = validateToolCall(action);
      if (tool?.name === 'web_search' && !this.webSearch) {
        messages.push({ role: 'assistant', content: raw }, { role: 'user', content: promptText('nudge-no-web-search') });
        continue;
      }
      if (!tool || (tool.name === 'delegate_tasks' && options.allowDelegation === false)) {
        // A tool that is not offered (or not at all) is named as such, with the list of those that are;
        // a tool that exists but came with wrong or missing arguments is asked again, never «not available».
        const offered = availableTools.map((item) => item.function.name);
        const known = offered.includes(action.name) || action.name === 'list_mcp_tools';
        messages.push({ role: 'assistant', content: raw }, { role: 'user', content: known ? promptText('nudge-invalid-call') : promptText('nudge-unknown-tool', { name: action.name.slice(0, 80), tools: offered.join(', ') }) });
        continue;
      }
      // A small model that already chose the right tool is not sent back to write a plan first: that
      // throws the call away and costs two more slow generations.
      if (!planPublished && action.plan && withoutToolCalls(action.plan)) {
        plan = withoutToolCalls(action.plan).slice(0, 3000);
        planPublished = true;
        this.onStatus({ type: 'plan', message: plan });
      }
      if (requestedCodeChange && !planPublished && !compact) {
        messages.push({ role: 'assistant', content: raw }, { role: 'user', content: promptText('nudge-write-plan') });
        this.onStatus({ type: 'status', message: 'El model està escrivint el pla abans de començar…' });
        const planningRaw = await this.traced(systemTrace).generateResponse(messages, { max_new_tokens: 300, temperature: 0.2, do_sample: false, images: imageInput, tools: [] });
        const planningAction = parseAction(planningRaw);
        // A call instead of a plan (even to a tool that does not exist, like «plan») is not a plan:
        // its markup is never published, and the plan is the prose around it or the default one.
        const plannedText = withoutToolCalls(planningAction?.type === 'plan'
          ? planningAction.content
          : planningAction?.type === 'final'
            ? planningAction.content
            : planningAction?.type === 'tool_call'
              ? planningAction.plan || planningRaw
              : planningRaw);
        plan = (plannedText || 'Inspeccionaré el projecte, aplicaré els canvis demanats i comprovaré el resultat.').slice(0, 3000);
        planPublished = true;
        this.onStatus({ type: 'plan', message: plan });
        messages.push(
          { role: 'assistant', content: promptText('assistant-plan-published', { plan }) },
          { role: 'user', content: promptText('nudge-plan-visible') },
        );
        continue;
      }
      messages.push({ role: 'assistant', content: raw });
      // Committing is the user's call. A model that tidies up with a commit nobody asked for is told so,
      // instead of being left to fight a folder that may not even be a repository.
      if (tool.name === 'create_git_commit' && !/\b(?:commit|git)\b/i.test(prompt)) {
        messages.push({ role: 'user', content: promptText('nudge-no-commit') });
        continue;
      }
      const toolKey = JSON.stringify(tool);
      const repeatsNudgedCheck = nudgedCheck === toolKey;
      nudgedCheck = null;
      const previousResult = completedToolCalls.get(toolKey);
      const isCheck = tool.name === 'run_tests' || tool.name === 'run_project_script';
      if (previousResult !== undefined && !(isCheck && projectChangedSinceCheck)) {
        if (isCheck && !checkPassed && !projectChangedSinceCheck) {
          // Told once already and asked again: nudging again only makes a loop, so the turn ends here.
          if (repeatsNudgedCheck) {
            answer = `M’he aturat: el model ha tornat a demanar ${tool.name} sense canviar res, després d’haver-li dit que ja havia fallat, i entrava en bucle. Resultat de l’última comprovació: ${previousResult.slice(0, 800)}`;
            break;
          }
          nudgedCheck = toolKey;
          messages.push({ role: 'user', content: promptText('nudge-check-failed-repeat') });
          continue;
        }
        if (missingWork()) {
          answer = incompleteAnswer();
          break;
        }
        this.onStatus({ type: 'status', message: `No repetiré ${tool.name}; ja s’ha executat amb aquests arguments.` });
        messages.push({ role: 'user', content: promptText('nudge-repeated-call', { tool: tool.name, result: previousResult }) });
        const finalRaw = await this.traced(systemTrace).generateResponse(messages, { max_new_tokens: answerTokens, temperature: 0.2, do_sample: false, images: imageInput, tools: describedTools(agentToolDefinitions.filter((item) => (options.allowDelegation !== false || item.function.name !== 'delegate_tasks') && (this.webSearch || item.function.name !== 'web_search'))) });
        const finalAction = parseAction(finalRaw);
        answer = finalAction?.type === 'final'
          ? finalAction.content
          : finalAction?.type === 'tool_call'
            ? `L’eina ${tool.name} s’ha executat una vegada. El model ha intentat repetir-la, així que he aturat les crides duplicades. Resultat real: ${previousResult}`
            : finalRaw;
        break;
      }
      const args = 'arguments' in tool ? tool.arguments as Record<string, string> : {};
      if (tool.name === 'write_file') writeFileAttempted = true;
      const activity: Record<string, string> = { list_files: 'Llegint l’estructura del projecte…', read_file: `Llegint ${args.path || 'un fitxer'}…`, search_text: `Cercant «${args.query || ''}»…`, install_dependencies: 'Instal·lant les dependències de package.json…', run_npx: `Executant npx ${args.packageName || ''} ${Array.isArray(args.args) ? args.args.join(' ') : ''}…`, web_search: `Cercant a Internet «${args.query || ''}»…`, read_web_page: `Llegint ${String(args.url || 'una pàgina').slice(0, 80)}…`, call_mcp_tool: `Consultant ${args.server || 'MCP'}: ${args.tool || ''}…`, list_mcp_tools: 'Mirant els servidors MCP del projecte…', delegate_tasks: `Preparant ${Array.isArray(args.tasks) ? args.tasks.length : ''} agents delegats…`, write_file: `Aplicant el canvi a ${args.path || 'un fitxer'}…`, delete_file: `Preparant l’eliminació de ${args.path || 'un fitxer'} per revisar-la…`, run_tests: 'Executant les proves…', run_project_script: `Executant l’script ${args.script || ''}…`, start_project: `Iniciant l’app (${args.script || ''})…`, stop_project: 'Aturant l’app…', create_git_commit: 'Creant el commit de Git…', install_package: `Preparant la instal·lació de ${args.packageName || 'la llibreria'} per revisar-la…`, inspect_browser: `Inspeccionant ${args.url || 'la pàgina local'}…` };
      lastToolActivity = activity[tool.name] || `Executant ${tool.name}`;
      toolCallsRun += 1;
      this.onStatus({ type: 'progress', iteration: Math.min(iteration + 1, maxIterations), maxIterations, tool: tool.name });
      this.onStatus({ type: 'status', message: lastToolActivity });
      let result: unknown;
      try {
        if (tool.name === 'delegate_tasks') {
          const delegated: { agent: string; task: string; result: string }[] = [];
          for (const [index, task] of tool.arguments.tasks.entries()) {
            this.onStatus({ type: 'status', message: `Agent delegat ${index + 1}/${tool.arguments.tasks.length}: ${task.slice(0, 100)}` });
            let delegatedResult: string;
            try {
              delegatedResult = await this.ask(promptText('delegated-task', { task }), projectRoot, executeTool, [], { allowDelegation: false, recordHistory: false });
            } catch (error) { delegatedResult = `Error: ${error instanceof Error ? error.message : String(error)}`; }
            delegated.push({ agent: `Agent ${index + 1}`, task, result: delegatedResult.slice(0, 5000) });
          }
          result = { delegatedSequentially: true, agents: delegated };
        } else if (tool.name === 'write_file' && this.engine.lastFinishReason === 'length') {
          // The answer was cut at the token limit: its file content is incomplete, so nothing is written.
          result = { applied: false, error: 'La resposta s’ha tallat al límit de tokens abans d’acabar i el fitxer no s’ha escrit.' };
        } else result = await executeTool(tool);
        toolsRun += 1;
      }
      catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
      // Once the project has really changed (a file written, a package installed…), earlier results are
      // stale: starting the project or reading a file again is a legitimate retry, not a repetition.
      {
        const outcome = result && typeof result === 'object' ? result as Record<string, unknown> : {};
        const changedProject = !outcome.error && !outcome.cancelled && (
          (tool.name === 'write_file' && outcome.applied === true)
          || (tool.name === 'install_package' && outcome.code === 0)
          || ['delete_file', 'rename_file', 'create_directory', 'restore_file'].includes(tool.name));
        if (changedProject) completedToolCalls.clear();
      }
      if (tool.name === 'write_file' && result && typeof result === 'object' && typeof (result as Record<string, unknown>).error === 'string') {
        writeFileError = String((result as Record<string, unknown>).error).slice(0, 500);
      }
      // A package's own tool usually writes files: after it, earlier checks are stale and may be repeated.
      if ((tool.name === 'run_npx' || tool.name === 'install_dependencies' || tool.name === 'install_package') && result && typeof result === 'object' && (result as Record<string, unknown>).code === 0) completedToolCalls.clear();
      // Installing (a package, the dependencies, a package's own tool) changes the project like writing a file does.
      if ((tool.name === 'run_npx' || tool.name === 'install_dependencies' || tool.name === 'install_package') && result && typeof result === 'object' && (result as Record<string, unknown>).code === 0) changeApplied = true;
      if (tool.name === 'write_file' && result && typeof result === 'object' && (result as Record<string, unknown>).applied === true) {
        projectChangedSinceCheck = true;
        changeApplied = true;
        appliedProjectFiles.add(String((result as Record<string, unknown>).path || (tool as Extract<AgentToolCall, { name: 'write_file' }>).arguments.path).replaceAll('\\', '/'));
        if (failedCheckToRetry) {
          const checkToRetry: AgentToolCall = failedCheckToRetry;
          this.onStatus({ type: 'status', message: `Tornant a executar ${checkToRetry.name} després del canvi…` });
          let retryResult: unknown;
          try { retryResult = await executeTool(checkToRetry); }
          catch (error) { retryResult = { error: error instanceof Error ? error.message : String(error) }; }
          const retryCode = retryResult && typeof retryResult === 'object' ? (retryResult as Record<string, unknown>).code : undefined;
          checkPassed = retryCode === 0;
          projectChangedSinceCheck = typeof retryCode !== 'number';
          failedCheckToRetry = typeof retryCode === 'number' && retryCode !== 0 ? checkToRetry : null;
          const retryText = JSON.stringify(retryResult);
          const retryRemaining = Math.max(0, 20000 - toolOutputSize);
          const boundedRetryText = retryText.slice(0, Math.min(12000, retryRemaining));
          completedToolCalls.set(JSON.stringify(checkToRetry), boundedRetryText || '(s’ha arribat al límit de context de les eines)');
          toolOutputSize += boundedRetryText.length;
          messages.push({ role: 'user', content: promptText('check-retry-result', { tool: checkToRetry.name, result: boundedRetryText || '(s’ha arribat al límit de context de les eines)', verdict: checkPassed ? promptText('check-retry-passed') : typeof retryCode === 'number' ? promptText('check-retry-still-failing') : promptText('check-retry-incomplete') }) });
        }
      }
      if (isCheck) {
        projectChangedSinceCheck = false;
        checkPassed = Boolean(result && typeof result === 'object' && (result as Record<string, unknown>).code === 0);
        const code = result && typeof result === 'object' ? (result as Record<string, unknown>).code : undefined;
        failedCheckToRetry = typeof code === 'number' && code !== 0 ? tool : null;
      }
      if (tool.name === 'inspect_browser') {
        let browserAnswer = formatBrowserInspection(result);
        // Asked whether a button works, looking is not enough: the app presses each button the page
        // shows (never one that deletes, sends or pays) and says what changed on screen.
        const looked = result && typeof result === 'object' ? result as { inspected?: unknown; text?: unknown; buttons?: unknown } : null;
        const calledWithActions = Array.isArray((tool as Extract<AgentToolCall, { name: 'inspect_browser' }>).arguments.actions);
        if (browserAnswer && looked?.inspected === true && !calledWithActions && /(?:^|[^\p{L}])(?:bot[oó]n?s?|buttons?|clic|click)(?![\p{L}])/iu.test(prompt) && Array.isArray(looked.buttons)) {
          const before = typeof looked.text === 'string' ? looked.text.replace(/\s+/g, ' ').trim() : '';
          const names = [...new Set(looked.buttons.filter((name): name is string => typeof name === 'string' && name.length > 0))]
            .filter((name) => !/elimina|esborra|borra|suprimeix|delete|remove|envia|send|submit|paga|pay|compra|buy|tanca la sessi|log ?out/i.test(name)).slice(0, 3);
          const lines: string[] = [];
          for (const name of names) {
            this.onStatus({ type: 'status', message: `Prement el botó «${name}»…` });
            try {
              const pressed = await executeTool({ name: 'inspect_browser', arguments: { url: (tool as Extract<AgentToolCall, { name: 'inspect_browser' }>).arguments.url, actions: [{ type: 'click', target: { by: 'role', role: 'button', value: name } }] } }) as { text?: unknown; consoleErrors?: unknown; error?: unknown } | null;
              const after = pressed && typeof pressed.text === 'string' ? pressed.text.replace(/\s+/g, ' ').trim() : '';
              const errors = pressed && Array.isArray(pressed.consoleErrors) ? pressed.consoleErrors.length : 0;
              if (pressed && typeof pressed.error === 'string') lines.push(`- Botó «${name}»: no s’ha pogut prémer (${pressed.error}).`);
              else if (after && after !== before) lines.push(`- Botó «${name}»: funciona. En prémer-lo, la pàgina passa de «${before.slice(0, 120)}» a «${after.slice(0, 120)}»${errors ? `, però amb ${errors} errors de consola` : ''}.`);
              else lines.push(`- Botó «${name}»: en prémer-lo no canvia res visible a la pàgina${errors ? ` i hi ha ${errors} errors de consola` : ''}.`);
            } catch (error) { lines.push(`- Botó «${name}»: no s’ha pogut prémer (${error instanceof Error ? error.message : String(error)}).`); }
          }
          if (lines.length) browserAnswer += `\n\nBotons provats (cadascun en una càrrega nova de la pàgina):\n${lines.join('\n')}`;
          else if (looked.buttons.length === 0) browserAnswer += '\n\nA la pàgina no hi ha cap botó visible per provar.';
        }
        // When the inspection closes a job that changed files, the answer says which ones first.
        if (browserAnswer && appliedProjectFiles.size > 0) browserAnswer = `He canviat ${[...appliedProjectFiles].join(', ')} i he comprovat la pàgina.\n\n${browserAnswer}`;
        if (browserAnswer) { answer = browserAnswer; break; }
      }
      // The app looks at the started page itself; a blank or broken page sends the model back to work.
      const pageVerdict = tool.name === 'start_project' && result && typeof result === 'object' ? String((result as Record<string, unknown>).pageVerdict || '') : '';
      const pageProblem = pageVerdict.startsWith('PROBLEMA');
      if (pageVerdict) lastPageVerdict = pageVerdict;
      // A page that loads, shows content and has a clean console is a passed check.
      if (pageVerdict && !pageProblem) checkPassed = true;
      if (pageProblem) this.onStatus({ type: 'status', message: 'La pàgina ha arrencat però no es veu bé; revisant…' });
      const toolText = JSON.stringify(result);
      const remaining = Math.max(0, 20000 - toolOutputSize);
      const boundedToolText = toolText.slice(0, Math.min(12000, remaining));
      completedToolCalls.set(toolKey, boundedToolText || '(s’ha arribat al límit de context de les eines)');
      toolOutputSize += boundedToolText.length;
      const failedCheck = (tool.name === 'run_tests' || tool.name === 'run_project_script') && result && typeof result === 'object' && (result as Record<string, unknown>).code !== 0;
      messages.push({ role: 'user', content: promptText('tool-result', { tool: tool.name, result: boundedToolText || '(s’ha arribat al límit de context de les eines)', page: pageProblem ? promptText('tool-result-page-problem', { pageVerdict, hint: pageFixHint(result) }) : '', next: failedCheck ? promptText('tool-result-check-failed') : promptText('tool-result-continue') }) });
      if (this.trajectorySteps && this.askDepth === 1) {
        // Exactly what the model saw back, so a training example built from this step matches a real turn.
        const outcome = result && typeof result === 'object' ? result as Record<string, unknown> : {};
        this.trajectorySteps.push({ name: tool.name, arguments: 'arguments' in tool && tool.arguments ? tool.arguments as Record<string, unknown> : {}, result: messages[messages.length - 1].content.slice(0, 6000), ok: !outcome.error && !outcome.cancelled && (typeof outcome.code !== 'number' || outcome.code === 0) });
      }
      if (toolOutputSize >= 20000) {
        messages.push({ role: 'user', content: promptText('nudge-context-limit') });
      }
    }
    if (!answer) answer = missingWork() ? incompleteAnswer() : 'He arribat al límit de consultes d’eines. Resumeixo la informació disponible sense afirmar canvis no executats.';
    // The reviewer's note is the app's, not the model's: it goes to the window on its own (shown under the
    // answer, src/electron/active-turn.cjs) and is never part of the answer, so it never goes back to the
    // model with the history nor into a verified case.
    if (reviewNote) this.onStatus({ type: 'review', message: reviewNote });
    if (plan && !answer.toLowerCase().includes(plan.toLowerCase())) answer = `Pla: ${plan}\n\n${answer}`;
    if (options.recordHistory !== false) {
      await fs.mkdir(this.historyDir, { recursive: true });
      await fs.appendFile(path.join(this.historyDir, 'sessions.jsonl'), JSON.stringify({
        at: new Date().toISOString(),
        model: this.engine.getModelStatus().modelId,
        prompt,
        answer,
      }) + '\n');
    }
    this.onStatus({ type: 'status', message: 'Resposta local generada i registrada a la memòria.' });
    return answer;
  }

  private async collectVerifiedExperiences(prompt: string, projectRoot: string): Promise<string> {
    if (!this.verifiedExperiencesPath) return '';
    const queryWords = words(prompt);
    try {
      const stat = await fs.stat(this.verifiedExperiencesPath);
      if (!stat.isFile() || stat.size === 0) return '';
      const readSize = Math.min(stat.size, 8_000_000);
      const handle = await fs.open(this.verifiedExperiencesPath, 'r');
      let contents: string;
      try {
        const buffer = Buffer.alloc(readSize);
        await handle.read(buffer, 0, readSize, Math.max(0, stat.size - readSize));
        contents = buffer.toString('utf8');
      } finally { await handle.close(); }
      const root = await fs.realpath(projectRoot);
      const candidates = contents.split(/\r?\n/).slice(-500).flatMap((line, index) => {
        try {
          const value = JSON.parse(line);
          if (value?.verification !== 'user-confirmed' || typeof value.projectPath !== 'string' || path.resolve(value.projectPath) !== root) return [];
          if ([value.prompt, value.answer, value.evidence].some((field) => typeof field !== 'string')) return [];
          return [{ id: typeof value.id === 'string' ? value.id : `legacy-${index}`, prompt: value.prompt.slice(0, 1000), answer: value.answer.slice(0, 3000), evidence: value.evidence.slice(0, 500) }];
        } catch { return []; }
      });
      if (!candidates.length) return '';
      let ranked: RankedExperience[] = [];
      if (!this.experienceEmbeddingsUnavailable) {
        try {
          ranked = await this.experienceRanker.rank(prompt, candidates, (message) => this.onStatus({ type: 'status', message }));
        } catch {
          this.experienceEmbeddingsUnavailable = true;
          this.onStatus({ type: 'status', message: 'La cerca semàntica no està disponible; faré servir coincidències de paraules.' });
        }
      }
      if (!ranked.length && queryWords.size >= 2) {
        ranked = candidates.flatMap((item) => {
          const sampleWords = words(item.prompt);
          let overlap = 0;
          for (const word of queryWords) if (sampleWords.has(word)) overlap += 1;
          if (overlap < 2 || overlap / queryWords.size < 0.2) return [];
          return [{ ...item, score: overlap }];
        }).sort((a, b) => b.score - a.score).slice(0, 3);
      }
      return ranked.slice(0, 3).map((item, index) =>
        `${index + 1}. Petició: ${item.prompt}\nResposta desada: ${item.answer}\nComprovació indicada: ${item.evidence}`
      ).join('\n\n');
    } catch { return ''; }
  }

  private async collectContext(root: string, maxContentSize = 20000, maxManifestEntries = 300): Promise<{ manifest: string; contents: string }> {
    const absoluteRoot = path.resolve(root);
    const ignored = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.venv', 'venv', 'models']);
    const allowed = /\.(js|cjs|mjs|ts|tsx|jsx|json|md|html|css|py|go|rs|java|php|yml|yaml)$/i;
    const manifest: string[] = [];
    const snippets: string[] = [];
    const contextFiles: Array<{ relative: string; absolute: string }> = [];
    let contentSize = 0;
    let manifestTruncated = false;

    const walk = async (dir: string, depth = 0, inheritedRules: GitIgnoreRule[] = []): Promise<void> => {
      if (depth > 4) return;
      let rules = inheritedRules;
      try {
        const ignoreFile = path.join(dir, '.gitignore');
        const stat = await fs.stat(ignoreFile);
        if (stat.isFile() && stat.size <= 64_000) {
          const contents = await fs.readFile(ignoreFile, 'utf8');
          rules = [...inheritedRules, ...parseGitIgnore(contents, dir)];
        }
      } catch {}
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const relative = path.relative(absoluteRoot, full);
        if (isGitIgnored(full, entry.isDirectory(), rules)) continue;
        if (entry.isDirectory()) {
          if (manifest.length < maxManifestEntries) manifest.push(`${relative}/`);
          else manifestTruncated = true;
          await walk(full, depth + 1, rules);
          continue;
        }
        if (!entry.isFile()) continue;
        if (manifest.length < maxManifestEntries) manifest.push(relative);
        else manifestTruncated = true;
        // AGENTS.md and SKILLS.md at the root reach the model as instructions, not a second time as data.
        if (allowed.test(entry.name) && !/^(?:(?:agents|skills)\.md|mcp\.json)$/i.test(relative)) contextFiles.push({ relative, absolute: full });
      }
    };

    await walk(absoluteRoot);
    const contextPriority = (relative: string): number => {
      const normalized = relative.split(path.sep).join('/').toLowerCase();
      const basename = path.posix.basename(normalized);
      const rootFile = !normalized.includes('/');
      if (basename === 'agents.md') return rootFile ? 0 : 1;
      if (basename === 'readme.md' || basename === 'readme') return rootFile ? 2 : 6;
      if (rootFile && ['package.json', 'pyproject.toml', 'cargo.toml', 'go.mod', 'composer.json', 'pom.xml', 'requirements.txt'].includes(basename)) return 3;
      if (rootFile && ['tsconfig.json', 'jsconfig.json', 'vite.config.ts', 'vite.config.js', 'webpack.config.js'].includes(basename)) return 4;
      if (/^(src\/)?(index|main|app)\.(tsx?|jsx?|mjs|cjs|vue|py)$/i.test(normalized)) return 5;
      return 10;
    };
    contextFiles.sort((a, b) => contextPriority(a.relative) - contextPriority(b.relative) || a.relative.localeCompare(b.relative));
    for (const file of contextFiles) {
      if (contentSize >= maxContentSize) break;
      try {
        const stat = await fs.stat(file.absolute);
        if (!stat.isFile() || stat.size > 12000) continue;
        const content = await fs.readFile(file.absolute, 'utf8');
        const snippet = `\n--- ${file.relative} ---\n${content.slice(0, 6000)}`;
        if (contentSize + snippet.length <= maxContentSize) {
          snippets.push(snippet);
          contentSize += snippet.length;
        }
      } catch {}
    }
    if (manifestTruncated) manifest.push(`… (mapa limitat a ${maxManifestEntries} entrades)`);
    return { manifest: manifest.join('\n'), contents: snippets.join('\n') };
  }
}

export { LocalExperienceEmbedder, cosineSimilarity, rankExperiences } from './local-embeddings';
export { CudaInferenceEngine, MlxInferenceEngine, NativeInferenceEngine, TransformersJsInferenceEngine } from './inference-engine';
export { prompt as promptText, toolDescriptions, promptsDirectory } from './prompts';
