const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { spawn, fork } = require('node:child_process');
const { getGitSnapshot, getGitCommitCandidates } = require('./git-tools.cjs');
const { ChatStore } = require('./chat-store.cjs');
const { inspectFileForDeletion, deleteInspectedProjectFile, listDeletedProjectFiles, restoreDeletedProjectFile } = require('./project-file-tools.cjs');
const { parseVerifiedExperiences, prepareTrainingDataset, writeTrainingCandidate } = require('./learning-dataset.cjs');

let win;
let modelWorker = null;
let requestId = 0;
const pendingModelRequests = new Map();
const activeModelToolCalls = new Set();
let activeModelRequestId = null;
let selectedProject = null;
let selectedModel = 'qwen-1.5b';
let activeProjectProcess = null;
let activeProjectRoot = null;
let activeProjectOutput = '';
let chatStore;

function getChatStore() {
  if (!chatStore) chatStore = new ChatStore(path.join(app.getPath('userData'), 'memory', 'conversations.sqlite'));
  return chatStore;
}

app.on('before-quit', () => {
  if (modelWorker && !modelWorker.killed) modelWorker.kill('SIGTERM');
  modelWorker = null;
  try { chatStore?.close(); } catch {}
  chatStore = null;
});

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
async function saveSettings() {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify({ selectedProject, selectedModel }, null, 2), 'utf8');
}

