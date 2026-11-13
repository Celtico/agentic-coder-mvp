const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { executeProjectChecks } = require('../../src/electron/project-checks.cjs');

// The project tools of the app, reduced to what a benchmark task can use without a window: reading,
// searching, writing and deleting files and running the project's own scripts. Everything that would
// download code, open a browser or reach the internet answers with an error, so a task never depends
// on what is installed or reachable on the machine running it. The exception are the tasks that build
// a whole app from an empty folder (allowInstall): they may install npm packages, as in the app.
const INSTALL_TOOLS = new Set(['install_dependencies', 'install_package', 'run_npx']);
const UNAVAILABLE = new Set([...INSTALL_TOOLS, 'install_playwright_browser', 'web_search', 'read_web_page', 'inspect_browser', 'start_project', 'stop_project', 'list_mcp_tools', 'call_mcp_tool', 'create_git_commit']);
// A script that serves the app never ends; there is no browser here to look at it.
const LONG_RUNNING_SCRIPT = /^(?:dev|start|serve|preview|watch)$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[\w.^~-]{1,30})?$/i;
const SKIPPED_FOLDERS = new Set(['node_modules', '.git']);

function insideRoot(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 500 || path.isAbsolute(relativePath)) throw new Error('La ruta no és vàlida.');
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('La ruta surt de la carpeta del projecte.');
  return target;
}

async function listProjectFiles(root, directory = root, found = []) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (SKIPPED_FOLDERS.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await listProjectFiles(root, full, found);
    else if (entry.isFile()) found.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return found.sort();
}

function runNpmScript(root, script, timeoutMs = 60000) {
  return runCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], root, timeoutMs);
}

function runCommand(command, args, root, timeoutMs = 60000) {
  return new Promise((resolve) => {
    // A task's own `node --test` must not inherit the runner's test context when the benchmark
    // itself runs under node --test.
    const env = { ...process.env, CI: '1', FORCE_COLOR: '0' };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(command, args, { cwd: root, env });
    let output = '';
    const keep = (chunk) => { output = (output + chunk.toString()).slice(-12000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { child.kill('SIGKILL'); output += `\nTemps esgotat (${timeoutMs} ms).`; }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, output }); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, output: error.message }); });
  });
}

/** Returns a tool executor bound to one task folder, and the record of every call it served. */
function createSandboxExecutor(root, { allowInstall = false } = {}) {
  const calls = [];
  const execute = async (tool) => {
    const name = tool && typeof tool === 'object' ? tool.name : undefined;
    const args = tool && typeof tool.arguments === 'object' && tool.arguments ? tool.arguments : {};
    const record = { name: String(name), path: typeof args.path === 'string' ? args.path : undefined, ok: true };
    calls.push(record);
    try {
      if (allowInstall && INSTALL_TOOLS.has(name)) {
        const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        if (name === 'install_dependencies') return runCommand(npm, ['install'], root, 600000);
        if (typeof args.packageName !== 'string' || !PACKAGE_NAME.test(args.packageName)) throw new Error('Nom de paquet npm no vàlid.');
        record.package = args.packageName;
        if (name === 'install_package') return runCommand(npm, ['install', ...(args.dev === true ? ['--save-dev'] : []), args.packageName], root, 300000);
        const extra = Array.isArray(args.args) ? args.args : [];
        if (extra.length > 10 || extra.some((item) => typeof item !== 'string' || item.length > 120 || /[\r\n\0;&|`$<>]/.test(item))) throw new Error('Els arguments de l’ordre no són vàlids.');
        return runCommand(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', args.packageName, ...extra], root, 300000);
      }
      if (UNAVAILABLE.has(name)) throw new Error(`L’eina ${name} no està disponible en aquesta avaluació: no hi ha xarxa, navegador ni Git.`);
      if (name === 'list_files') return { files: await listProjectFiles(root) };
      if (name === 'read_file') {
        const target = insideRoot(root, args.path);
        const content = await fs.readFile(target, 'utf8');
        return { path: args.path, content: content.slice(0, 24000), truncated: content.length > 24000 };
      }
      if (name === 'search_text') {
        const query = String(args.query || '').trim().toLowerCase();
        if (!query) throw new Error('La cerca és buida.');
        const matches = [];
        for (const file of await listProjectFiles(root)) {
          const lines = (await fs.readFile(path.join(root, file), 'utf8').catch(() => '')).split(/\r?\n/);
          lines.forEach((line, index) => { if (matches.length < 40 && line.toLowerCase().includes(query)) matches.push({ path: file, line: index + 1, text: line.slice(0, 240) }); });
        }
        return { query: args.query, matches, truncated: matches.length >= 40 };
      }
      if (name === 'write_file') {
        if (typeof args.content !== 'string' || args.content.length > 24000) throw new Error('El contingut no és vàlid.');
        const target = insideRoot(root, args.path);
        const existing = await fs.readFile(target, 'utf8').catch(() => null);
        if (existing === args.content) return { applied: false, unchanged: true, path: args.path };
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, args.content, 'utf8');
        record.wrote = true;
        return { applied: true, path: args.path, created: existing === null };
      }
      if (name === 'delete_file') {
        await fs.rm(insideRoot(root, args.path));
        record.deleted = true;
        return { deleted: true, path: args.path };
      }
      if (name === 'run_tests') return executeProjectChecks(root, (folder, script) => runNpmScript(folder, script));
      if (name === 'run_project_script') {
        const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
        if (typeof args.script !== 'string' || typeof pkg.scripts?.[args.script] !== 'string') throw new Error(`El projecte no defineix el script ${args.script}.`);
        if (LONG_RUNNING_SCRIPT.test(args.script)) throw new Error(`El script ${args.script} no s’acaba mai; en aquesta avaluació no es pot servir l’app.`);
        return runNpmScript(root, args.script, allowInstall ? 300000 : 60000);
      }
      throw new Error('Eina desconeguda o arguments invàlids.');
    } catch (error) {
      record.ok = false;
      record.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };
  return { execute, calls };
}

module.exports = { createSandboxExecutor, listProjectFiles, runNpmScript, runCommand };
