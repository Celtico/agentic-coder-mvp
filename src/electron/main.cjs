const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { spawn, fork } = require('node:child_process');

let win;
let modelWorker = null;
let requestId = 0;
const pendingModelRequests = new Map();
let selectedProject = null;
let activeProjectProcess = null;
let activeProjectRoot = null;
let activeProjectOutput = '';

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
async function saveSettings() {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify({ selectedProject }, null, 2), 'utf8');
}

async function dispatchAgentTool(tool, projectRoot) {
  if (!tool || typeof tool !== 'object' || !selectedProject) throw new Error('La crida de l’eina no és vàlida.');
  const root = await fs.realpath(selectedProject);
  if (await fs.realpath(projectRoot) !== root) throw new Error('El projecte actiu ha canviat durant la tasca.');
  if (tool.name === 'run_tests') {
    const pkgPath = path.join(root, 'package.json');
    let pkg;
    try { pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')); } catch { throw new Error('No s’ha trobat un package.json vàlid.'); }
    if (!pkg.scripts || !pkg.scripts.test) throw new Error('El projecte no defineix scripts.test.');
    const approved = await confirmProjectAction({
      title: 'Confirmar execució de proves', message: 'L’agent demana executar npm test.', button: 'Executa npm test',
      detail: `Carpeta: ${root}\n\nLes proves poden executar codi del projecte i modificar fitxers. El procés s’aturarà al cap de 2 minuts.`
    });
    if (!approved) return { approved: false, cancelled: true, command: 'npm test' };
    return executeProjectTests(root);
  }
  if (tool.name === 'run_project_script' && typeof tool.arguments?.script === 'string' && /^[a-zA-Z0-9:_-]{1,64}$/.test(tool.arguments.script)) {
    const pkg = await readProjectPackage(root);
    const script = tool.arguments.script;
    if (typeof pkg.scripts?.[script] !== 'string') throw new Error(`El projecte no defineix el script ${script}.`);
    const approved = await confirmProjectAction({
      title: 'Confirmar comprovació del projecte', message: `L’agent demana executar npm run ${script}.`, button: `Executa ${script}`,
      detail: `Carpeta: ${root}\nOrdre: npm run ${script}\nScript definit al package.json: ${pkg.scripts[script]}\n\nL’ordre pot executar codi del projecte i modificar fitxers.`
    });
    if (!approved) return { approved: false, cancelled: true, script };
    return executeNpmScript(root, script);
  }
  if (tool.name === 'start_project' && typeof tool.arguments?.script === 'string' && /^(dev|start|preview)$/.test(tool.arguments.script)) {
    const pkg = await readProjectPackage(root);
    const script = tool.arguments.script;
    if (typeof pkg.scripts?.[script] !== 'string') throw new Error(`El projecte no defineix el script ${script}.`);
    if (activeProjectProcess && activeProjectRoot === root) return { started: true, alreadyRunning: true, script, output: activeProjectOutput };
    if (activeProjectProcess) throw new Error('Ja hi ha una app d’un altre projecte en marxa. Atura-la abans de canviar de projecte.');
    const approved = await confirmProjectAction({
      title: 'Confirmar inici de l’app del projecte', message: `L’agent demana iniciar npm run ${script}.`, button: 'Inicia l’app',
      detail: `Carpeta: ${root}\nOrdre: npm run ${script}\nScript definit al package.json: ${pkg.scripts[script]}\n\nL’app quedarà en marxa fins que l’aturis, tanquis l’app Agentic Coder o el procés acabi.`
    });
    if (!approved) return { started: false, approved: false, cancelled: true, script };
    return startProjectProcess(root, script);
  }
  if (tool.name === 'stop_project') {
    if (!activeProjectProcess) return { stopped: true, alreadyStopped: true };
    const root = activeProjectRoot;
    const approved = await confirmProjectAction({
      title: 'Confirmar aturada de l’app', message: 'L’agent demana aturar l’app del projecte.', button: 'Atura l’app',
      detail: `Carpeta: ${root}\n\nS’aturarà el procés iniciat per Agentic Coder.`
    });
    if (!approved) return { stopped: false, approved: false, cancelled: true };
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
    if (existing && existing.content.length > 8000) throw new Error('El fitxer actual és massa llarg per mostrar-lo complet a la confirmació. Obre’l a l’editor per revisar-lo manualment.');
    if (existing?.content === content) return { applied: false, unchanged: true, path: relativePath };
    const diff = createReviewDiff(existing?.content ?? '', content);
    const decision = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel·la', 'Aplica el canvi'],
      defaultId: 0,
      cancelId: 0,
      title: existing ? 'Revisar canvi proposat' : 'Revisar fitxer nou',
      message: `${existing ? 'L’agent proposa modificar' : 'L’agent proposa crear'} ${relativePath}. Revisa el contingut abans d’aplicar-lo.`,
      detail: `DIFERÈNCIA (una secció):\n${diff}\n\nCONTINGUT ACTUAL:\n${existing?.content ?? '(fitxer nou)'}\n\nCONTINGUT PROPOSAT:\n${content}`
    });
    if (decision.response !== 1) return { applied: false, denied: true, path: relativePath };
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

function startModelWorker() {
  if (modelWorker && modelWorker.connected) return modelWorker;
  const nodeExecutable = findNodeExecutable();
  const child = fork(path.join(__dirname, '..', 'core', 'assistant', 'agent-worker.cjs'), [], {
    execPath: nodeExecutable,
    execArgv: [],
    env: {
      ...process.env,
      AGENT_MODEL_CACHE: path.resolve(__dirname, '..', '..', 'models'),
      AGENT_MODEL_PATH: path.resolve(__dirname, '..', '..', 'models', 'onnx-community', 'Qwen2.5-Coder-1.5B-Instruct'),
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  modelWorker = child;
  child.on('message', (message) => {
    if (message?.type === 'status') { win?.webContents.send('agent:status', message.value); return; }
    if (message?.type === 'tool-call' && typeof message.id === 'number' && typeof message.toolId === 'number') {
      dispatchAgentTool(message.tool, message.projectRoot).then((result) => {
        if (child.connected) child.send({ type: 'tool-result', id: message.id, toolId: message.toolId, result });
      }).catch((error) => {
        if (child.connected) child.send({ type: 'tool-result', id: message.id, toolId: message.toolId, result: { error: error?.message || String(error) } });
      });
      return;
    }
    const pending = pendingModelRequests.get(message?.id);
    if (!pending) return;
    pendingModelRequests.delete(message.id);
    if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.answer);
  });
  child.on('error', (error) => {
    for (const pending of pendingModelRequests.values()) pending.reject(error);
    pendingModelRequests.clear();
    if (modelWorker === child) modelWorker = null;
  });
  child.on('exit', (code, signal) => {
    const reason = signal ? `senyal ${signal}` : `codi ${code}`;
    for (const pending of pendingModelRequests.values()) pending.reject(new Error(`El procés aïllat del model s’ha aturat (${reason}). La finestra de l’app continua oberta; torna-ho a provar.`));
    pendingModelRequests.clear();
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

function askModel(prompt, projectRoot) {
  const child = startModelWorker();
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pendingModelRequests.set(id, { resolve, reject });
    child.send({ id, prompt, projectRoot }, (error) => {
      if (!error) return;
      pendingModelRequests.delete(id);
      reject(error);
    });
  });
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

function createReviewDiff(before, after) {
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let oldTail = oldLines.length - 1;
  let newTail = newLines.length - 1;
  while (oldTail >= prefix && newTail >= prefix && oldLines[oldTail] === newLines[newTail]) { oldTail -= 1; newTail -= 1; }
  const removed = oldLines.slice(prefix, oldTail + 1);
  const added = newLines.slice(prefix, newTail + 1);
  const hunk = [`@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`];
  if (prefix > 0) hunk.push(` ${oldLines[prefix - 1]}`);
  hunk.push(...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`));
  if (oldTail + 1 < oldLines.length) hunk.push(` ${oldLines[oldTail + 1]}`);
  return hunk.join('\n').slice(0, 18000);
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

ipcMain.handle('agent:ask', async (_e, prompt) => {
  if (!selectedProject) throw new Error('Obre primer un projecte.');
  return askModel(String(prompt || ''), selectedProject);
});

ipcMain.handle('project:run-tests', async () => {
  if (!selectedProject) throw new Error('Obre primer un projecte.');
  const root = await fs.realpath(selectedProject);
  const pkg = await readProjectPackage(root);
  if (!pkg.scripts || !pkg.scripts.test) throw new Error('El projecte no defineix scripts.test.');
  const approved = await confirmProjectAction({
    title: 'Confirmar execució de proves', message: 'S’executarà npm test al projecte seleccionat.', button: 'Executa npm test',
    detail: `Carpeta: ${root}\n\nLes proves poden executar codi del projecte i modificar fitxers. El procés s’aturarà al cap de 2 minuts.`
  });
  if (!approved) return { code: null, output: 'Execució cancel·lada.' };
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
