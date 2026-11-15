// Log del model (src/core/assistant/llm-trace.ts, mlx_trace.py, src/electron/llm-calls.cjs): the capture
// of each call to the model. It only watches: with the panel closed the request to the model is the same.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const { readCalls } = require('../../electron/llm-calls.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-llm-trace-'));
const out = path.join(dir, 'llm-trace.cjs');
esbuild.buildSync({ entryPoints: [path.join(__dirname, 'llm-trace.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
const trace = require(out);
fs.rmSync(dir, { recursive: true, force: true });

test('the system prompt is cut by origin, and the pieces put together are exactly the prompt', () => {
  const system = 'Ets un agent.\n\nInstruccions del projecte:\nUsa pnpm.\n\nCasos semblants:\nCas 1: fes X.\n\nFitxers:\na.js\nb.js';
  const parts = trace.splitSystem(system, [
    { source: 'AGENTS.md', text: 'Usa pnpm.' }, { source: 'casos verificats recuperats', text: 'Cas 1: fes X.' },
    { source: 'llista de fitxers', text: 'a.js\nb.js' }, { source: 'SKILLS.md', text: '' }, { source: 'no hi és', text: 'res d’això' },
  ], 'prompts/system.md');
  assert.equal(parts.map((part) => part.text).join(''), system);
  assert.deepEqual(parts.map((part) => part.source), ['prompts/system.md', 'AGENTS.md', 'prompts/system.md', 'casos verificats recuperats', 'prompts/system.md', 'llista de fitxers']);
  // Two named parts with the same text: each takes its own place, never the same one.
  const twice = trace.splitSystem('A x B x C', [{ source: 'u', text: 'x' }, { source: 'v', text: 'x' }], 't');
  assert.deepEqual(twice.map((part) => [part.source, part.text]), [['t', 'A '], ['u', 'x'], ['t', ' B '], ['v', 'x'], ['t', ' C']]);
  assert.deepEqual(trace.splitSystem('', [], 't'), []);
});

test('the output: the tool calls the app reads, the ones it cannot, and the text around them', () => {
  const parsed = trace.parseOutput('Miro el fitxer.<tool_call>{"name": "read_file", "arguments": {"path": "a.js"}}</tool_call><tool_call>{trencat</tool_call><tool_call>{"arguments": {}}</tool_call> Fet.');
  assert.deepEqual(parsed.toolCalls, [{ name: 'read_file', arguments: { path: 'a.js' } }]);
  assert.equal(parsed.parseErrors.length, 2);
  assert.match(parsed.parseErrors[0], /No és JSON/);
  assert.match(parsed.parseErrors[1], /Crida sense nom/);
  assert.equal(parsed.answer, 'Miro el fitxer. Fet.');
  assert.deepEqual(trace.parseOutput('Només text.'), { toolCalls: [], answer: 'Només text.', parseErrors: [] });
});

test('the log file rotates past its size, and the panel reads the last calls, newest first, with their tools', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-llm-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'logs', 'llm-calls.jsonl');
  const call = (id) => ({ type: 'call', id, at: '2026-11-15T17:00:00Z', source: 'xat', model: 'm', input: {}, output: {}, metrics: {} });
  trace.appendRecord(file, call('a'), 200);
  trace.appendRecord(file, { type: 'tool', callId: 'a', name: 'read_file', arguments: {}, ok: true, ms: 3, result: 'x' }, 200);
  trace.appendRecord(file, call('b'), 200);
  // Past 200 bytes: the log so far became llm-calls.1.jsonl and a new one starts.
  assert.ok(fs.existsSync(path.join(root, 'logs', 'llm-calls.1.jsonl')));
  trace.appendRecord(file, call('c'), 1e6);
  fs.appendFileSync(file, 'no és json\n');
  const { calls } = await readCalls([file.replace(/\.jsonl$/, '.1.jsonl'), file], 50);
  assert.deepEqual(calls.map((item) => item.id), ['c', 'b', 'a']);
  assert.deepEqual(calls.find((item) => item.id === 'a').tools.map((tool) => tool.name), ['read_file']);
  assert.deepEqual((await readCalls([file], 1)).calls.map((item) => item.id), ['c']);
  assert.deepEqual(await readCalls([path.join(root, 'none.jsonl')]), { calls: [] });
});

test('the tracer: off by default; tools are recorded only after a call while it is on', () => {
  const tracer = new trace.LlmTracer();
  assert.equal(tracer.enabled, false);
  const events = [];
  tracer.onEvent = (event) => events.push(event);
  tracer.tool('read_file', {}, true, 1, 'x');
  tracer.enabled = true;
  tracer.tool('read_file', {}, true, 1, 'x');
  assert.equal(events.length, 0, 'no call yet to attach it to');
  tracer.lastCallId = 'c1';
  tracer.tool('read_file', { path: 'a' }, true, 5, { content: 'hola' });
  assert.equal(events[0].type, 'tool');
  assert.equal(events[0].tool.callId, 'c1');
  assert.equal(events[0].tool.result, '{"content":"hola"}');
  tracer.onEvent = () => { throw new Error('the panel failed'); };
  assert.doesNotThrow(() => tracer.tool('x', {}, true, 1, 'y'), 'the log never stops the work');
});

test('with the panel closed the request to the model and its generation are the ones they always were', () => {
  const engine = fs.readFileSync(path.join(__dirname, 'inference-engine.ts'), 'utf8');
  // Off, startTrace adds nothing to the request.
  assert.match(engine, /private startTrace\(messages: ChatTurn\[\], options: GenerationOptions\): Record<string, unknown> \{\n\s*this\.traced = null;\n\s*if \(!this\.tracer\.enabled\) return \{\};/);
  assert.match(engine, /readonly tracer = new LlmTracer\(\{ enabled: process\.env\.AGENT_LLM_TRACE === '1'/);
  const worker = fs.readFileSync(path.join(__dirname, 'mlx-worker.py'), 'utf8');
  // Without "trace", the worker goes on to the same generate() call as before.
  assert.match(worker, /if request\.get\("trace"\):[\s\S]*?continue\n        answer = generate\(\n            model,\n            tokenizer,\n            prompt=prompt,\n            max_tokens=int\(request\.get\("max_tokens", 700\)\),\n            sampler=make_sampler\(temp=float\(request\.get\("temperature", 0\.0\)\)\),\n            logits_processors=LOGITS_PROCESSORS or None,\n        \)/);
  // Traced, the same sampler and logits processors, through stream_generate (which generate() is built on).
  assert.match(worker, /make_sampler\(temp=float\(request\.get\("temperature", 0\.0\)\)\), LOGITS_PROCESSORS or None, emit,/);
  // The agent only labels the call; the messages and options it passes are untouched.
  const agent = fs.readFileSync(path.join(__dirname, 'agent.ts'), 'utf8');
  assert.match(agent, /private traced\(context: TraceContext\): InferenceEngine \{\n\s*const engine = this\.engine as InferenceEngine & \{ traceContext\?: TraceContext \};\n\s*if \('traceContext' in engine\) engine\.traceContext = context;\n\s*return engine;/);
  // On only while the panel is open, and the log file is not the history nor the training data.
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.cjs'), 'utf8');
  assert.match(main, /const llmTrace = \{ open: false, logprobs: false \};/);
  assert.match(main, /path\.join\(app\.getPath\('userData'\), 'logs', 'llm-calls\.jsonl'\)/);
  const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'llm-log.tsx'), 'utf8');
  assert.match(panel, /return \(\) => \{ stop\?\.\(\); void window\.agentic\.setLlmTrace\?\.\(\{ open: false \}\)\?\.catch\(\(\) => \{\}\) \}/);
});

test('mlx_trace.py: the context window from the config, and the tokens of each part (no model needed)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-mlx-trace-'));
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ text_config: { max_position_embeddings: 32768 } }));
    const result = spawnSync('python3', ['-I', '-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(__dirname)})
import mlx_trace
encode = lambda text: text.split()
print(json.dumps([mlx_trace.context_limit(${JSON.stringify(root)}), mlx_trace.context_limit("/no/such"), mlx_trace.part_counts(encode, [{"role": "system", "content": "a b c"}, {"role": "user", "content": "d"}], [{"name": "x"}], ["a b", ""]), mlx_trace.metrics(None, 0)["finishReason"]]))`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const [limit, missing, counts, finish] = JSON.parse(result.stdout.trim());
    assert.equal(limit, 32768);
    assert.equal(missing, null);
    assert.deepEqual(counts, { messages: [3, 1], tools: 2, parts: [2, 0] });
    assert.equal(finish, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the panel: an icon in the bar, the five views of a call, and the logprobs switch off by default', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'App.tsx'), 'utf8');
  assert.match(app, /llmlog: \{ icon: ScrollText, label: llmLogOpen \? 'Tanca el log del model' : 'Log del model'/);
  assert.match(app, /case 'llmlog': return <LlmLogPane\/>;/);
  const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'llm-log.tsx'), 'utf8');
  for (const tab of ['Entrada', 'Paràmetres', 'Sortida', 'Eines', 'Mètriques']) assert.ok(panel.includes(`>${tab}`), tab);
  assert.match(panel, /<PaneHeader icon=\{ScrollText\} title="Log del model"/);
  assert.match(panel, /const \[logprobs, setLogprobs\] = useState\(false\)/);
  assert.doesNotMatch(panel, /#[0-9a-f]{3,8}\b/i, 'only Chakra tokens');
});

test('the panel over an app started before it: a clear message, not a spinner that never ends', () => {
  const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'llm-log.tsx'), 'utf8');
  assert.match(panel, /const errorMessage = ipcErrorText/);
  // One helper for every panel with new calls: the same restart notice, and no list left waiting.
  const helper = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'ipc-errors.ts'), 'utf8');
  assert.match(helper, /export const RESTART_NOTICE = "Cal reiniciar l’app per activar aquesta funció: tanca-la \(⌘Q\) i torna-la a obrir\."/);
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'App.tsx'), 'utf8');
  assert.doesNotMatch(app, /Error invoking remote method/, 'no panel strips Electron’s text on its own');
  assert.doesNotMatch(app, /'Cal reiniciar l’app/, 'the notice is written once, in the helper');
  assert.match(app, /catch \(error\) \{ setModelManageError\(ipcErrorText\(error\)\); setManaged\(\(current\) => current \?\? \{ models: \[\], download: null \}\); \}/);
  assert.match(panel, /catch \(caught\) \{ setError\(errorMessage\(caught\)\); setCalls\(\(current\) => current \?\? \[\]\) \}/);
});

test('the logprobs switch: no visible label (it wrapped), the text in a tooltip and as its accessible name', () => {
  const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'llm-log.tsx'), 'utf8');
  assert.match(panel, /const LOGPROBS_LABEL = "Probabilitat de cada token \(més lent\)"/);
  assert.match(panel, /<Switch\.HiddenInput aria-label=\{LOGPROBS_LABEL\}\/><Switch\.Control\/>/);
  assert.match(panel, /<Tooltip\.Content maxW="280px">\{LOGPROBS_LABEL\}<\/Tooltip\.Content>/);
  assert.doesNotMatch(panel, /<Switch\.Label/);
});

test('the toolbar’s buttons: only their icons, their names in a tooltip and as aria-label; Esborra still asks twice', () => {
  const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'llm-log.tsx'), 'utf8');
  assert.match(panel, /<Button aria-label=\{label\} size="xs" variant="ghost" px="2" \{\.\.\.props\}>\{children\}<\/Button>/);
  for (const label of ['Actualitza', 'Mostra el fitxer al Finder', 'Esborra el log', 'Segur? Torna-hi a fer clic per esborrar el log']) assert.ok(panel.includes(`<ToolButton label="${label}"`), label);
  assert.doesNotMatch(panel, /<\/(?:RefreshCw|FolderOpen|Trash)[^>]*>|size=\{14\}\/>(?:Actualitza|Fitxer|Esborra)/);
  assert.match(panel, /setConfirmClear\(true\); setTimeout\(\(\) => setConfirmClear\(false\), 4000\)/);
});
