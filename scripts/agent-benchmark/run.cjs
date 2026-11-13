const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createSandboxExecutor, listProjectFiles } = require('./sandbox-tools.cjs');
const { tasks: allTasks } = require('./tasks.cjs');

const sha = (value) => createHash('sha256').update(value).digest('hex');

async function snapshot(root) {
  const files = {};
  for (const file of await listProjectFiles(root)) files[file] = sha(await fs.readFile(path.join(root, file)));
  return files;
}

function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]).sort();
}

/** Counts the model's turns without changing what it answers. */
function countingEngine(engine, counter) {
  return new Proxy(engine, {
    get(target, property) {
      if (property === 'generateResponse') {
        return async (...args) => {
          const started = Date.now();
          try { return await target.generateResponse(...args); }
          finally { counter.generations += 1; counter.generationMs += Date.now() - started; }
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function runTask(task, { LocalCodingAgent, engine, timeoutMs, keep, run }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `agentic-coder-bench-${task.id}-`)));
  const historyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-bench-history-'));
  for (const [file, content] of Object.entries(task.files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content, 'utf8');
  }
  const before = await snapshot(root);
  const counter = { generations: 0, generationMs: 0 };
  const agent = new LocalCodingAgent({ engine: countingEngine(engine, counter), experienceRanker: { rank: async () => [] } });
  agent.historyDir = historyDir;
  const tools = createSandboxExecutor(root);
  const started = Date.now();
  let answer = '';
  let error;
  let timer;
  try {
    answer = await Promise.race([
      agent.ask(task.prompt, root, tools.execute),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Temps esgotat (${Math.round(timeoutMs / 1000)} s).`)), timeoutMs); }),
    ]);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally { clearTimeout(timer); }
  const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
  const after = await snapshot(root);
  const changed = changedFiles(before, after);
  const protectedChanged = task.protected.filter((file) => before[file] !== after[file]);
  let check = { pass: false, detail: error ? `sense comprovar: ${error}` : '' };
  if (!error) {
    try { check = await task.check(root, String(answer || '')); }
    catch (caught) { check = { pass: false, detail: `la comprovació ha fallat: ${caught instanceof Error ? caught.message : String(caught)}` }; }
  }
  const reasons = [];
  if (!check.pass) reasons.push(check.detail);
  if (protectedChanged.length) reasons.push(`ha modificat fitxers protegits: ${protectedChanged.join(', ')}`);
  if (task.readOnly && changed.length) reasons.push(`havia de respondre sense tocar res i ha canviat: ${changed.join(', ')}`);
  const toolsByName = {};
  for (const call of tools.calls) toolsByName[call.name] = (toolsByName[call.name] || 0) + 1;
  if (!keep) await fs.rm(root, { recursive: true, force: true });
  await fs.rm(historyDir, { recursive: true, force: true });
  return {
    task: task.id,
    run,
    pass: !error && check.pass && !protectedChanged.length && !(task.readOnly && changed.length),
    detail: reasons.length ? reasons.join('; ') : check.detail,
    seconds,
    generations: counter.generations,
    generationSeconds: Number((counter.generationMs / 1000).toFixed(1)),
    toolCalls: tools.calls.length,
    failedToolCalls: tools.calls.filter((call) => !call.ok).length,
    toolsByName,
    filesChanged: changed,
    protectedChanged,
    answer: String(answer || '').slice(0, 800),
    ...(error ? { error } : {}),
    ...(keep ? { folder: root } : {}),
  };
}

function summarize(results) {
  const byTask = {};
  for (const result of results) {
    const entry = byTask[result.task] || (byTask[result.task] = { runs: 0, passed: 0, toolCalls: 0, seconds: 0, runsWithoutTools: 0 });
    entry.runs += 1;
    if (result.pass) entry.passed += 1;
    if (!result.toolCalls) entry.runsWithoutTools += 1;
    entry.toolCalls += result.toolCalls;
    entry.seconds += result.seconds;
  }
  for (const entry of Object.values(byTask)) {
    entry.passRate = Number((entry.passed / entry.runs).toFixed(3));
    entry.meanToolCalls = Number((entry.toolCalls / entry.runs).toFixed(1));
    entry.meanSeconds = Number((entry.seconds / entry.runs).toFixed(1));
    delete entry.toolCalls; delete entry.seconds;
  }
  const passed = results.filter((result) => result.pass).length;
  return {
    runs: results.length,
    passed,
    passRate: results.length ? Number((passed / results.length).toFixed(3)) : 0,
    runsWithoutTools: results.filter((result) => !result.toolCalls).length,
    byTask,
  };
}

/**
 * Runs the fixed tasks against one engine. `LocalCodingAgent` comes from the built runtime
 * (src/core/assistant/agent-runtime.cjs), so this measures the same orchestrator the app uses.
 */
async function runBenchmark({ LocalCodingAgent, engine, taskIds, repeat = 1, timeoutMs = 10 * 60 * 1000, keep = false, onResult = () => {} }) {
  const selected = taskIds?.length ? allTasks.filter((task) => taskIds.includes(task.id)) : allTasks;
  const unknown = (taskIds || []).filter((id) => !allTasks.some((task) => task.id === id));
  if (unknown.length) throw new Error(`Tasques desconegudes: ${unknown.join(', ')}`);
  const results = [];
  for (let run = 1; run <= repeat; run += 1) {
    for (const task of selected) {
      const result = await runTask(task, { LocalCodingAgent, engine, timeoutMs, keep, run });
      results.push(result);
      onResult(result);
    }
  }
  return { summary: summarize(results), results };
}

module.exports = { runBenchmark, summarize, tasks: allTasks };
