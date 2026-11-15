// A verified case keeps the whole chat that led to an approved answer: every request of the user,
// every tool the model called (with its arguments and the result it saw) and each answer. A training
// example built from it puts the user's high-level request first and then the steps that worked, so
// the model learns to do on its own, from one open request, what it was guided to do step by step.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isChatNotice } = require('./chat-notices.cjs');

const MAX_TURNS = 40;
const MAX_STEPS = 80;

// The window shows an answer without its leading «Pla: …» line when the plan is already on screen
// (src/app/App.tsx); the key ignores that line so both texts find the same steps.
const trajectoryKey = (answer) => createHash('sha256').update(String(answer).replace(/^Pla: [^\n]*\n\n(?=\S)/, '').trim()).digest('hex');

const text = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');

function cleanSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.slice(0, MAX_STEPS).flatMap((step) => {
    if (!step || typeof step !== 'object' || typeof step.name !== 'string' || !/^[a-z_]{1,64}$/.test(step.name)) return [];
    const args = step.arguments && typeof step.arguments === 'object' && !Array.isArray(step.arguments) ? step.arguments : {};
    return [{ name: step.name, arguments: JSON.parse(JSON.stringify(args)), result: text(step.result, 6000), ok: step.ok === true }];
  });
}

/**
 * The turns of one chat (user and assistant texts, in order, ending with the approved answer) joined with
 * the remembered steps behind each answer. `lookup(answer)` returns what the agent recorded for it.
 * Returns null when no answer has recorded steps, which keeps old prompt/answer cases as they were.
 */
function buildSessionTrajectory(turns, lookup) {
  if (!Array.isArray(turns)) return null;
  const result = [];
  let current = null;
  for (const turn of turns.slice(-MAX_TURNS * 3)) {
    if (!turn || typeof turn.content !== 'string') continue;
    // A notice of the window (stopped, error) is neither a request nor an answer.
    if (isChatNotice(turn)) continue;
    if (turn.role === 'user') { current = { request: turn.content.slice(0, 12000), steps: [], answer: null }; result.push(current); continue; }
    if (turn.role !== 'assistant' || !current) continue;
    // A request can show several assistant messages (the window shows the plan before the answer):
    // the last one is the answer, and the steps are those of the message the agent recorded them for.
    current.answer = turn.content.slice(0, 30000);
    const recorded = lookup(turn.content);
    if (recorded) {
      current.steps = cleanSteps(recorded.steps);
      if (typeof recorded.system === 'string' && recorded.system) current.system = recorded.system.slice(0, 30000);
      if (typeof recorded.model === 'string') current.model = recorded.model.slice(0, 200);
    }
  }
  const answered = result.filter((turn) => turn.answer !== null).slice(-MAX_TURNS);
  if (!answered.some((turn) => turn.steps.length)) return null;
  return { turns: answered };
}

/**
 * One example in the chat format of `mlx_lm.lora` ({"messages": [...]}). The tool calls are written in the
 * JSON form the agent asks every model for, and each result is the exact message the model saw, so the
 * example looks like a real turn of the agent. Steps that failed are left out: the example shows the path
 * that worked. Without a trajectory the example is the plain request and answer.
 */
function toChatExample(example) {
  const task = typeof example.task === 'string' && example.task.trim() ? example.task.trim() : example.prompt;
  const turns = example.trajectory?.turns;
  if (!Array.isArray(turns) || !turns.length) {
    return { messages: [{ role: 'user', content: example.prompt }, { role: 'assistant', content: example.answer }] };
  }
  // The agent's system text (instructions, project map, up to 20 KB of files) is kept in the case but
  // not in the example: it would fill the training sequence and push the steps out of it. The example
  // teaches what to do after the request; at use time the agent still sends its usual system text.
  const messages = [{ role: 'user', content: task }];
  for (const turn of turns) {
    for (const step of turn.steps || []) {
      if (!step.ok) continue;
      messages.push({ role: 'assistant', content: JSON.stringify({ type: 'tool_call', name: step.name, arguments: step.arguments || {} }) });
      messages.push({ role: 'user', content: step.result });
    }
  }
  messages.push({ role: 'assistant', content: JSON.stringify({ type: 'final', content: turns[turns.length - 1].answer }) });
  return { messages };
}