const modelDefinitions = [
  { id: 'qwen-1.5b', label: 'Qwen2.5-Coder 1.5B · Transformers.js', modelId: 'onnx-community/Qwen2.5-Coder-1.5B-Instruct', runtime: 'transformers' },
  { id: 'qwen-7b-mlx', label: 'Qwen2.5-Coder 7B · MLX (Apple)', modelId: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit', runtime: 'mlx' },
];
const projectModelsDirectory = () => path.resolve(__dirname, '..', '..', 'models');
const mlxPythonPath = () => process.env.AGENT_MLX_PYTHON || path.join(projectModelsDirectory(), '.mlx-venv', 'bin', 'python');
const mlxModelDirectory = async () => {
  const modelRoot = path.join(projectModelsDirectory(), '.hf', 'hub', 'models--mlx-community--Qwen2.5-Coder-7B-Instruct-4bit', 'snapshots');
  const snapshots = await fs.readdir(modelRoot).catch(() => []);
  for (const snapshot of snapshots) {
    const directory = path.join(modelRoot, snapshot);
    try {
      await fs.access(path.join(directory, 'config.json'));
      await fs.access(path.join(directory, 'model.safetensors'));
      return directory;
    } catch {}
  }
  return null;
};
async function getAvailableModels() {
  const modelRoot = projectModelsDirectory();
  const mlxPath = await mlxModelDirectory();
  const mlxPythonReady = await fs.access(mlxPythonPath()).then(() => true, () => false);
  return modelDefinitions.map((model) => {
    const available = model.runtime === 'mlx' ? Boolean(mlxPath && mlxPythonReady) : true;
    const reason = model.runtime === 'mlx' && !available
      ? !mlxPath ? 'Falten els pesos locals del model.' : 'Falta el runtime MLX de Python.'
      : undefined;
    return { id: model.id, label: model.label, modelId: model.modelId, available, ...(reason ? { reason } : {}) };
  });
}

async function dispatchAgentTool(tool, projectRoot) {
  if (!tool || typeof tool !== 'object' || !selectedProject) throw new Error('La crida de l’eina no és vàlida.');
  const root = await fs.realpath(selectedProject);
  if (await fs.realpath(projectRoot) !== root) throw new Error('El projecte actiu ha canviat durant la tasca.');
  if (tool.name === 'create_git_commit' && typeof tool.arguments?.message === 'string') {
    const message = tool.arguments.message.trim();
    if (!message || message.length > 200 || /[\r\n\0]/.test(message)) throw new Error('El missatge del commit no és vàlid.');
    const snapshot = await getGitCommitCandidates(root);
    if (!snapshot.available) throw new Error(snapshot.reason);
    if (!snapshot.paths.length) return { committed: false, nothingToCommit: true, message: 'No hi ha canvis per incloure al commit.' };
    const latest = await getGitCommitCandidates(root);
    if (!latest.available || latest.status !== snapshot.status) throw new Error('Els canvis del projecte han canviat durant la tasca. Torna a revisar Git abans de crear el commit.');
    const staged = await executeBinary('git', ['add', '-A', '--', ...snapshot.paths], root, 30000);
    if (staged.code !== 0) return { committed: false, stageCode: staged.code, output: staged.output };
    const committed = await executeBinary('git', ['commit', '-m', message], root, 30000);
    return { committed: committed.code === 0, code: committed.code, message, output: committed.output };
  }
  if (tool.name === 'run_tests') {
    const pkgPath = path.join(root, 'package.json');
    let pkg;
    try { pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')); } catch { throw new Error('No s’ha trobat un package.json vàlid.'); }
    if (!pkg.scripts || !pkg.scripts.test) throw new Error('El projecte no defineix scripts.test.');
    return executeProjectTests(root);
  }
  if (tool.name === 'run_project_script' && typeof tool.arguments?.script === 'string' && /^[a-zA-Z0-9:_-]{1,64}$/.test(tool.arguments.script)) {
    const pkg = await readProjectPackage(root);
    const script = tool.arguments.script;
    if (typeof pkg.scripts?.[script] !== 'string') throw new Error(`El projecte no defineix el script ${script}.`);
    return executeNpmScript(root, script);
  }
  if (tool.name === 'start_project' && typeof tool.arguments?.script === 'string' && /^(dev|start|preview)$/.test(tool.arguments.script)) {
    const pkg = await readProjectPackage(root);
    const script = tool.arguments.script;
    if (typeof pkg.scripts?.[script] !== 'string') throw new Error(`El projecte no defineix el script ${script}.`);
    if (activeProjectProcess && activeProjectRoot === root) return { started: true, alreadyRunning: true, script, output: activeProjectOutput };
    if (activeProjectProcess) throw new Error('Ja hi ha una app d’un altre projecte en marxa. Atura-la abans de canviar de projecte.');
    return startProjectProcess(root, script);
  }
  if (tool.name === 'stop_project') {
    if (!activeProjectProcess) return { stopped: true, alreadyStopped: true };
    const root = activeProjectRoot;
    return stopProjectProcess();
  }
  if (tool.name === 'install_package' && typeof tool.arguments?.packageName === 'string' && typeof tool.arguments?.dev === 'boolean') {
    const { packageName, dev } = tool.arguments;
    if (packageName.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(packageName)) throw new Error('Nom de paquet npm no vàlid.');
    await readProjectPackage(root);
    const args = ['install', ...(dev ? ['--save-dev'] : []), packageName];
    const command = `npm ${args.join(' ')}`;
    const approved = await confirmProjectAction({
      title: 'Confirmar instal·lació de llibreria', message: `L’agent demana instal·lar ${packageName}${dev ? ' com a dependència de desenvolupament' : ''}.`, button: 'Instal·la',
      detail: `Carpeta: ${root}\nOrdre: ${command}\n\nAixò pot modificar package.json, package-lock.json i node_modules, i descarregar codi del registre npm. No s’executarà si cancel·les.`
    });
    if (!approved) return { approved: false, cancelled: true, packageName };
    return executeNpmCommand(root, args, 300000);
  }
  if (tool.name === 'install_playwright_browser') {
    const executable = path.join(root, 'node_modules', '.bin', 'playwright');
    try { await fs.access(executable, fs.constants.X_OK); }
    catch { throw new Error('Playwright no està instal·lat en aquest projecte. Demana primer instal·lar @playwright/test o playwright.'); }
    const approved = await confirmProjectAction({
      title: 'Confirmar instal·lació del navegador de proves', message: 'L’agent demana instal·lar Chromium per a Playwright.', button: 'Instal·la Chromium',
      detail: `Carpeta: ${root}\nOrdre: node_modules/.bin/playwright install chromium\n\nEs descarregarà el navegador Chromium a la memòria local de Playwright; no és una llibreria npm ni modifica package.json.`
    });
    if (!approved) return { approved: false, cancelled: true, browser: 'chromium' };
    return executeBinary(executable, ['install', 'chromium'], root, 600000);
  }
  if (tool.name === 'inspect_browser' && typeof tool.arguments?.url === 'string') {
    let target;
    try { target = new URL(tool.arguments.url); } catch { throw new Error('L’adreça local no és vàlida.'); }
    if (!['http:', 'https:'].includes(target.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname.toLowerCase()) || (target.port && (+target.port < 1 || +target.port > 65535))) {
      throw new Error('Per seguretat, Playwright només pot obrir adreces locals de localhost, 127.0.0.1 o ::1.');
    }
    let playwrightPath;
    try { playwrightPath = require.resolve('playwright', { paths: [root] }); }
    catch { throw new Error('Playwright no està instal·lat en aquest projecte. Demana instal·lar @playwright/test o playwright amb confirmació.'); }
    const { chromium } = require(playwrightPath);
    let browser;
    try {
      browser = await chromium.launch({ headless: true, timeout: 20000 });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const consoleErrors = [];
      const pageErrors = [];
      const requestFailures = [];
      page.on('console', (message) => { if (message.type() === 'error' && consoleErrors.length < 30) consoleErrors.push(message.text().slice(0, 500)); });
      page.on('pageerror', (error) => { if (pageErrors.length < 30) pageErrors.push(error.message.slice(0, 500)); });
      page.on('requestfailed', (request) => { if (requestFailures.length < 30) requestFailures.push({ url: safeBrowserUrl(request.url()), error: (request.failure()?.errorText || 'request failed').slice(0, 300) }); });
      const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(800);
      const pageInfo = await page.evaluate(() => ({ title: document.title, text: document.body?.innerText || '' }));
      const screenshotDirectory = path.join(app.getPath('userData'), 'browser-inspections');
      await fs.mkdir(screenshotDirectory, { recursive: true });
      const screenshotPath = path.join(screenshotDirectory, `inspection-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 15000 });
      return {
        inspected: true, url: safeBrowserUrl(page.url()), status: response?.status() ?? null,
        title: String(pageInfo.title || '').slice(0, 300), text: String(pageInfo.text || '').slice(0, 12000),
        consoleErrors, pageErrors, requestFailures, screenshotPath,
        truncated: String(pageInfo.text || '').length > 12000,
      };
    } catch (error) {
      throw new Error(`La inspecció Playwright ha fallat: ${error instanceof Error ? error.message : String(error)}. Si Chromium no està instal·lat, demana instal·lar-lo amb l’eina confirmada.`);
    } finally { if (browser) await browser.close().catch(() => {}); }
  }
  if (tool.name === 'list_files') {
    const files = await listFiles(root);
    return { files: files.filter((file) => !file.directory).slice(0, 500).map((file) => file.path) };
  }
  if (tool.name === 'read_file' && typeof tool.arguments?.path === 'string' && tool.arguments.path.length <= 500) {
    const relativePath = tool.arguments.path;
    const visibleFiles = await listFiles(root);
    if (!visibleFiles.some((file) => !file.directory && file.path === relativePath)) throw new Error('Aquest fitxer no forma part de la llista visible del projecte.');
    const target = safeProjectPath(root, relativePath);
    const resolved = await fs.realpath(target);
    if (!isWithin(root, resolved)) throw new Error('La ruta resolta surt de la carpeta del projecte.');
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > 1_000_000) throw new Error('Fitxer no vàlid o massa gran (límit 1 MB).');
    const content = await fs.readFile(resolved, 'utf8');
    return { path: relativePath, content: content.slice(0, 12000), truncated: content.length > 12000 };
  }
  if (tool.name === 'search_text' && typeof tool.arguments?.query === 'string' && tool.arguments.query.trim() && tool.arguments.query.length <= 200) {
    const query = tool.arguments.query.trim().toLowerCase();
    const files = (await listFiles(root)).filter((file) => !file.directory && /\.(js|cjs|mjs|ts|tsx|jsx|json|md|html|css|py|go|rs|java|php|yml|yaml)$/i.test(file.path));
    const matches = [];
    let bytesRead = 0;
    for (const file of files) {
      if (matches.length >= 40 || bytesRead >= 2_000_000) break;
      try {
        const target = safeProjectPath(root, file.path);
        const resolved = await fs.realpath(target);
        if (!isWithin(root, resolved)) continue;
        const stat = await fs.stat(resolved);
        if (!stat.isFile() || stat.size > 200_000) continue;
        const content = await fs.readFile(resolved, 'utf8');
        bytesRead += stat.size;
        const lines = content.split(/\r?\n/);
        lines.forEach((line, index) => {
          if (matches.length < 40 && line.toLowerCase().includes(query)) matches.push({ path: file.path, line: index + 1, text: line.slice(0, 240) });
        });
      } catch {}
    }
    return { query: tool.arguments.query, matches, truncated: matches.length >= 40 || bytesRead >= 2_000_000 };
  }
  if (tool.name === 'delete_file' && typeof tool.arguments?.path === 'string') {
    const relativePath = tool.arguments.path;
    if (relativePath.length > 500 || path.isAbsolute(relativePath)) throw new Error('La ruta no es vàlida per eliminar.');
    const visibleFiles = await listFiles(root);
    if (!visibleFiles.some((file) => !file.directory && file.path === relativePath)) throw new Error('Aquest fitxer no forma part de la llista visible del projecte.');
    const snapshot = await inspectFileForDeletion(root, relativePath);
    const projectKey = createHash('sha256').update(root).digest('hex').slice(0, 16);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-') + `-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    const deletedRoot = path.join(app.getPath('userData'), 'backups', projectKey, 'deleted');
    const backupPath = path.join(deletedRoot, stamp, relativePath);
    const metadataPath = path.join(deletedRoot, stamp, '.agentic-metadata.json');
    const decision = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel·la', 'Elimina i desa còpia'],
      defaultId: 0,
      cancelId: 0,
      title: 'Revisar eliminació proposada',
      message: `L’agent proposa eliminar ${relativePath}.`,
      detail: `Projecte: ${root}\nFitxer: ${relativePath}\nMida: ${snapshot.size} bytes\n\nEs crearà i verificarà una còpia recuperable fora del projecte abans d’eliminar el fitxer. Si el fitxer canvia després d’aquesta confirmació, no s’eliminarà.`
    });
    if (decision.response !== 1) return { deleted: false, denied: true, path: relativePath };
    return deleteInspectedProjectFile(snapshot, backupPath, metadataPath);
  }
  if (tool.name === 'write_file' && typeof tool.arguments?.path === 'string' && typeof tool.arguments?.content === 'string') {
    const relativePath = tool.arguments.path;
    const content = tool.arguments.content;
    if (relativePath.length > 500 || content.length > 8000 || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => part.startsWith('.'))) {
      throw new Error('El camí o el contingut no es pot revisar de manera segura. Usa el panell editor per a fitxers més grans.');
    }
    const target = safeProjectPath(root, relativePath);
    const parent = await fs.realpath(path.dirname(target));
    if (!isWithin(root, parent)) throw new Error('La carpeta de destinació surt del projecte.');
    let existing = null;
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Només es poden modificar fitxers normals.');
      existing = { path: await fs.realpath(target), content: await fs.readFile(target, 'utf8') };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && !isWithin(root, existing.path)) throw new Error('La ruta resolta surt de la carpeta del projecte.');
    if (existing && existing.content.length > 8000) throw new Error('El fitxer és massa llarg per modificar-lo amb seguretat des de l’eina ràpida. Obre’l a l’editor per revisar-lo.');
    if (existing?.content === content) return { applied: false, unchanged: true, path: relativePath };
    const saved = await writeProjectFile(root, relativePath, content, { allowCreate: true });
    return { applied: true, path: relativePath, created: !existing, backupPath: saved.backupPath };
  }
  throw new Error('Eina desconeguda o arguments invàlids.');
}

