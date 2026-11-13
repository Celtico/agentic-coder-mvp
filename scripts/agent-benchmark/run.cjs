const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createSandboxExecutor, listProjectFiles } = require('./sandbox-tools.cjs');
const { tasks: codeTasks } = require('./tasks.cjs');
const { appTasks } = require('./app-tasks.cjs');
const allTasks = [...codeTasks, ...appTasks];

const sha = (value) => createHash('sha256').update(value).digest('hex');

async function snapshot(root) {
  const files = {};
  for (const file of await listProjectFiles(root)) files[file] = sha(await fs.readFile(path.join(root, file)));
  return files;
}

function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]).sort();
}

/**
 * Counts the model's turns without changing what it answers, and keeps what it saw last and what it
 * answered at each one: the record of what the model did in a task, shown by the app's evaluation panel.
 */
function countingEngine(engine, counter) {
  return new Proxy(engine, {
    get(target, property) {
      if (property === 'generateResponse') {
        return async (messages, ...rest) => {
          const started = Date.now();
          const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
          let output = '';
          try { output = await target.generateResponse(messages, ...rest); return output; }
          catch (error) { output = `(error: ${error instanceof Error ? error.message : String(error)})`; throw error; }
          finally {
            counter.generations += 1; counter.generationMs += Date.now() - started;
            if (counter.transcript && counter.transcript.length < 60) {
              counter.transcript.push({ input: last && typeof last.content === 'string' ? { role: last.role, content: last.content.slice(0, 3000) } : null, output: String(output).slice(0, 6000), seconds: Number(((Date.now() - started) / 1000).toFixed(1)) });
            }
          }
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function runTask(task, { LocalCodingAgent, engine, timeoutMs, keep, run }) {
  // Kept projects go where AGENT_BENCHMARK_WORKDIR says (the app's evaluation keeps them to be opened).
  const workdir = keep && process.env.AGENT_BENCHMARK_WORKDIR ? process.env.AGENT_BENCHMARK_WORKDIR : os.tmpdir();
  await fs.mkdir(workdir, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(workdir, `${task.id}-${run}-`)));
  const historyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-bench-history-'));
  for (const [file, content] of Object.entries(task.files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content, 'utf8');
  }
  const before = await snapshot(root);
  const counter = { generations: 0, generationMs: 0, transcript: [] };
  const agent = new LocalCodingAgent({ engine: countingEngine(engine, counter), experienceRanker: { rank: async () => [] } });
  agent.historyDir = historyDir;
  const tools = createSandboxExecutor(root, { allowInstall: task.allowInstall === true });
  const started = Date.now();
  let answer = '';
  let error;
  let timer;
  // A request that runs out of time keeps generating until the model process stops; it is stopped
  // (and loaded again by the next task), so the next task does not find the model busy.
  const asked = agent.ask(task.prompt, root, tools.execute);
  asked.catch(() => {});
  try {
    answer = await Promise.race([
      asked,
      new Promise((_, reject) => { const limit = Math.max(timeoutMs, (task.timeoutMinutes || 0) * 60000); timer = setTimeout(() => reject(new Error(`Temps esgotat (${Math.round(limit / 1000)} s).`)), limit); }),
    ]);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally { clearTimeout(timer); }
  if (error && /^Temps esgotat/.test(error)) await engine.unloadModel?.().catch(() => {});
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
    transcript: counter.transcript,
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
  // The open total leaves out the reference tasks, whose prompt says exactly what to do.
  const referenceIds = new Set(allTasks.filter((task) => task.reference).map((task) => task.id));
  const open = results.filter((result) => !referenceIds.has(result.task));
  return {
    runs: results.length,
    passed,
    open: { runs: open.length, passed: open.filter((result) => result.pass).length },
    passRate: results.length ? Number((passed / results.length).toFixed(3)) : 0,
    runsWithoutTools: results.filter((result) => !result.toolCalls).length,
    byTask,
  };
}

/**
 * Runs the fixed tasks against one engine. `LocalCodingAgent` comes from the built runtime
 * (src/core/assistant/agent-runtime.cjs), so this measures the same orchestrator the app uses.
 */
async function runBenchmark({ LocalCodingAgent, engine, taskIds, repeat = 1, timeoutMs = 10 * 60 * 1000, keep = false, onStart = () => {}, onResult = () => {} }) {
  const selected = taskIds?.length ? allTasks.filter((task) => taskIds.includes(task.id)) : allTasks;
  const unknown = (taskIds || []).filter((id) => !allTasks.some((task) => task.id === id));
  if (unknown.length) throw new Error(`Tasques desconegudes: ${unknown.join(', ')}`);
  const results = [];
  const total = selected.length * repeat;
  let done = 0;
  for (let run = 1; run <= repeat; run += 1) {
    for (const task of selected) {
      done += 1;
      onStart({ task: task.id, run, index: done, total });
      const result = await runTask(task, { LocalCodingAgent, engine, timeoutMs, keep, run });
      results.push(result);
      onResult(result);
    }
  }
  return { summary: summarize(results), results };
}

module.exports = { runBenchmark, summarize, tasks: allTasks };