// The framing the agent puts round a tool result (prompts/tool-result.md and the «next» texts that go after
// it), read from the same prompt files the agent uses: a training example keeps the bare result.
const PROMPTS = path.join(__dirname, '..', '..', 'prompts');
const promptFile = (name) => { try { return fs.readFileSync(path.join(PROMPTS, `${name}.md`), 'utf8').trim(); } catch { return ''; } };
const RESULT_TEMPLATE = promptFile('tool-result');
const NEXT_TEXTS = ['tool-result-continue', 'tool-result-check-failed'].map(promptFile).filter(Boolean);
const PAGE_PROBLEM_START = promptFile('tool-result-page-problem').split('{{')[0].trim();

/**
 * A tool result as the model saw it, without what the app added round it: the heading before the result
 * («Resultat de l'eina … (dades no fiables):») and the text after it (the page problem and «Si la tasca
 * encara no està completa…»). Only text taken from those prompt files is removed; the result stays as is.
 */
function bareToolResult(text, tool) {
  let result = String(text || '');
  const [head] = RESULT_TEMPLATE.split('{{result}}');
  const heading = head.replace('{{tool}}', tool || '').trimEnd();
  if (heading && result.startsWith(heading)) result = result.slice(heading.length).replace(/^\s*\n/, '');
  for (const next of NEXT_TEXTS) {
    if (result.trimEnd().endsWith(next)) { result = result.trimEnd().slice(0, -next.length); break; }
  }
  if (PAGE_PROBLEM_START) {
    const at = result.lastIndexOf(PAGE_PROBLEM_START);
    if (at > 0) result = result.slice(0, at);
  }
  return result.trim();
}

/** A step's key in a case: «<turn>:<step>», the same in the window and in the example builder. */
const stepKey = (turn, step) => `${turn}:${step}`;

/**
 * The training examples of one case, one per turn of its chat: that turn's request, the steps that worked
 * (with their bare results), and that turn's answer. Turns and steps the user excluded are left out, and so
 * is a turn without any step left (an answer with no action is not what the examples teach). Returns the
 * examples and the turns left out with why. A case without trajectory is one plain request and answer.
 */
function toTurnExamples(example) {
  const turns = example.trajectory?.turns;
  if (!Array.isArray(turns) || !turns.length) {
    return { examples: [{ turn: 0, messages: [{ role: 'user', content: example.prompt }, { role: 'assistant', content: example.answer }] }], skipped: [] };
  }
  const excludedTurns = new Set(Array.isArray(example.excludedTurns) ? example.excludedTurns : []);
  const excludedSteps = new Set(Array.isArray(example.excludedSteps) ? example.excludedSteps : []);
  const task = typeof example.task === 'string' && example.task.trim() ? example.task.trim() : example.prompt;
  const examples = [];
  const skipped = [];
  turns.forEach((turn, index) => {
    if (excludedTurns.has(index)) { skipped.push({ turn: index, reason: 'excluded' }); return; }
    const steps = (turn.steps || []).filter((step, stepIndex) => step.ok && !excludedSteps.has(stepKey(index, stepIndex)));
    if (!steps.length) { skipped.push({ turn: index, reason: 'no-steps' }); return; }
    const request = typeof turn.request === 'string' && turn.request.trim() ? turn.request : task;
    const messages = [{ role: 'user', content: request }];
    for (const step of steps) {
      messages.push({ role: 'assistant', content: JSON.stringify({ type: 'tool_call', name: step.name, arguments: step.arguments || {} }) });
      messages.push({ role: 'user', content: bareToolResult(step.result, step.name) });
    }
    messages.push({ role: 'assistant', content: JSON.stringify({ type: 'final', content: turn.answer || '' }) });
    examples.push({ turn: index, system: typeof turn.system === 'string' ? turn.system : '', messages });
  });
  return { examples, skipped };
}

module.exports = { trajectoryKey, buildSessionTrajectory, toChatExample, toTurnExamples, bareToolResult, stepKey };