async function readProjectPackage(root) {
  let pkg;
  try { pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); }
  catch { throw new Error('No s’ha trobat un package.json vàlid.'); }
  return pkg;
}

async function confirmProjectAction({ title, message, detail, button }) {
  const decision = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Cancel·la', button], defaultId: 0, cancelId: 0,
    title, message, detail
  });
  return decision.response === 1;
}

function startProjectProcess(root, script) {
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', script], {
      cwd: root, shell: false, detached: process.platform !== 'win32', env: { ...process.env }
    });
    activeProjectProcess = child;
    activeProjectRoot = root;
    activeProjectOutput = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      resolve(result);
    };
    const append = (chunk) => {
      const text = chunk.toString();
      activeProjectOutput = (activeProjectOutput + text).slice(-30000);
      if (win && !win.isDestroyed()) win.webContents.send('terminal:output', text);
      if (/\b(localhost|127\.0\.0\.1|ready|listening|compiled successfully)\b/i.test(text)) {
        finish({ started: true, readySignal: true, script, output: activeProjectOutput });
      }
    };
    const startupTimer = setTimeout(() => finish({ started: true, readySignal: false, script, output: activeProjectOutput }), 8000);
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => {
      if (activeProjectProcess === child) { activeProjectProcess = null; activeProjectRoot = null; }
      finish({ started: false, script, output: `${activeProjectOutput}\n${error.message}` });
    });
    child.on('close', (code) => {
      if (activeProjectProcess === child) { activeProjectProcess = null; activeProjectRoot = null; }
      finish({ started: false, exited: true, code, script, output: activeProjectOutput });
    });
  });
}

