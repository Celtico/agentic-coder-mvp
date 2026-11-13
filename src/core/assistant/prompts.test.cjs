const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LocalCodingAgent, promptText, toolDescriptions, promptsDirectory } = require('./agent-runtime.cjs');

async function withPrompts(t, files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-prompts-'));
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(dir, `${name}.md`), text);
  const before = process.env.AGENT_PROMPTS_DIR;
  process.env.AGENT_PROMPTS_DIR = dir;
  t.after(async () => { if (before === undefined) delete process.env.AGENT_PROMPTS_DIR; else process.env.AGENT_PROMPTS_DIR = before; await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

test('the texts for the model are in prompts/ and their variables are filled in', async (t) => {
  await withPrompts(t, { hello: 'Hola {{name}}, {{missing}}fi.\n', blank: 'acaba amb línia en blanc\n\n' });
  assert.equal(promptText('hello', { name: 'cel' }), 'Hola cel, fi.');
  assert.equal(promptText('blank'), 'acaba amb línia en blanc\n');
  assert.equal(promptText('does-not-exist'), '');
});

test('a file edited by the user applies on the next use, without restarting', async (t) => {
  const dir = await withPrompts(t, { note: 'primer' });
  assert.equal(promptText('note'), 'primer');
  await fs.writeFile(path.join(dir, 'note.md'), 'segon');
  assert.equal(promptText('note'), 'segon');
});

test('the repository has the texts the agent uses, and tool descriptions per tool', () => {
  delete process.env.AGENT_PROMPTS_DIR;
  assert.match(promptsDirectory(), /prompts$/);
  assert.match(promptText('system', { model: 'm', runtime: 'r', folder: '/f' }), /Agentic Coder/);
  const descriptions = toolDescriptions();
  assert.match(descriptions.write_file, /text file/);
  assert.ok(Object.keys(descriptions).length >= 18);
});

test('with every prompt file emptied or missing, the agent still works and sends no built-in instructions', async (t) => {
  await withPrompts(t, {});
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-prompts-empty-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const seen = [];
  // The order of the steps (a plan before the first change) is the agent's logic and does not depend
  // on any text.
  const responses = [
    '{"type":"plan","content":"Crearé index.html."}',
    '{"type":"tool_call","name":"write_file","arguments":{"path":"index.html","content":"<h1>Hola</h1>"}}',
    '{"type":"final","content":"He creat index.html."}',
  ];
  const engine = {
    loadModel: async () => {},
    generateResponse: async (messages, options) => { seen.push({ messages, tools: options.tools }); return responses.shift() ?? '{"type":"final","content":"Fet."}'; },
    getModelStatus: () => ({ modelId: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit' }),
  };
  const agent = new LocalCodingAgent({ engine, onStatus: () => {}, experienceRanker: { rank: async () => [] } });
  agent.historyDir = path.join(root, '.history');
  agent.reviewChanges = false;
  const written = [];
  const answer = await agent.ask('Crea un index.html amb un títol', root, async (tool) => { if (tool.name === 'write_file') { written.push(tool.arguments.path); return { applied: true, path: tool.arguments.path }; } return {}; });
  assert.deepEqual(written, ['index.html']);
  assert.match(answer, /index\.html/);
  assert.equal(seen[0].messages[0].content, '', 'no system text at all');
  assert.ok(seen[0].tools.every((tool) => tool.function.description === ''), 'tools without descriptions');
  assert.ok(!seen.some((call) => call.messages.some((message) => /Encara no has aplicat|Executa ara el pla/.test(message.content))));
});
