// A verified case keeps the whole chat that led to an approved answer: every request of the user,
// every tool the model called (with its arguments and the result it saw) and each answer. A training
// example built from it puts the user's high-level request first and then the steps that worked, so
// the model learns to do on its own, from one open request, what it was guided to do step by step.
const { createHash } = require('node:crypto');

const MAX_TURNS = 40;
const MAX_STEPS = 80;

const trajectoryKey = (answer) => createHash('sha256').update(String(answer).trim()).digest('hex');

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
  let request = null;
  for (const turn of turns.slice(-MAX_TURNS * 2)) {
    if (!turn || typeof turn.content !== 'string') continue;
    if (turn.role === 'user') { request = turn.content.slice(0, 12000); continue; }
    if (turn.role !== 'assistant' || request === null) continue;
    const recorded = lookup(turn.content);
    result.push({
      request,
      steps: cleanSteps(recorded?.steps),
      answer: turn.content.slice(0, 30000),
      ...(recorded && typeof recorded.system === 'string' && recorded.system ? { system: recorded.system.slice(0, 30000) } : {}),
      ...(recorded && typeof recorded.model === 'string' ? { model: recorded.model.slice(0, 200) } : {}),
    });
    request = null;
  }
  if (!result.some((turn) => turn.steps.length)) return null;
  return { turns: result };
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

module.exports = { trajectoryKey, buildSessionTrajectory, toChatExample };