function stopProjectProcess() {
  const child = activeProjectProcess;
  if (!child) return Promise.resolve({ stopped: true, alreadyStopped: true });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      if (activeProjectProcess === child) { activeProjectProcess = null; activeProjectRoot = null; }
      resolve(result);
    };
    child.once('close', (code, signal) => finish({ stopped: true, code, signal, output: activeProjectOutput }));
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); }
    catch { child.kill('SIGTERM'); }
    const forceTimer = setTimeout(() => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch {}
      finish({ stopped: true, forced: true, output: activeProjectOutput });
    }, 4000);
  });
}

async function startModelWorker() {
  if (modelWorker && modelWorker.connected) return modelWorker;
  const nodeExecutable = findNodeExecutable();
  const child = fork(path.join(__dirname, '..', 'core', 'assistant', 'agent-worker.cjs'), [], {
    execPath: nodeExecutable,
    execArgv: [],
    env: {
      ...process.env,
      AGENT_MODEL_CACHE: path.resolve(__dirname, '..', '..', 'models'),
      AGENT_MODEL_RUNTIME: modelDefinitions.find((model) => model.id === selectedModel)?.runtime || 'transformers',
      AGENT_MODEL: modelDefinitions.find((model) => model.id === selectedModel)?.modelId || modelDefinitions[0].modelId,
      AGENT_MODEL_PATH: path.resolve(__dirname, '..', '..', 'models', 'onnx-community', 'Qwen2.5-Coder-1.5B-Instruct'),
      AGENT_MLX_PYTHON: mlxPythonPath(),
      AGENT_MLX_MODEL_PATH: await mlxModelDirectory() || '',
      AGENT_VERIFIED_EXPERIENCES_PATH: path.join(app.getPath('userData'), 'learning', 'verified-experiences.jsonl'),
      AGENT_EMBEDDING_INDEX_PATH: path.join(app.getPath('userData'), 'learning', 'embedding-index-v1.json'),
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  modelWorker = child;
  child.on('message', (message) => {
    if (message?.type === 'status') { win?.webContents.send('agent:status', message.value); return; }
    if (message?.type === 'tool-call' && typeof message.id === 'number' && typeof message.toolId === 'number') {
      const toolKey = `${message.id}:${message.toolId}`;
      activeModelToolCalls.add(toolKey);
      dispatchAgentTool(message.tool, message.projectRoot).then((result) => {
        if (child.connected) child.send({ type: 'tool-result', id: message.id, toolId: message.toolId, result });
      }).catch((error) => {
        if (child.connected) child.send({ type: 'tool-result', id: message.id, toolId: message.toolId, result: { error: error?.message || String(error) } });
      }).finally(() => activeModelToolCalls.delete(toolKey));
      return;
    }
    const pending = pendingModelRequests.get(message?.id);
    if (!pending) return;
    pendingModelRequests.delete(message.id);
    if (activeModelRequestId === message.id) activeModelRequestId = null;
    if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.answer);
  });
  child.on('error', (error) => {
    for (const pending of pendingModelRequests.values()) pending.reject(error);
    pendingModelRequests.clear();
    activeModelRequestId = null;
    if (modelWorker === child) modelWorker = null;
  });
  child.on('exit', (code, signal) => {
    const reason = signal ? `senyal ${signal}` : `codi ${code}`;
    for (const pending of pendingModelRequests.values()) pending.reject(new Error(`El procés aïllat del model s’ha aturat (${reason}). La finestra de l’app continua oberta; torna-ho a provar.`));
    pendingModelRequests.clear();
    activeModelRequestId = null;
    if (modelWorker === child) modelWorker = null;
    if (win && !win.isDestroyed()) win.webContents.send('agent:status', { type: 'status', message: `El procés del model s’ha aturat (${reason}); la resta de l’app continua funcionant.` });
  });
  return child;
}

function findNodeExecutable() {
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [process.env.AGENT_NODE_EXECUTABLE, process.env.npm_node_execpath];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (directory) candidates.push(path.join(directory, name));
  }
  for (const candidate of candidates) {
    if (!candidate || path.resolve(candidate) === path.resolve(process.execPath)) continue;
    try {
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error('No he trobat Node.js per executar el treballador local. Configura AGENT_NODE_EXECUTABLE o obre l’app des d’un entorn amb Node.js al PATH.');
}

async function askModel(prompt, projectRoot) {
  if (activeModelRequestId !== null) throw new Error('Ja hi ha una petició al model local en marxa.');
  const id = ++requestId;
  activeModelRequestId = id;
  let child;
  try { child = await startModelWorker(); }
  catch (error) { activeModelRequestId = null; throw error; }
  return new Promise((resolve, reject) => {
    pendingModelRequests.set(id, { resolve, reject });
    child.send({ id, prompt, projectRoot }, (error) => {
      if (!error) return;
      pendingModelRequests.delete(id);
      if (activeModelRequestId === id) activeModelRequestId = null;
      reject(error);
    });
  });
}

function cancelModelRequest() {
  const id = activeModelRequestId;
  if (id === null) return { cancelled: false, reason: 'no-active-request' };
  if ([...activeModelToolCalls].some((key) => key.startsWith(`${id}:`))) {
    return { cancelled: false, reason: 'confirmed-action-in-progress' };
  }
  const pending = pendingModelRequests.get(id);
  if (!pending) return { cancelled: false, reason: 'no-active-request' };

  pendingModelRequests.delete(id);
  activeModelRequestId = null;
  const child = modelWorker;
  modelWorker = null;
  pending.reject(new Error('Generació cancel·lada.'));
  if (child && !child.killed) {
    let exited = false;
    const forceTimer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 1500);
    forceTimer.unref();
    child.once('exit', () => { exited = true; clearTimeout(forceTimer); });
    child.kill('SIGTERM');
  }
  return { cancelled: true };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 980, minHeight: 680,
    title: 'Agentic Coder — Local',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true }
  });
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (params.src !== 'about:blank' && !/^https?:\/\//i.test(params.src)) event.preventDefault();
  });
  win.loadFile(path.join(__dirname, '..', 'index.html'));
}

