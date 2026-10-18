const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { spawn, fork } = require('node:child_process');

let win;
let modelWorker = null;
let requestId = 0;
const pendingModelRequests = new Map();
let selectedProject = null;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
async function saveSettings() {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify({ selectedProject }, null, 2), 'utf8');
}

function startModelWorker() {
  if (modelWorker && modelWorker.connected) return modelWorker;
  const child = fork(path.join(__dirname, '..', 'core', 'assistant', 'agent-worker.cjs'), [], {
    execArgv: [],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENT_MODEL_CACHE: path.resolve(__dirname, '..', '..', 'models') },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  modelWorker = child;
  child.on('message', (message) => {
    if (message?.type === 'status') { win?.webContents.send('agent:status', message.value); return; }
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

  const relative = path.relative(root, resolved);
  const projectKey = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(app.getPath('userData'), 'backups', projectKey, stamp, relative);
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.copyFile(resolved, backupPath);

  const temporaryPath = `${resolved}.agentic-${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode: stat.mode });
    await fs.rename(temporaryPath, resolved);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return { ok: true, backupPath };
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
  // Deliberately runs only the project's npm test script after explicit user action.
  const pkgPath = path.join(selectedProject, 'package.json');
  let pkg;
  try { pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')); } catch { throw new Error('No s’ha trobat un package.json vàlid.'); }
  if (!pkg.scripts || !pkg.scripts.test) throw new Error('El projecte no defineix scripts.test.');
  return new Promise((resolve) => {
    const child = spawn('npm', ['test'], { cwd: selectedProject, shell: false, env: { ...process.env, CI: '1' } });
    let output = '';
    child.stdout.on('data', d => { output += d.toString(); win?.webContents.send('tests:output', d.toString()); });
    child.stderr.on('data', d => { output += d.toString(); win?.webContents.send('tests:output', d.toString()); });
    child.on('error', err => resolve({ code: -1, output: `${output}\n${err.message}` }));
    child.on('close', code => resolve({ code, output }));
  });
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