app.whenReady().then(async () => {
  try {
    const saved = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
    if (typeof saved.selectedProject === 'string' && (await fs.stat(saved.selectedProject)).isDirectory()) selectedProject = saved.selectedProject;
    if (modelDefinitions.some((model) => model.id === saved.selectedModel)) selectedModel = saved.selectedModel;
  } catch {}
  if (!selectedProject) { selectedProject = path.resolve(__dirname, '..', '..'); await saveSettings(); }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (activeProjectProcess) stopProjectProcess(); });

ipcMain.handle('project:open', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  selectedProject = result.filePaths[0];
  await saveSettings();
  return { path: selectedProject, files: await listFiles(selectedProject) };
});

async function listFiles(root, rel = '', depth = 0) {
  if (depth > 3) return [];
  const ignored = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.venv', 'venv', 'models']);
  const out = [];
  let entries;
  try { entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a,b) => a.name.localeCompare(b.name)).slice(0, 250)) {
    if (ignored.has(e.name) || e.name.startsWith('.DS_Store')) continue;
    const next = path.join(rel, e.name);
    if (e.isDirectory()) out.push({ path: next, directory: true }, ...(await listFiles(root, next, depth + 1)));
    else out.push({ path: next, directory: false });
  }
  return out;
}

ipcMain.handle('project:current', async () => {
  if (!selectedProject) return null;
  return { path: selectedProject, files: await listFiles(selectedProject) };
});

ipcMain.handle('project:deleted-backups', async () => {
  if (!selectedProject) throw new Error('Obre primer un projecte.');
  const root = await fs.realpath(selectedProject);
  const projectKey = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const deletedRoot = path.join(app.getPath('userData'), 'backups', projectKey, 'deleted');
  return listDeletedProjectFiles(deletedRoot);
});

ipcMain.handle('project:restore-deleted-backup', async (_event, backupId) => {
  if (!selectedProject) throw new Error('Obre primer un projecte.');
  if (typeof backupId !== 'string' || backupId.length > 1000) throw new Error('Identificador de còpia no vàlid.');
  const root = await fs.realpath(selectedProject);
  const projectKey = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const deletedRoot = path.join(app.getPath('userData'), 'backups', projectKey, 'deleted');
  const backups = await listDeletedProjectFiles(deletedRoot);
  const backup = backups.find((entry) => entry.id === backupId);
  if (!backup) throw new Error('La còpia no existeix o no ha superat la verificació.');
  const decision = await confirmProjectAction({
    title: 'Confirmar restauració de fitxer',
    message: `Es restaurarà ${backup.path} al projecte.`,
    button: 'Restaura el fitxer',
    detail: `Projecte: ${root}\nCòpia: ${backup.id}\nMida: ${backup.bytes} bytes\n\nSi ja existeix un fitxer al destí, la restauració s’aturarà sense substituir-lo. La còpia de recuperació es conservarà.`
  });
  if (!decision) return { restored: false, denied: true, path: backup.path };
  return restoreDeletedProjectFile(root, deletedRoot, backupId);
});

ipcMain.handle('project:for-chat', async (_event, sessionId) => {
  if (typeof sessionId !== 'string' || sessionId.length > 200) return null;
  const session = getChatStore().get(sessionId);
  if (!session?.projectPath) return null;
  try {
    const root = await fs.realpath(session.projectPath);
    if (!(await fs.stat(root)).isDirectory()) return null;
    selectedProject = root;
    await saveSettings();
    return { path: root, files: await listFiles(root) };
  } catch { return null; }
});

ipcMain.handle('project:read', async (_e, relativePath) => {
  if (!selectedProject) throw new Error('Primer obre un projecte.');
  const root = await fs.realpath(selectedProject);
  const target = safeProjectPath(root, relativePath);
  const resolved = await fs.realpath(target);
  if (!isWithin(root, resolved)) throw new Error('La ruta resolta surt de la carpeta del projecte.');
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || stat.size > 1_000_000) throw new Error('Fitxer no vàlid o massa gran (límit 1 MB).');
  return fs.readFile(resolved, 'utf8');
});

ipcMain.handle('project:write', async (_e, relativePath, content) => {
  if (!selectedProject) throw new Error('Primer obre un projecte.');
  if (typeof content !== 'string' || content.length > 1_000_000) throw new Error('Contingut invàlid o massa gran.');
  const root = await fs.realpath(selectedProject);
  const target = safeProjectPath(root, relativePath);
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Només es poden editar fitxers normals existents del projecte.');
  const resolved = await fs.realpath(target);
  if (!isWithin(root, resolved)) throw new Error('La ruta resolta surt de la carpeta del projecte.');

  return { ok: true, ...(await writeProjectFile(root, relativePath, content, { allowCreate: false })) };
});

function safeProjectPath(root, relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) throw new Error('Ruta no permesa.');
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Ruta fora del projecte.');
  return target;
}

function isWithin(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

function safeBrowserUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch { return '(adreça local)'; }
}

async function writeProjectFile(root, relativePath, content, { allowCreate }) {
  const target = safeProjectPath(root, relativePath);
  const parent = await fs.realpath(path.dirname(target));
  if (!isWithin(root, parent)) throw new Error('La carpeta de destinació surt del projecte.');
  let stat = null;
  let resolved = path.join(parent, path.basename(target));
  try {
    stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Només es poden editar fitxers normals del projecte.');
    resolved = await fs.realpath(target);
    if (!isWithin(root, resolved)) throw new Error('La ruta resolta surt de la carpeta del projecte.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!allowCreate) throw new Error('El fitxer ja no existeix al projecte.');
  }

  let backupPath = null;
  if (stat) {
    const relative = path.relative(root, resolved);
    const projectKey = createHash('sha256').update(root).digest('hex').slice(0, 16);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-') + `-${process.pid}`;
    backupPath = path.join(app.getPath('userData'), 'backups', projectKey, stamp, relative);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(resolved, backupPath);
  }

  const temporaryPath = path.join(parent, `.${path.basename(resolved)}.agentic-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode: stat?.mode ?? 0o644, flag: 'wx' });
    if (stat) await fs.rename(temporaryPath, resolved);
    else {
      await fs.link(temporaryPath, resolved);
      await fs.rm(temporaryPath, { force: true });
    }
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return { backupPath };
}

async function executeProjectTests(root) {
  return executeNpmScript(root, 'test');
}

async function executeNpmScript(root, script) {
  return executeNpmCommand(root, ['run', script], 120000);
}

async function executeNpmCommand(root, args, timeoutMs) {
  return executeBinary('npm', args, root, timeoutMs);
}

async function executeBinary(executable, args, root, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd: root, shell: false, detached: process.platform !== 'win32', env: { ...process.env, CI: '1' } });
    let output = '';
    let settled = false;
    let timedOut = false;
    const append = (chunk) => { output = (output + chunk.toString()).slice(-100000); };
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); }
      catch { child.kill('SIGTERM'); }
    }, timeoutMs);
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ code: -1, output: `${output}\n${error.message}`, timedOut });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

ipcMain.handle('history:recent', async () => {
  const historyPath = path.join(require('node:os').homedir(), '.agentic-coder', 'memory', 'sessions.jsonl');
  let raw;
  try { raw = await fs.readFile(historyPath, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return raw.split(/\r?\n/).filter(Boolean).slice(-100).flatMap((line) => {
    try {
      const item = JSON.parse(line);
      if (typeof item.prompt !== 'string' || typeof item.answer !== 'string') return [];
      return [{ prompt: item.prompt, answer: item.answer, at: item.at }];
    } catch { return []; }
  });
});

ipcMain.handle('chat-store:load', () => getChatStore().list());
ipcMain.handle('chat-store:save', (_event, sessions) => getChatStore().saveMany(sessions));

ipcMain.handle('learning:record-verified-experience', async (_e, value) => {
  if (!selectedProject) throw new Error('Primer obre un projecte.');
  if (!value || typeof value !== 'object') throw new Error('El cas d’aprenentatge no és vàlid.');
  const { prompt, answer, projectPath, evidence } = value;
  if ([prompt, answer, projectPath, evidence].some((item) => typeof item !== 'string') || !prompt.trim() || !answer.trim() || !evidence.trim()) {
    throw new Error('Cal indicar la petició, la resposta i una comprovació real.');
  }
  if (prompt.length > 12000 || answer.length > 30000 || evidence.length > 4000) throw new Error('El cas supera el límit de mida.');
  const root = await fs.realpath(selectedProject);
  if (await fs.realpath(projectPath) !== root) throw new Error('El projecte actiu ha canviat; selecciona’l de nou abans de guardar el cas.');
  const selectedText = `${prompt}\n${answer}\n${evidence}`;
  const secretPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/i;
  if (secretPattern.test(selectedText)) throw new Error('Sembla que el text conté una credencial. Treu-la abans de desar aquest cas.');

  const id = createHash('sha256').update(JSON.stringify({ root, prompt, answer, evidence })).digest('hex');
  const filePath = path.join(app.getPath('userData'), 'learning', 'verified-experiences.jsonl');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let existing = '';
  try { existing = await fs.readFile(filePath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing.split(/\r?\n/).some((line) => { try { return JSON.parse(line).id === id; } catch { return false; } })) return { id, saved: false };

  const decision = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel·la', 'Desa localment'],
    defaultId: 0,
    cancelId: 0,
    title: 'Desar un cas verificat?',
    message: 'Aquest exemple s’afegirà a la memòria local de casos verificats.',
    detail: 'No es modifica ni s’entrena el model. El text es guarda només en aquest Mac. Comprova que no contingui credencials, dades personals ni codi que no vulguis conservar. La comprovació indicada és la procedència del cas.'
  });
  if (decision.response !== 1) throw new Error('Desat del cas cancel·lat.');
  const record = { id, at: new Date().toISOString(), projectPath: root, model: process.env.AGENT_MODEL || 'onnx-community/Qwen2.5-Coder-1.5B-Instruct', prompt, answer, evidence, verification: 'user-confirmed' };
  await fs.appendFile(filePath, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(filePath, 0o600);
  return { id, saved: true };
});

async function readPreparedExperienceDataset() {
  const filePath = path.join(app.getPath('userData'), 'learning', 'verified-experiences.jsonl');
  let contents;
  try { contents = await fs.readFile(filePath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return prepareTrainingDataset([]); throw error; }
  const records = parseVerifiedExperiences(contents);
  return prepareTrainingDataset(records);
}

ipcMain.handle('learning:dataset-preview', async () => {
  const prepared = await readPreparedExperienceDataset();
  return { counts: prepared.counts, splitCounts: prepared.splitCounts, trainingReady: prepared.trainingReady };
});

ipcMain.handle('learning:prepare-dataset', async () => {
  const prepared = await readPreparedExperienceDataset();
  if (prepared.counts.included === 0) throw new Error('No hi ha casos confirmats aptes per preparar.');
  const candidatesDirectory = path.join(app.getPath('userData'), 'learning', 'candidates');
  const decision = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel·la', 'Prepara versió candidata'],
    defaultId: 0,
    cancelId: 0,
    title: 'Preparar dades locals d’aprenentatge?',
    message: `Es prepararan ${prepared.counts.included} casos confirmats en particions locals.`,
    detail: `Origen: ${path.join(app.getPath('userData'), 'learning', 'verified-experiences.jsonl')}\nDestinació: ${candidatesDirectory}/dataset-…/\nIncloses: ${prepared.counts.included}\nDuplicades descartades: ${prepared.counts.duplicates}\nPossibles secrets descartats: ${prepared.counts.secrets}\nNo confirmades descartades: ${prepared.counts.unverified}\nRegistres invàlids descartats: ${prepared.counts.invalid}\nParticions: entrenament ${prepared.splitCounts.train}, validació ${prepared.splitCounts.validation}, prova ${prepared.splitCounts.test}\n\nTot queda en aquest Mac. No s’entrena ni es canvia cap model. ${prepared.trainingReady ? 'El conjunt arriba al llindar mínim tècnic, però encara requereix revisió de qualitat.' : 'Hi ha massa pocs casos per considerar-lo llest per entrenar.'}`
  });
  if (decision.response !== 1) return { prepared: false, cancelled: true, counts: prepared.counts };
  const candidate = await writeTrainingCandidate(prepared, candidatesDirectory);
  return { prepared: true, directory: candidate.directory, manifest: candidate.manifest };
});

ipcMain.handle('agent:ask', async (_e, prompt) => {
  if (!selectedProject) throw new Error('Obre primer un projecte.');
  return askModel(String(prompt || ''), selectedProject);
});

ipcMain.handle('models:list', async () => ({ selectedModel, models: await getAvailableModels() }));
ipcMain.handle('models:select', async (_e, modelId) => {
  if (activeModelRequestId !== null) throw new Error('Espera que acabi la resposta abans de canviar de model.');
  const model = modelDefinitions.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error('Aquest model no és vàlid.');
  const available = (await getAvailableModels()).find((candidate) => candidate.id === model.id);
  if (!available?.available) throw new Error(available?.reason || 'Aquest model encara no està disponible en aquest Mac.');
  if (selectedModel !== model.id && modelWorker) {
    const child = modelWorker;
    modelWorker = null;
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  selectedModel = model.id;
  await saveSettings();
  return { selectedModel, models: await getAvailableModels() };
});

ipcMain.handle('agent:cancel', async () => cancelModelRequest());

ipcMain.handle('git:snapshot', async () => {
  if (!selectedProject) return { available: false, reason: 'Selecciona primer un projecte.' };
  return getGitSnapshot(selectedProject);
});

ipcMain.handle('project:run-tests', async () => {
  if (!selectedProject) throw new Error('Obre primer un projecte.');
  const root = await fs.realpath(selectedProject);
  const pkg = await readProjectPackage(root);
  if (!pkg.scripts || !pkg.scripts.test) throw new Error('El projecte no defineix scripts.test.');
  return executeProjectTests(root);
});

ipcMain.handle('terminal:run', async (_e, rawCommand) => {
  if (!selectedProject) throw new Error('Obre primer un projecte.');
  const command = String(rawCommand || '').trim();
  if (!command || command.length > 2000) throw new Error('Ordre buida o massa llarga.');
  const answer = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel·la', 'Executa'], defaultId: 0, cancelId: 0, title: 'Executar ordre al projecte?', message: command, detail: `S’executarà al terminal dins de:\n${selectedProject}\n\nUna ordre pot crear, modificar o esborrar fitxers.` });
  if (answer.response !== 1) return { code: null, output: 'Execució cancel·lada.' };
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: selectedProject, shell: true, env: process.env });
    let output = '';
    let settled = false;
    const append = (chunk) => {
      output += chunk.toString();
      if (output.length > 100000) output = output.slice(-100000);
      if (win && !win.isDestroyed()) win.webContents.send('terminal:output', chunk.toString());
    };
    const timeout = setTimeout(() => { child.kill('SIGTERM'); append('\n[Aturat: límit de 2 minuts.]\n'); }, 120000);
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('error', (err) => { if (settled) return; settled = true; clearTimeout(timeout); resolve({ code: -1, output: `${output}\n${err.message}` }); });
    child.on('close', (code) => { if (settled) return; settled = true; clearTimeout(timeout); resolve({ code, output }); });
  });
});
