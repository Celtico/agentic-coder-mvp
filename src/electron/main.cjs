const { app, BrowserWindow, ipcMain, dialog, shell, Menu, MenuItem, screen, session, systemPreferences } = require('electron');
const windowState = require('./window-state.cjs');
const path = require('node:path');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { spawn, fork } = require('node:child_process');
const { getGitSnapshot, getGitHistory, getGitCommitDetails, getGitCommitCandidates } = require('./git-tools.cjs');
const { findLocalProjectUrl } = require('./project-browser.cjs');
const { pageActionsScript } = require('./page-actions.cjs');
const { ChatStore } = require('./chat-store.cjs');
const mlxModels = require('./mlx-models.cjs');
const { trajectoryKey, buildSessionTrajectory } = require('./learning-trajectory.cjs');
const { summarizeReports, comparisonByModel, renderBenchmarkSvg } = require('./benchmark-summary.cjs');
const { projectFileExists, inspectFileForDeletion, deleteInspectedProjectFile, listDeletedProjectFiles, restoreDeletedProjectFile, ensureProjectDirectory } = require('./project-file-tools.cjs');
const { listProjectFileHistory, listProjectFolderHistory, readProjectFileHistoryVersion } = require('./project-history.cjs');
const { parseVerifiedExperiences, prepareTrainingDataset, writeTrainingCandidate, datasetView, datasetJsonl } = require('./learning-dataset.cjs');
const learningCases = require('./learning-cases.cjs');
const { isChatNotice } = require('./chat-notices.cjs');
const { turnLogPath, appendTurnLog } = require('./turn-log.cjs');
const { createActiveTurns, withTurn, withoutReviewerNote } = require('./active-turn.cjs');
const { validateChatImages, writeChatImages, removeChatImages } = require('./chat-images.cjs');
const dictation = require('./dictation.cjs');
const versions = require('./learning-versions.cjs');
const modelManager = require('./model-manager.cjs');
const llmCalls = require('./llm-calls.cjs');
// Processes on every platform: npm/npx .cmd on Windows, stopping a whole process tree (processes.cjs).
const processes = require('./processes.cjs');
const { buildMenuTemplate, PANES: MENU_PANES } = require('./app-menu.cjs');
const menuLabels = require('./menu-labels.cjs');
const { AGENT_LIMITS, AGENT_PREFERENCES_VERSION, defaultAgentPreferences, normalizeAgentPreferences, migrateAgentPreferences, limitHistory } = require('./preferences.cjs');
const { searchWeb, readWebPage, publicWebUrl } = require('./web-search.cjs');
const { McpConnection, readMcpConfig } = require('./mcp-client.cjs');
const { executeProjectChecks } = require('./project-checks.cjs');

let win;

// The app's name (menu, Dock, dialogs). Run from the repository Electron would otherwise show «Electron»;
// the data folder stays where it has always been (it would follow the new name otherwise).
{
  const userData = app.getPath('userData');
  app.setName('Agentic Coder');
  app.setPath('userData', userData);
}
/**
 * Reads a public page with the browser the app already carries: it opens the address in a hidden,
 * sandboxed window, lets its scripts run and takes the text a person would see. Pages that build
 * their content with JavaScript come back empty from a plain download; here they do not. If the
 * window cannot load the page, the plain download is the fallback.
 */
async function readRenderedWebPage(address) {
  const url = publicWebUrl(address);
  let reader;
  try {
    reader = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'web-page-reader', javascript: true } });
    reader.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    reader.webContents.session.on('will-download', (event) => event.preventDefault());
    reader.webContents.setAudioMuted(true);
    await Promise.race([
      reader.webContents.loadURL(url.href),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('la pàgina no ha carregat en 15 s')), 15000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const info = await reader.webContents.executeJavaScript(`(() => {
      const main = document.querySelector('main, article, [role=main]') || document.body;
      const clone = main.cloneNode(true);
      clone.querySelectorAll('script,style,noscript,svg,nav,footer,header,form,iframe,aside').forEach((node) => node.remove());
      document.body.appendChild(clone); clone.style.position = 'absolute'; clone.style.left = '-99999px';
      const text = (clone.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
      clone.remove();
      return { title: document.title, text };
    })()`, true);
    const text = String(info.text || '');
    if (text.length < 80) throw new Error('la pàgina renderitzada gairebé no té text');
    return { url: url.href, title: String(info.title || '').slice(0, 300), text: text.slice(0, 9000), truncated: text.length > 9000, rendered: true };
  } catch {
    return readWebPage(url.href);
  } finally {
    if (reader && !reader.isDestroyed()) reader.destroy();
  }
}

/** MCP servers started in this session, by project folder and server name. */
const mcpConnections = new Map();
function stopMcpServers() { for (const connection of mcpConnections.values()) connection.stop(); mcpConnections.clear(); }

/** Starts (once) a server the project declares in mcp.json. Starting one runs a program, so it asks first unless permissions are automatic. */
async function mcpServer(root, name) {
  const key = `${root}\n${name}`;
  const running = mcpConnections.get(key);
  if (running && !running.closed) return running;
  const config = (await readMcpConfig(root))[name];
  if (!config) throw new Error(`El projecte no declara cap servidor MCP «${name}» a mcp.json.`);
  if (permissionMode !== 'auto') {
    const options = {
      type: 'question', buttons: ['Inicia', 'Cancel·la'], defaultId: 1, cancelId: 1,
      message: `Iniciar el servidor MCP «${name}»?`,
      detail: `El fitxer mcp.json del projecte demana executar:\n${[config.command, ...config.args].join(' ')}\n\nUn servidor MCP és un programa que s’executa en aquest ordinador i pot baixar codi d’internet. Si acceptes, queda en marxa fins que tanquis l’app.`,
    };
    const confirmation = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (confirmation.response !== 0) throw new Error(`L’usuari no ha volgut iniciar el servidor MCP «${name}».`);
  }
  if (win && !win.isDestroyed()) win.webContents.send('terminal:output', `\r\n$ ${[config.command, ...config.args].join(' ')}   (servidor MCP «${name}»)\r\n`);
  const connection = await new McpConnection(name, config, root).start();
  mcpConnections.set(key, connection);
  return connection;
}

/** Projects where the user has already agreed to npm installs in this session. */
const approvedInstallRoots = new Set();
let modelWorker = null;
let requestId = 0;
const pendingModelRequests = new Map();
// The tool steps behind each recent answer, by the answer's text: when the user approves an answer as a
// verified case, the steps of that chat that led to it are saved with it (src/electron/learning-trajectory.cjs).
const recentTrajectories = new Map();
function rememberTrajectory(answer, trajectory) {
  if (typeof answer !== 'string' || !trajectory || typeof trajectory !== 'object') return;
  recentTrajectories.set(trajectoryKey(answer), trajectory);
  while (recentTrajectories.size > 300) recentTrajectories.delete(recentTrajectories.keys().next().value);
}
const activeModelToolCalls = new Set();
let activeModelRequestId = null;
let selectedProject = null;
let selectedModel = mlxModels.DEFAULT_MODEL_ID;
// Which chat models the selector offers (Aprenentatge local › Gestiona els models, src/electron/model-manager.cjs).
let modelVisibility = {};
/** 'ask': the agent asks before installing packages. 'auto': it never asks. The user's choice, kept between sessions. */
let permissionMode = 'ask';
/** Preferències › Model and Agent (src/electron/preferences.cjs): sent to the agent with each request. */
let agentPreferences = defaultAgentPreferences();
/** Preferències › Agent › Dictat: the Whisper model and the language (src/electron/dictation.cjs). */
let dictationPreferences = dictation.defaultDictationPreferences();
/** Preferències › Aprenentatge: how a beta or a stable version is trained (src/electron/learning-versions.cjs). */
let trainingPreferences = versions.defaultTrainingPreferences();
let activeProjectProcess = null;
let activeProjectRoot = null;
let activeProjectOutput = '';
let chatStore;

function openStartedProjectInBrowser(result, projectPath) {
  const url = result.started ? findLocalProjectUrl(result.output) : null;
  if (!url) return result;
  const event = { projectPath, script: result.script, url };
  if (win && !win.isDestroyed()) win.webContents.send('project:started', event);
  return { ...result, url, openedInAppBrowser: true };
}

/**
 * After a project starts, loads its page in a hidden window and reports what a visitor would see:
 * HTTP status, title, visible text and console errors. A server that is up but serves a blank page
 * is not a finished task, and the model cannot know without looking. Never blocks or fails the start.
 */
async function checkStartedPage(result, actions = []) {
  if (!result || !result.url) return result;
  let probe;
  try {
    probe = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'started-page-check' } });
    const consoleErrors = [];
    let status = null;
    probe.webContents.on('console-message', (...args) => {
      const details = args[0] && typeof args[0].message === 'string' ? args[0] : { level: args[1], message: args[2] };
      if ((details.level === 3 || details.level === 'error') && consoleErrors.length < 10) consoleErrors.push(String(details.message).slice(0, 400));
    });
    probe.webContents.on('did-navigate', (_event, _url, httpResponseCode) => { status = httpResponseCode; });
    await Promise.race([
      probe.webContents.loadURL(result.url),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('la pàgina no ha carregat en 10 s')), 10000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // Clicks and form filling asked for by the agent, done in this same window.
    let acted = null;
    if (actions.length) {
      acted = await probe.webContents.executeJavaScript(pageActionsScript(actions), true);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const info = await probe.webContents.executeJavaScript('({ title: document.title, text: ((document.body && document.body.innerText) || "").trim().slice(0, 1500), buttons: [...document.querySelectorAll("button,[role=button],input[type=button],input[type=submit]")].filter((b) => b.getBoundingClientRect().width > 0).map((b) => (b.getAttribute("aria-label") || b.innerText || b.value || "").replace(/\\s+/g, " ").trim().slice(0, 60)).filter(Boolean).slice(0, 12) })', true);
    const problems = [];
    if (typeof status === 'number' && status >= 400) problems.push(`el servidor respon HTTP ${status}`);
    if (!info.text) problems.push('la pàgina no mostra cap text: està en blanc');
    if (consoleErrors.length) problems.push(`hi ha ${consoleErrors.length} errors a la consola`);
    return {
      ...result,
      page: { status, title: String(info.title || '').slice(0, 200), text: info.text, consoleErrors, buttons: Array.isArray(info.buttons) ? info.buttons : [] },
      ...(acted ? { actionResults: acted.results || [], actionError: acted.error || null } : {}),
      pageVerdict: problems.length
        ? `PROBLEMA: el servidor ha arrencat però ${problems.join('; ')}. La tasca no està acabada.`
        : 'La pàgina carrega i mostra contingut, sense errors de consola.',
    };
  } catch (error) {
    return { ...result, page: { error: error instanceof Error ? error.message : String(error) }, pageVerdict: 'No s’ha pogut comprovar la pàgina automàticament.' };
  } finally {
    if (probe && !probe.isDestroyed()) probe.destroy();
  }
}

const activeTurns = createActiveTurns();
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
  await fs.writeFile(settingsFile(), JSON.stringify({ selectedProject, selectedModel, permissionMode, agent: agentPreferences, agentPreferencesVersion: AGENT_PREFERENCES_VERSION, dictation: dictationPreferences, training: trainingPreferences, modelVisibility }, null, 2), 'utf8');
}

// Run from the repository, the models live in its models/ folder. An installed app cannot carry
// several gigabytes of weights inside its bundle, so it reads them from its data folder
// (~/Library/Application Support/Agentic Coder/models), or from AGENT_MODELS_DIR.
const projectModelsDirectory = () => process.env.AGENT_MODELS_DIR
  || (app.isPackaged ? path.join(app.getPath('userData'), 'models') : path.resolve(__dirname, '..', '..', 'models'));
// The engine's Python: models/.mlx-venv on a Mac (MLX), models/.cuda-venv on Linux (CUDA) (src/electron/mlx-models.cjs).
const mlxPythonPath = () => process.env.AGENT_MLX_PYTHON || mlxModels.enginePython(projectModelsDirectory());
// Every MLX model this app knows (src/electron/mlx-models.cjs); one is offered only when its weights are here.
const allModels = () => mlxModels.listModels(projectModelsDirectory());
const currentModel = async () => { const models = await allModels(); return models.find((model) => model.id === selectedModel) || mlxModels.defaultModel(models); };
async function getAvailableModels() {
  const mlxPythonReady = await fs.access(mlxPythonPath()).then(() => true, () => false);
  const result = [];
  for (const model of await allModels()) {
    const directory = await mlxModels.modelDirectory(model, projectModelsDirectory());
    const available = Boolean(directory && mlxPythonReady);
    const reason = available ? undefined : !directory ? 'Falten els pesos locals del model.' : mlxModels.engineFor() === 'mlx' ? 'Falta el runtime MLX de Python.' : 'Falta el runtime CUDA de Python (models/.cuda-venv; mira docs/linux.md).';
    result.push({ id: model.id, label: model.label, modelId: model.modelId, available, vision: mlxModels.engineFor() === 'mlx' && await mlxModels.hasVision(directory), shown: modelManager.shownInSelector(model, modelVisibility, selectedModel), ...(reason ? { reason } : {}) });
  }
  return result;
}

async function dispatchAgentTool(tool, projectRoot) {
  if (!tool || typeof tool !== 'object' || !selectedProject) throw new Error('La crida de l’eina no és vàlida.');
  const root = await fs.realpath(selectedProject);
  if (await fs.realpath(projectRoot) !== root) throw new Error('El projecte actiu ha canviat durant la tasca.');
  if (tool.name === 'web_search' && typeof tool.arguments?.query === 'string') {
    const query = tool.arguments.query.trim();
    if (!query || query.length > 200 || /[\r\n\0]/.test(query)) throw new Error('La consulta de cerca no és vàlida.');
    return searchWeb(query);
  }
  if (tool.name === 'read_web_page' && typeof tool.arguments?.url === 'string') return readRenderedWebPage(tool.arguments.url);
  if (tool.name === 'list_mcp_tools') {
    const servers = [];
    for (const name of Object.keys(await readMcpConfig(root))) {
      try { servers.push({ server: name, tools: await (await mcpServer(root, name)).listTools() }); }
      catch (error) { servers.push({ server: name, error: error instanceof Error ? error.message : String(error), tools: [] }); }
    }
    return { servers };
  }
  if (tool.name === 'call_mcp_tool' && typeof tool.arguments?.server === 'string' && typeof tool.arguments?.tool === 'string') {
    const result = await (await mcpServer(root, tool.arguments.server)).callTool(tool.arguments.tool, tool.arguments.arguments);
    return { server: tool.arguments.server, tool: tool.arguments.tool, ...result };
  }
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
    if (activeProjectProcess && activeProjectRoot === root) {
      return checkStartedPage(openStartedProjectInBrowser({ started: true, alreadyRunning: true, script, output: activeProjectOutput }, root));
    }
    if (activeProjectProcess) throw new Error('Ja hi ha una app d’un altre projecte en marxa. Atura-la abans de canviar de projecte.');
    return checkStartedPage(openStartedProjectInBrowser(await startProjectProcess(root, script), root));
  }
  if (tool.name === 'stop_project') {
    if (!activeProjectProcess) return { stopped: true, alreadyStopped: true };
    const root = activeProjectRoot;
    return stopProjectProcess();
  }
  // Everything package.json lists, in one go (`npm install`). Same rule as installing one package.
  if (tool.name === 'install_dependencies') {
    await readProjectPackage(root);
    if (permissionMode !== 'auto' && !approvedInstallRoots.has(root)) {
      const options = {
        type: 'question', buttons: ['Instal·la', 'Cancel·la'], defaultId: 1, cancelId: 1,
        message: 'Instal·lar les dependències del projecte?',
        detail: `L’agent vol executar: npm install\nCarpeta: ${root}\n\nBaixa d’internet els paquets que diu package.json i els pot executar en aquest ordinador. Si acceptes, no es tornarà a preguntar per a aquest projecte fins que tanquis l’app.`,
      };
      const confirmation = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
      if (confirmation.response !== 0) return { cancelled: true, error: 'L’usuari ha cancel·lat la instal·lació.' };
      approvedInstallRoots.add(root);
    }
    return executeNpmCommand(root, ['install'], 600000);
  }
  // The command-line tool of an npm package, as installation guides ask for (`npx <package> <args>`).
  // It downloads and runs code like an install does, so it asks under the same rule.
  if (tool.name === 'run_npx' && typeof tool.arguments?.packageName === 'string' && Array.isArray(tool.arguments?.args)) {
    const { packageName } = tool.arguments;
    const extra = tool.arguments.args;
    if (packageName.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[\w.^~-]{1,30})?$/i.test(packageName)) throw new Error('Nom de paquet npm no vàlid.');
    if (extra.length > 10 || extra.some((item) => typeof item !== 'string' || item.length > 120 || /[\r\n\0;&|`$<>]/.test(item))) throw new Error('Els arguments de l’ordre no són vàlids.');
    const args = ['-y', packageName, ...extra];
    if (permissionMode !== 'auto' && !approvedInstallRoots.has(root)) {
      const options = {
        type: 'question', buttons: ['Executa', 'Cancel·la'], defaultId: 1, cancelId: 1,
        message: `Executar l’eina del paquet «${packageName}»?`,
        detail: `L’agent vol executar: npx ${args.join(' ')}\nCarpeta: ${root}\n\nAixò baixa el paquet d’internet i l’executa en aquest ordinador; pot crear o canviar fitxers del projecte. Si acceptes, no es tornarà a preguntar per a aquest projecte fins que tanquis l’app.`,
      };
      const confirmation = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
      if (confirmation.response !== 0) return { cancelled: true, error: 'L’usuari ha cancel·lat l’execució.' };
      approvedInstallRoots.add(root);
    }
    return executeBinary('npx', args, root, 300000);
  }
  if (tool.name === 'install_package' && typeof tool.arguments?.packageName === 'string' && typeof tool.arguments?.dev === 'boolean') {
    const { packageName, dev } = tool.arguments;
    if (packageName.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(packageName)) throw new Error('Nom de paquet npm no vàlid.');
    await readProjectPackage(root);
    const args = ['install', ...(dev ? ['--save-dev'] : []), packageName];
    // The only agent action that asks first: installing a package downloads code from the
    // internet and may run it on this machine, outside the selected folder. It asks once per
    // project and session, so a task that needs several packages is not stopped at each one.
    if (permissionMode === 'auto' || approvedInstallRoots.has(root)) return executeNpmCommand(root, args, 300000);
    const options = {
      type: 'question', buttons: ['Instal·la', 'Cancel·la'], defaultId: 1, cancelId: 1,
      message: `Instal·lar el paquet npm «${packageName}»?`,
      detail: `L’agent vol executar: npm ${args.join(' ')}\nCarpeta: ${root}\n\nInstal·lar un paquet baixa codi d’internet i el pot executar en aquest ordinador. Si acceptes, no es tornarà a preguntar per a aquest projecte fins que tanquis l’app.`,
    };
    const confirmation = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    if (confirmation.response !== 0) return { cancelled: true, error: 'L’usuari ha cancel·lat la instal·lació del paquet.' };
    approvedInstallRoots.add(root);
    return executeNpmCommand(root, args, 300000);
  }
  if (tool.name === 'inspect_browser' && typeof tool.arguments?.url === 'string') {
    let target;
    try { target = new URL(tool.arguments.url); } catch { throw new Error('L’adreça local no és vàlida.'); }
    if (!['http:', 'https:'].includes(target.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname.toLowerCase()) || (target.port && (+target.port < 1 || +target.port > 65535))) {
      throw new Error('Per seguretat, la inspecció només pot obrir adreces locals de localhost, 127.0.0.1 o ::1.');
    }
    // Electron is already a browser: the app opens the page in a hidden window of its own, clicks
    // and fills there, and reads the result. Nothing has to be installed in the project.
    const looked = await checkStartedPage({ url: target.href }, Array.isArray(tool.arguments.actions) ? tool.arguments.actions : []);
    if (looked.page?.error) throw new Error(`No s’ha pogut obrir la pàgina: ${looked.page.error}`);
    if (looked.actionError) throw new Error(looked.actionError);
    return {
      inspected: true, url: safeBrowserUrl(target.href), status: looked.page?.status ?? null,
      title: looked.page?.title || '', text: looked.page?.text || '', consoleErrors: looked.page?.consoleErrors || [], buttons: looked.page?.buttons || [],
      pageErrors: [], requestFailures: [], actionResults: looked.actionResults || [], verdict: looked.pageVerdict,
    };
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
    return { path: relativePath, content: content.slice(0, 24000), truncated: content.length > 24000 };
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
    return deleteInspectedProjectFile(snapshot, backupPath, metadataPath);
  }
  if (tool.name === 'write_file' && typeof tool.arguments?.path === 'string' && typeof tool.arguments?.content === 'string') {
    const relativePath = tool.arguments.path;
    const content = tool.arguments.content;
    // Hidden folders (.git, .ssh…) and secret files (.env) stay off limits; the ordinary dot-files of a
    // project (.gitignore, .editorconfig, linter and formatter settings) can be written like any other.
    const parts = relativePath.split(/[\\/]/);
    const hiddenFolder = parts.slice(0, -1).some((part) => part.startsWith('.'));
    const hiddenFile = parts[parts.length - 1].startsWith('.') && !/^\.(?:gitignore|gitattributes|editorconfig|dockerignore|npmrc|nvmrc|prettierignore|eslintignore|env\.example|(?:prettierrc|eslintrc)(?:\.(?:json|js|cjs|yml|yaml))?)$/.test(parts[parts.length - 1]);
    if (relativePath.length > 500 || content.length > 24000 || path.isAbsolute(relativePath) || hiddenFolder || hiddenFile) {
      throw new Error('El camí o el contingut no es pot revisar de manera segura. Usa el panell editor per a fitxers més grans.');
    }
    const target = safeProjectPath(root, relativePath);
    const parent = await ensureProjectDirectory(root, path.dirname(target));
    if (!isWithin(root, parent)) throw new Error('La carpeta de destinació surt del projecte.');
    let existing = null;
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Només es poden modificar fitxers normals.');
      existing = { path: await fs.realpath(target), content: await fs.readFile(target, 'utf8') };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && !isWithin(root, existing.path)) throw new Error('La ruta resolta surt de la carpeta del projecte.');
    if (existing && existing.content.length > 24000) throw new Error('El fitxer és massa llarg per modificar-lo amb seguretat des de l’eina ràpida. Obre’l a l’editor per revisar-lo.');
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

function startProjectProcess(root, script) {
  return new Promise((resolve) => {
    const child = processes.start('npm', ['run', script], { cwd: root, env: { ...process.env } });
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
      if (findLocalProjectUrl(activeProjectOutput)) {
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
    processes.stopTree(child, 'SIGTERM');
    const forceTimer = setTimeout(() => {
      processes.stopTree(child, 'SIGKILL');
      finish({ stopped: true, forced: true, output: activeProjectOutput });
    }, 4000);
  });
}

// Log del model (src/core/assistant/llm-trace.ts): what goes into the model and what comes out, recorded
// only while its panel is open, in logs/llm-calls.jsonl in the data folder (never in the history or the
// training data). The logprobs (each token's probability) cost speed: their own switch, off by default.
const llmTrace = { open: false, logprobs: false };
const llmCallsLog = () => path.join(app.getPath('userData'), 'logs', 'llm-calls.jsonl');
const sendLlmTrace = () => { if (modelWorker?.connected) modelWorker.send({ type: 'llm-trace', on: llmTrace.open, logprobs: llmTrace.logprobs, file: llmCallsLog() }); };
// Preferències › Aparença › Fons general: «Translúcid» shows the desktop through the window behind the
// panels (macOS vibrancy, like the Finder's sidebar); «Opac» is the window as it always was. Live, no restart.
ipcMain.handle('window:set-translucent', async (_event, on) => {
  if (process.platform !== 'darwin' || !win || win.isDestroyed()) return false;
  win.setVibrancy(on === true ? 'sidebar' : null);
  win.setBackgroundColor(on === true ? '#00000000' : '#171717');
  return on === true;
});
// The app's version, as in GesProd: the count of commits of the branch and the commit (src/electron/app-version.cjs),
// shown under the mark in the left bar.
ipcMain.handle('app:version', async () => require('./app-version.cjs').appVersion({
  isPackaged: app.isPackaged,
  packageJson: require(path.join(__dirname, '..', '..', 'package.json')),
  git: () => require('./app-version.cjs').fromGit(path.join(__dirname, '..', '..')),
}));
ipcMain.handle('llm:set', async (_event, change) => {
  if (typeof change?.open === 'boolean') llmTrace.open = change.open;
  if (typeof change?.logprobs === 'boolean') llmTrace.logprobs = change.logprobs;
  sendLlmTrace();
  return { ...llmTrace };
});
// The last calls (newest first), each with the tools run after it.
ipcMain.handle('llm:list', async () => llmCalls.readCalls([llmCallsLog().replace(/\.jsonl$/, '.1.jsonl'), llmCallsLog()], 50));
ipcMain.handle('llm:clear', async () => {
  for (const file of [llmCallsLog(), llmCallsLog().replace(/\.jsonl$/, '.1.jsonl')]) await fs.rm(file, { force: true });
  return { calls: [] };
});
ipcMain.handle('llm:reveal', async () => {
  await fs.mkdir(path.dirname(llmCallsLog()), { recursive: true });
  if (!fsSync.existsSync(llmCallsLog())) await fs.writeFile(llmCallsLog(), '');
  shell.showItemInFolder(llmCallsLog());
  return true;
});

/** The chat models loaded in this app session (their workers may have been stopped since). */
const loadedModels = new Set();
/** The model the running chat worker has (or is loading). */
let modelWorkerModelId = null;
async function startModelWorker() {
  if (modelWorker && modelWorker.connected) return modelWorker;
  // On Linux there is no built-in model: the first one is added in Gestiona els models.
  if (!await currentModel()) throw new Error('Encara no hi ha cap model en aquest ordinador: afegeix-ne un a Aprenentatge local › Gestiona els models.');
  const nodeExecutable = findNodeExecutable();
  const child = fork(path.join(__dirname, '..', 'core', 'assistant', 'agent-worker.cjs'), [], {
    execPath: nodeExecutable,
    execArgv: [],
    env: {
      ...process.env,
      AGENT_MODEL_CACHE: projectModelsDirectory(),
      // The native engine (Node, no Python) for the models it runs, unless Preferències › Agent chooses Python.
      AGENT_MODEL_RUNTIME: await mlxModels.runtimeFor(await currentModel(), await mlxModels.modelDirectory(await currentModel(), projectModelsDirectory()), { python: agentPreferences.pythonEngine }),
      AGENT_MODEL: (await currentModel()).modelId,
      // An installed app must not write inside its own bundle: the turn log goes to the data folder.
      ...(app.isPackaged && !process.env.AGENT_TURN_LOG ? { AGENT_TURN_LOG: path.join(app.getPath('userData'), 'logs', 'agent-turns.jsonl') } : {}),
      // Without a Node.js of its own, the worker runs on Electron's Node.
      ...(nodeExecutable === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      AGENT_MLX_PYTHON: mlxPythonPath(),
      AGENT_MLX_LOCK_LABEL: 'el xat d’Agentic Coder',
      AGENT_MLX_MODEL_PATH: await mlxModels.modelDirectory(await currentModel(), projectModelsDirectory()) || '',
      // A model already loaded once in this session is «loaded again», not «the first time»; one that sees
      // images gets the text of prompts/vision.md.
      ...(loadedModels.has((await currentModel()).id) ? { AGENT_MODEL_RELOAD: '1' } : {}),
      ...(mlxModels.engineFor() === 'mlx' && await mlxModels.hasVision(await mlxModels.modelDirectory(await currentModel(), projectModelsDirectory())) ? { AGENT_MODEL_VISION: '1' } : {}),
      // A beta is the base with its adapter (src/electron/learning-versions.cjs); any other model, none.
      AGENT_MLX_ADAPTER_PATH: (await currentModel()).adapterPath || '',
      AGENT_VERIFIED_EXPERIENCES_PATH: path.join(app.getPath('userData'), 'learning', 'verified-experiences.jsonl'),
      AGENT_EMBEDDING_INDEX_PATH: path.join(app.getPath('userData'), 'learning', 'embedding-index-v1.json'),
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  modelWorker = child;
  modelWorkerModelId = (await currentModel()).id;
  // Log del model: on only while its panel is open.
  child.send({ type: 'llm-trace', on: llmTrace.open, logprobs: llmTrace.logprobs, file: llmCallsLog() });
  loadedModels.add(modelWorkerModelId);
  child.on('message', (message) => {
    if (message?.type === 'llm-event') { if (win && !win.isDestroyed()) win.webContents.send('llm:event', message.event); return; }
    if (message?.type === 'status') { activeTurns.status(message.value); win?.webContents.send('agent:status', message.value); return; }
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
    if (message.error) pending.reject(new Error(message.error)); else { rememberTrajectory(message.answer, message.trajectory); pending.resolve(message.answer); }
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

// The project tools (Vite 6/7, Chakra 3's CLI…) need Node.js 20 or later. With several versions installed
// (nvm), which one comes first depends on how the app was started: after a restart on 13-11-2026 the app
// got Node 18 and an evaluation ran on it, while the earlier ones had run on Node 24. So the newest Node
// 20+ found is used (AGENT_NODE_EXECUTABLE still wins), and the same one for the project's npm commands.
const MIN_NODE_MAJOR = 20;
function nodeMajor(executable) {
  const fromPath = /[\\/]v(\d+)\.\d+\.\d+[\\/]/.exec(executable);
  if (fromPath) return Number(fromPath[1]);
  try { return Number(/^v(\d+)/.exec(require('node:child_process').execFileSync(executable, ['-v'], { encoding: 'utf8', timeout: 3000 }))?.[1] || 0); }
  catch { return 0; }
}
let foundNode;
function findNodeExecutable() {
  if (foundNode) return foundNode;
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  if (process.env.AGENT_NODE_EXECUTABLE) return (foundNode = process.env.AGENT_NODE_EXECUTABLE);
  const candidates = [process.env.npm_node_execpath];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (directory) candidates.push(path.join(directory, name));
  }
  // Opened from Finder, an app gets a short PATH without Homebrew, nvm or the usual installers.
  if (process.platform === 'darwin') candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node');
  const nvmVersions = path.join(app.getPath('home'), '.nvm', 'versions', 'node');
  for (const version of fsSync.existsSync(nvmVersions) ? fsSync.readdirSync(nvmVersions) : []) candidates.push(path.join(nvmVersions, version, 'bin', name));
  const usable = [];
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    if (path.resolve(candidate) === path.resolve(process.execPath)) continue;
    try { fsSync.accessSync(candidate, fsSync.constants.X_OK); } catch { continue; }
    usable.push({ path: candidate, major: nodeMajor(candidate) });
  }
  // The newest Node 20+, or else the first one found (as before).
  const best = usable.filter((item) => item.major >= MIN_NODE_MAJOR).sort((a, b) => b.major - a.major)[0] || usable[0];
  if (best) return (foundNode = best.path);
  if (app.isPackaged) return process.execPath;
  throw new Error('No he trobat Node.js per executar el treballador local. Configura AGENT_NODE_EXECUTABLE o obre l’app des d’un entorn amb Node.js al PATH.');
}

function cleanConversationHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-100).flatMap((message) => {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') return [];
    // The window's notices (stopped, error) are not something the model said.
    if (isChatNotice(message)) return [];
    // Answers saved before the reviewer's note had a field of its own ended with it: it is the app's, so
    // it is taken off (src/electron/active-turn.cjs).
    const content = (message.role === 'assistant' ? withoutReviewerNote(message.content) : message.content).trim();
    if (!content || content.length > 2000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(content)) return [];
    if (message.role === 'assistant' && /(?:"type"\s*:\s*"tool_call"|<tool_call>|<\|tool_call\|>)/i.test(content)) return [];
    return [{ role: message.role, content }];
  });
}

async function askModel(prompt, projectRoot, history = [], images = []) {
  if (activeModelRequestId !== null) throw new Error('Ja hi ha una petició al model local en marxa.');
  // One model on the GPU at a time (unless the dictation lives beside it): a resident Whisper goes first.
  if (!liveModel?.shared) residentWhisper.release();
  const id = ++requestId;
  activeModelRequestId = id;
  let child;
  let imagePaths = [];
  try {
    // Images go to the worker as files for this request only, and are removed when it ends.
    if (images.length) imagePaths = await writeChatImages(path.join(app.getPath('userData'), 'chat-images'), images);
    child = await startModelWorker();
  } catch (error) { activeModelRequestId = null; await removeChatImages(imagePaths); throw error; }
  return new Promise((resolve, reject) => {
    const done = (settle) => (value) => { void removeChatImages(imagePaths); settle(value); };
    pendingModelRequests.set(id, { resolve: done(resolve), reject: done(reject) });
    const { answerTokens, maxIterations, review, webSearch, historyMessages } = agentPreferences;
    child.send({ id, prompt, projectRoot, history: limitHistory(cleanConversationHistory(history), historyMessages), settings: { answerTokens, maxIterations, review, webSearch }, images: imagePaths }, (error) => {
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
    return { cancelled: false, reason: 'project-action-in-progress' };
  }
  const pending = pendingModelRequests.get(id);
  if (!pending) return { cancelled: false, reason: 'no-active-request' };

  pendingModelRequests.delete(id);
  activeModelRequestId = null;
  const child = modelWorker;
  modelWorker = null;
  pending.reject(new Error('Generació cancel·lada.'));
  // The worker is stopped before it can write its turn: the stop is written to the same log.
  if (!process.env.NODE_TEST_CONTEXT) void appendTurnLog(turnLogPath({ isPackaged: app.isPackaged, userData: app.getPath('userData'), appRoot: path.resolve(__dirname, '../..') }), { kind: 'cancelled', requestId: id }).catch(() => {});
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
  // The window opens as it was left (size, place, maximized, full screen); not for a docs capture.
  const stateFile = path.join(app.getPath('userData'), 'window-state.json');
  const remember = !process.env.AGENT_SCREENSHOT;
  const saved = remember ? windowState.readWindowState(stateFile) : null;
  const displays = [screen.getPrimaryDisplay(), ...screen.getAllDisplays().filter((display) => display.id !== screen.getPrimaryDisplay().id)].map((display) => display.workArea);
  const bounds = windowState.windowBounds(saved, displays);
  win = new BrowserWindow({
    ...bounds, minWidth: windowState.DEFAULTS.minWidth, minHeight: windowState.DEFAULTS.minHeight,
    title: 'Agentic Coder — Local',
    // On macOS the app draws its own title bar; the three window buttons stay where they are.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 11 } } : {}),
    backgroundColor: '#171717',
    // Preferències › Aparença › Fons general «Translúcid» turns on the vibrancy (window:set-translucent);
    // «active» keeps it when the window is not in front.
    ...(process.platform === 'darwin' ? { visualEffectState: 'active' } : {}),
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true }
  });
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (params.src !== 'about:blank' && !/^https?:\/\//i.test(params.src)) event.preventDefault();
  });
  // A link clicked in the chat must not replace the app itself: local addresses open in the built-in
  // browser panel, anything else in the system browser.
  const openOutside = (url) => {
    if (/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i.test(url)) win.webContents.send('project:started', { projectPath: selectedProject, script: '', url });
    else if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  win.webContents.on('will-navigate', (event, url) => { event.preventDefault(); openOutside(url); });
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  if (saved?.maximized) win.maximize();
  if (saved?.fullScreen) win.setFullScreen(true);
  if (remember) {
    const save = () => {
      if (!win || win.isDestroyed()) return;
      windowState.writeWindowState(stateFile, { bounds: win.getNormalBounds(), maximized: win.isMaximized(), fullScreen: win.isFullScreen() });
    };
    let timer = null;
    const saveSoon = () => { clearTimeout(timer); timer = setTimeout(save, 400); };
    for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(event, saveSoon);
    win.on('close', () => { clearTimeout(timer); save(); });
  }
  win.loadFile(path.join(__dirname, '..', 'index.html'));
  if (process.env.AGENT_SCREENSHOT) win.webContents.once('did-finish-load', () => void captureForDocs());
}

/** The window as it is now, as a PNG (Electron's capturePage: no screen-recording permission needed). */
async function saveWindowCapture() {
  if (!win || win.isDestroyed()) return;
  const image = await win.webContents.capturePage();
  const result = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('pictures'), `agentic-coder-${new Date().toISOString().slice(0, 10)}.png`), filters: [{ name: 'PNG', extensions: ['png'] }] });
  if (!result.canceled && result.filePath) await fs.writeFile(result.filePath, image.toPNG());
}

// For the README: AGENT_SCREENSHOT=<file.png> opens the app (on AGENT_SCREENSHOT_PROJECT if given, without saving
// it as the selected project), sets its size (AGENT_SCREENSHOT_SIZE=1600x1000),
// clicks what AGENT_SCREENSHOT_CLICKS lists, in order («label:<aria-label>» or «text:<visible text>»,
// separated by «|»), waits, saves the window and quits.
async function captureForDocs() {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const [width, height] = (process.env.AGENT_SCREENSHOT_SIZE || '1600x1000').split('x').map(Number);
  if (width && height) win.setContentSize(width, height);
  await wait(2500);
  for (const step of (process.env.AGENT_SCREENSHOT_CLICKS || '').split('|').map((item) => item.trim()).filter(Boolean)) {
    const [kind, ...rest] = step.split(':');
    const value = JSON.stringify(rest.join(':'));
    const found = await win.webContents.executeJavaScript(kind === 'label'
      ? `(() => { const el = document.querySelector('[aria-label=' + JSON.stringify(${value}) + ']'); if (el) el.click(); return Boolean(el); })()`
      : `(() => { const el = [...document.querySelectorAll('button, [role=button], [role=treeitem], p, span, div')].reverse().find((node) => node.textContent.trim() === ${value} && node.offsetParent); if (el) el.click(); return Boolean(el); })()`);
    if (!found) console.error(`Captura: no s’ha trobat «${step}».`);
    await wait(900);
  }
  await wait(Number(process.env.AGENT_SCREENSHOT_DELAY || 2500));
  const image = await win.webContents.capturePage();
  await fs.writeFile(path.resolve(process.env.AGENT_SCREENSHOT), image.toPNG());
  console.error(`Captura desada: ${process.env.AGENT_SCREENSHOT} (${image.getSize().width}x${image.getSize().height})`);
  app.quit();
}

// The app's own menu, in Catalan (src/electron/app-menu.cjs; its text in src/electron/menu-labels.cjs).
// What it does in the window goes there as an action; the panes it marks are those the window reports open.
const REPOSITORY_URL = 'https://github.com/Celtico/agentic-coder-mvp';
let menuPanes = {};
const sendMenuAction = (action, extra = {}) => { if (win && !win.isDestroyed()) win.webContents.send('app:menu', { action, ...extra }); };
function installAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({
    labels: menuLabels,
    panes: menuPanes,
    actions: {
      preferences: () => sendMenuAction('preferences'),
      openFolder: () => sendMenuAction('open-folder'),
      newChat: () => sendMenuAction('new-chat'),
      save: () => sendMenuAction('save'),
      togglePane: (pane) => sendMenuAction('toggle-pane', { pane }),
      capture: () => void saveWindowCapture(),
      repository: () => void shell.openExternal(REPOSITORY_URL),
      readme: () => {
        const readme = path.resolve(__dirname, '..', '..', 'README.md');
        if (fsSync.existsSync(readme)) void shell.openPath(readme); else void shell.openExternal(`${REPOSITORY_URL}#readme`);
      },
      turnLog: () => {
        const file = turnLogPath({ isPackaged: app.isPackaged, userData: app.getPath('userData'), appRoot: path.resolve(__dirname, '../..') });
        if (file && fsSync.existsSync(file)) void shell.openPath(file);
        else if (file) { fsSync.mkdirSync(path.dirname(file), { recursive: true }); void shell.openPath(path.dirname(file)); }
      },
    },
  })));
}
ipcMain.on('menu:panes', (_event, panes) => {
  const next = Object.fromEntries(MENU_PANES.map((pane) => [pane, Boolean(panes && typeof panes === 'object' && panes[pane] === true)]));
  if (MENU_PANES.every((pane) => next[pane] === Boolean(menuPanes[pane]))) return;
  menuPanes = next;
  installAppMenu();
});

// The capture for the README runs as a second copy of the app: it gets a data folder of its own (a temporary
// copy of the evaluations, which the Avaluació column shows), so it never shares the open app's folder.
// Sharing it closed the open app on 13-11-2026 while an evaluation was running.
if (process.env.AGENT_SCREENSHOT) {
  const own = fsSync.mkdtempSync(path.join(app.getPath('temp'), 'agentic-capture-'));
  const evaluations = path.join(app.getPath('userData'), 'benchmarks');
  if (fsSync.existsSync(evaluations)) {
    fsSync.mkdirSync(path.join(own, 'benchmarks'));
    for (const name of fsSync.readdirSync(evaluations).filter((item) => item.endsWith('.json'))) fsSync.copyFileSync(path.join(evaluations, name), path.join(own, 'benchmarks', name));
  }
  app.setPath('userData', own);
}

app.whenReady().then(async () => {
  // Run from source there is no app bundle to carry the icon, so the Dock gets it here.
  if (process.platform === 'darwin' && app.dock) { try { app.dock.setIcon(path.join(__dirname, '..', '..', 'assets', 'icon.png')); } catch { /* keeps Electron's icon */ } }
  let migratedSettings = false;
  try {
    const saved = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
    if (typeof saved.selectedProject === 'string' && (await fs.stat(saved.selectedProject)).isDirectory()) selectedProject = saved.selectedProject;
    // The Qwen 1.5B is no longer offered: settings saved with it move to the base model.
    const savedModel = saved.selectedModel === 'qwen-1.5b' ? mlxModels.DEFAULT_MODEL_ID : saved.selectedModel;
    if ((await allModels()).some((model) => model.id === savedModel)) selectedModel = savedModel;
    if (saved.permissionMode === 'auto' || saved.permissionMode === 'ask') permissionMode = saved.permissionMode;
    // Saved with older defaults (history 100, reviewer on): moved to the current ones once, and saved.
    const agentSettings = migrateAgentPreferences(saved.agent, saved.agentPreferencesVersion);
    agentPreferences = normalizeAgentPreferences(agentSettings.agent);
    if (agentSettings.migrated) migratedSettings = true;
    dictationPreferences = dictation.normalizeDictationPreferences(saved.dictation);
    trainingPreferences = versions.normalizeTrainingPreferences(saved.training);
    modelVisibility = modelManager.normalizeVisibility(saved.modelVisibility);
  } catch {}
  if (migratedSettings) await saveSettings().catch(() => {});
  if (!selectedProject) {
    // From the repository the app opens itself; installed, it starts in an empty folder of its own,
    // never in the home folder, because the agent writes in the selected folder without asking.
    selectedProject = app.isPackaged ? path.join(app.getPath('userData'), 'projecte-de-prova') : path.resolve(__dirname, '..', '..');
    await fs.mkdir(selectedProject, { recursive: true });
    await saveSettings();
  }
  // Every command the app runs for a project (npm, npx, Vite…) uses the Node chosen above.
  try {
    const node = findNodeExecutable();
    if (node !== process.execPath) process.env.PATH = [path.dirname(node), process.env.PATH || ''].join(path.delimiter);
    console.error(`Node.js per al model i els projectes: ${node} (v${nodeMajor(node) || '?'})`);
  } catch { /* no Node: the worker reports it */ }
  if (process.env.AGENT_SCREENSHOT && process.env.AGENT_SCREENSHOT_PROJECT) selectedProject = path.resolve(process.env.AGENT_SCREENSHOT_PROJECT);
  installAppMenu();
  // The microphone is for the window's dictation only, sound only; other requests keep Electron's answer.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== 'media') { callback(true); return; }
    const types = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
    callback(Boolean(win && !win.isDestroyed() && contents === win.webContents && types.length > 0 && types.every((type) => type === 'audio')));
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  if (activeProjectProcess) stopProjectProcess(); stopMcpServers(); residentWhisper.release();
  // An evaluation or a training runs in a process group of its own (runStreaming, detached): without this it
  // outlives the app with its model on the GPU, and the reopened app does not know it is there.
  benchmarkRun?.controller.abort(); trainingRun?.controller.abort(); modelDownload?.controller.abort();
});

ipcMain.handle('project:open', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  selectedProject = result.filePaths[0];
  await saveSettings();
  return { path: selectedProject, files: await listFiles(selectedProject) };
});

ipcMain.handle('project:create-entry', async (_event, relativePath, directory) => {
  if (!selectedProject) throw new Error('Primer obre un projecte.');
  if (typeof relativePath !== 'string' || relativePath.length > 500 || typeof directory !== 'boolean') throw new Error('La ruta no és vàlida.');
  const parts = relativePath.split(/[\\/]/);
  if (!relativePath.trim() || path.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath) || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Indica una ruta relativa vàlida dins del projecte.');
  }
  const root = await fs.realpath(selectedProject);
  const target = safeProjectPath(root, relativePath);
  const parent = await ensureProjectDirectory(root, path.dirname(target));
  if (!isWithin(root, parent)) throw new Error('La carpeta de destinació surt del projecte.');
  try { await fs.lstat(target); throw new Error('Ja existeix un fitxer o directori amb aquest nom; no s’ha substituït.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (directory) await fs.mkdir(target);
  else await fs.writeFile(target, '', { encoding: 'utf8', mode: 0o644, flag: 'wx' });
  return { path: root, files: await listFiles(root) };
});

ipcMain.handle('project:delete-entry', async (_event, relativePath, directory) => {
  if (!selectedProject) throw new Error('Primer obre un projecte.');
  if (typeof relativePath !== 'string' || relativePath.length > 500 || typeof directory !== 'boolean') throw new Error('La ruta no és vàlida.');
  const parts = relativePath.split(/[\\/]/);
  if (!relativePath.trim() || path.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath) || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Indica una ruta relativa vàlida dins del projecte.');
  }
  const root = await fs.realpath(selectedProject);
  const entry = (await listFiles(root)).find((item) => item.path === relativePath);
  if (!entry || entry.directory !== directory) throw new Error('L’element ja no és al tree del projecte.');
  const target = safeProjectPath(root, relativePath);
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) throw new Error('No es poden eliminar enllaços simbòlics.');
  if (directory) {
    if (!stat.isDirectory()) throw new Error('L’element no és una carpeta.');
    const resolved = await fs.realpath(target);
    if (!isWithin(root, resolved)) throw new Error('La carpeta de destinació surt del projecte.');
    if ((await fs.readdir(resolved)).length) throw new Error('La carpeta conté elements. Elimina o mou primer els seus elements.');
    await fs.rmdir(resolved);
  } else {
    if (!stat.isFile()) throw new Error('L’element no és un fitxer normal.');
    const snapshot = await inspectFileForDeletion(root, relativePath);
    const projectKey = createHash('sha256').update(root).digest('hex').slice(0, 16);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-') + `-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    const deletedRoot = path.join(app.getPath('userData'), 'backups', projectKey, 'deleted');
    await deleteInspectedProjectFile(snapshot, path.join(deletedRoot, stamp, relativePath), path.join(deletedRoot, stamp, '.agentic-metadata.json'));
  }
  return { path: root, files: await listFiles(root) };
});

ipcMain.handle('project:rename-entry', async (_event, relativePath, newName) => {
  if (!selectedProject) throw new Error('Primer obre un projecte.');
  if (typeof relativePath !== 'string' || relativePath.length > 500 || typeof newName !== 'string' || !newName.trim() || newName.length > 255 || /[\\/]/.test(newName) || newName === '.' || newName === '..') throw new Error('El nom no és vàlid.');
  const root = await fs.realpath(selectedProject);
  const entry = (await listFiles(root)).find((item) => item.path === relativePath);
  if (!entry) throw new Error('L’element ja no és al tree del projecte.');
  const source = safeProjectPath(root, relativePath);
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error('No es poden canviar els noms d’enllaços simbòlics.');
  const parent = await fs.realpath(path.dirname(source));
  if (!isWithin(root, parent)) throw new Error('La carpeta de destinació surt del projecte.');
  const destination = path.join(parent, newName.trim());
  try { await fs.lstat(destination); throw new Error('Ja existeix un element amb aquest nom.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.rename(source, destination);
  return { path: root, files: await listFiles(root) };
});

ipcMain.handle('project:import-directory', async (_event, sourcePath) => {
  if (!selectedProject) throw new Error('Primer obre un projecte.');
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) throw new Error('No s’ha pogut llegir la carpeta arrossegada.');
  const root = await fs.realpath(selectedProject);
  const source = await fs.realpath(sourcePath);
  const sourceStat = await fs.lstat(sourcePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error('Arrossega una carpeta normal.');
  if (isWithin(source, root) || isWithin(root, source)) throw new Error('No pots importar el projecte seleccionat ni una carpeta que el contingui.');
  const name = path.basename(source);
  if (!name || name === '.' || name === path.parse(name).root) throw new Error('El nom de la carpeta no és vàlid.');
  const destination = safeProjectPath(root, name);
  const parent = await ensureProjectDirectory(root, path.dirname(destination));
  if (!isWithin(root, parent)) throw new Error('La carpeta de destinació surt del projecte.');
  try { await fs.lstat(destination); throw new Error(`Ja existeix «${name}» dins del projecte; no s’ha importat ni substituït res.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const temporary = path.join(parent, `.${name}.import-${process.pid}-${Date.now()}`);
  let entries = 0;
  const copyDirectory = async (from, to, depth = 0) => {
    if (depth > 20) throw new Error('La carpeta té massa nivells niats.');
    await fs.mkdir(to);
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      if (++entries > 10000) throw new Error('La carpeta conté més de 10.000 elements.');
      const fromPath = path.join(from, entry.name);
      const toPath = path.join(to, entry.name);
      if (entry.isSymbolicLink()) throw new Error('La carpeta conté enllaços simbòlics; no s’ha importat.');
      if (entry.isDirectory()) await copyDirectory(fromPath, toPath, depth + 1);
      else if (entry.isFile()) await fs.copyFile(fromPath, toPath, fs.constants.COPYFILE_EXCL);
      else throw new Error('La carpeta conté un tipus de fitxer no compatible.');
    }
  };
  try {
    await copyDirectory(source, temporary);
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { path: root, files: await listFiles(root) };
});

async function listFiles(root, rel = '', depth = 0) {
  if (depth > 3) return [];
  const ignored = new Set(['.git', '.idea', '.vscode', '.cache', 'node_modules', '.next', 'dist', 'build', '.venv', 'venv', 'models']);
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

/**
 * Empties the selected project so a trial can start from zero. Everything goes to the system
 * Trash, where it can be recovered, and only after the user confirms. Refuses folders that are
 * plainly not a throwaway project (the home folder, a volume root, or anything too shallow).
 */
ipcMain.handle('project:clear', async () => {
  if (!selectedProject) throw new Error('Obre primer un projecte.');
  const root = await fs.realpath(selectedProject);
  const home = await fs.realpath(app.getPath('home'));
  const depth = root.split(path.sep).filter(Boolean).length;
  if (root === home || isWithin(root, home) || depth < 3 || path.dirname(root) === home && /^(Desktop|Documents|Downloads|Library)$/i.test(path.basename(root))) {
    throw new Error('Aquesta carpeta no es pot buidar des de l’app.');
  }
  // The files that set the agent up for this project stay: emptying is for starting the code over,
  // not for losing the instructions.
  const kept = (await fs.readdir(root)).filter((name) => /^(?:agents\.md|skills\.md|\.?mcp\.json)$/i.test(name));
  const entries = (await fs.readdir(root)).filter((name) => !kept.includes(name));
  if (entries.length === 0) return { cleared: 0, project: { path: selectedProject, files: await listFiles(selectedProject) } };
  const options = {
    type: 'warning', buttons: ['Buida la carpeta', 'Cancel·la'], defaultId: 1, cancelId: 1,
    message: `Buidar «${path.basename(root)}»?`,
    detail: `Es mouran a la paperera ${entries.length} elements de ${root}${entries.includes('.git') ? ', inclòs l’historial de Git (.git)' : ''}. Els podràs recuperar des de la paperera.${kept.length ? `\n\nEs conserven: ${kept.join(', ')}.` : ''}`,
  };
  const confirmation = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (confirmation.response !== 0) return { cancelled: true, cleared: 0, project: { path: selectedProject, files: await listFiles(selectedProject) } };
  if (activeProjectProcess && activeProjectRoot === root) await stopProjectProcess();
  let cleared = 0;
  for (const name of entries) {
    await shell.trashItem(path.join(root, name));
    cleared += 1;
  }
  return { cleared, project: { path: selectedProject, files: await listFiles(selectedProject) } };
});

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

function projectBackupRoot(root) {
  const projectKey = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return path.join(app.getPath('userData'), 'backups', projectKey);
}

ipcMain.handle('project:file-history', async (_event, relativePath) => {
  if (!selectedProject) throw new Error('Obre primer un projecte.');
  const root = await fs.realpath(selectedProject);
  return listProjectFileHistory(projectBackupRoot(root), relativePath);
});

ipcMain.handle('project:folder-history', async (_event, relativePath = '') => {
  if (!selectedProject) throw new Error('Obre primer un projecte.');
  if (typeof relativePath !== 'string' || relativePath.length > 500 || (relativePath && (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')))) throw new Error('La ruta de la carpeta no és vàlida.');
  const root = await fs.realpath(selectedProject);
  if (relativePath) {
    const directory = safeProjectPath(root, relativePath);
    const stat = await fs.lstat(directory).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('Selecciona una carpeta existent del projecte.');
  }
  return listProjectFolderHistory(projectBackupRoot(root), relativePath);
});

ipcMain.handle('project:file-history-version', async (_event, relativePath, versionId) => {
  if (!selectedProject) throw new Error('Obre primer un projecte.');
  const root = await fs.realpath(selectedProject);
  return readProjectFileHistoryVersion(projectBackupRoot(root), relativePath, versionId);
});

ipcMain.handle('project:restore-file-history', async (_event, relativePath, versionId) => {
  if (!selectedProject) throw new Error('Obre primer un projecte.');
  const root = await fs.realpath(selectedProject);
  const version = await readProjectFileHistoryVersion(projectBackupRoot(root), relativePath, versionId);
  if (!selectedProject || await fs.realpath(selectedProject) !== root) throw new Error('El projecte seleccionat ha canviat; torna a obrir l’historial.');
  if (versionId.startsWith('deleted/')) {
    const projectKey = createHash('sha256').update(root).digest('hex').slice(0, 16);
    const deletedRoot = path.join(app.getPath('userData'), 'backups', projectKey, 'deleted');
    await restoreDeletedProjectFile(root, deletedRoot, `${versionId.slice('deleted/'.length)}/${relativePath}`);
    return { restored: true, path: relativePath };
  }
  await writeProjectFile(root, relativePath, version.content, { allowCreate: true });
  return { restored: true, path: relativePath };
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

// Whether a file is there, without an error in the log when it is not (a file deleted since).
ipcMain.handle('project:exists', async (_e, relativePath) => Boolean(selectedProject) && projectFileExists(selectedProject, relativePath));

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
  const parent = await ensureProjectDirectory(root, path.dirname(target));
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
    const stamp = new Date().toISOString().replace(/[:.]/g, '-') + `-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    backupPath = path.join(app.getPath('userData'), 'backups', projectKey, stamp, relative);
    await fs.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    await fs.copyFile(resolved, backupPath, fs.constants.COPYFILE_EXCL);
    await fs.chmod(backupPath, 0o600);
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
  return executeProjectChecks(root, executeNpmScript);
}

async function executeNpmScript(root, script) {
  return executeNpmCommand(root, ['run', script], 120000);
}

async function executeNpmCommand(root, args, timeoutMs) {
  return executeBinary('npm', args, root, timeoutMs);
}

async function executeBinary(executable, args, root, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try { child = processes.start(executable, args, { cwd: root, env: { ...process.env, CI: '1' } }); }
    catch (error) { resolve({ code: -1, output: error.message }); return; }
    let output = '';
    let settled = false;
    let timedOut = false;
    // Shown in the terminal as it happens, so what the agent runs is never invisible.
    const show = (text) => { if (win && !win.isDestroyed()) win.webContents.send('terminal:output', text); };
    show(`\r\n$ ${path.basename(executable)} ${args.join(' ')}\r\n`);
    const append = (chunk) => { output = (output + chunk.toString()).slice(-100000); show(chunk.toString()); };
    const timer = setTimeout(() => {
      timedOut = true;
      processes.stopTree(child, 'SIGTERM');
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
ipcMain.handle('chat-store:delete', (_event, id) => getChatStore().delete(id));
ipcMain.handle('chat-store:deleted', () => getChatStore().listDeleted());
ipcMain.handle('chat-store:restore', (_event, id) => getChatStore().restore(id));
ipcMain.handle('chat-store:empty-trash', () => getChatStore().emptyTrash());

ipcMain.handle('learning:validate-manual-case', (_e, value) => learningCases.validateManualCase(value).errors);
ipcMain.handle('learning:record-verified-experience', async (_e, value) => {
  if (!selectedProject) throw new Error('Primer obre un projecte.');
  if (!value || typeof value !== 'object') throw new Error('El cas d’aprenentatge no és vàlid.');
  // A case written by hand: every field is required and checked (src/electron/learning-cases.cjs).
  if (value.source === 'manual') {
    const { errors } = learningCases.validateManualCase(value);
    const first = Object.values(errors)[0];
    if (first) throw new Error(first);
  }
  const { prompt, answer, projectPath, evidence } = value;
  const task = typeof value.task === 'string' && value.task.trim() ? value.task.trim().slice(0, 4000) : prompt;
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
  const filePath = verifiedExperiencesPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // One change at a time with the edits and deletions of the learning panel (src/electron/learning-cases.cjs).
  return learningCases.withCasesLock(filePath, async () => {
    let existing = '';
    try { existing = await fs.readFile(filePath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing.split(/\r?\n/).some((line) => { try { return JSON.parse(line).id === id; } catch { return false; } })) return { id, saved: false };

    // The whole chat up to this answer, with the tool steps of every answer the app still remembers.
    const session = buildSessionTrajectory(Array.isArray(value.sessionTurns) ? value.sessionTurns : [{ role: 'user', content: prompt }, { role: 'assistant', content: answer }], (text) => recentTrajectories.get(trajectoryKey(text)));
    // `source: 'manual'`: written by hand in Aprenentatge local (no chat behind it); it trains like any other.
    const record = { id, at: new Date().toISOString(), projectPath: root, model: (await currentModel()).modelId, prompt, answer, evidence, task, ...(session ? { trajectory: session } : {}), verification: 'user-confirmed', ...(value.source === 'manual' ? { source: 'manual' } : {}) };
    await fs.appendFile(filePath, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(filePath, 0o600);
    return { id, saved: true };
  });
});

function verifiedExperiencesPath() { return path.join(app.getPath('userData'), 'learning', 'verified-experiences.jsonl'); }
// The saved cases as the learning panel lists and manages them; a deleted case goes to the .deleted file.
ipcMain.handle('learning:cases-list', () => learningCases.listCases(verifiedExperiencesPath()));
ipcMain.handle('learning:case-detail', (_e, id) => learningCases.readCase(verifiedExperiencesPath(), learningCases.validCaseId(id)));
ipcMain.handle('learning:case-update', (_e, id, changes) => learningCases.updateCase(verifiedExperiencesPath(), learningCases.validCaseId(id), changes));
ipcMain.handle('learning:case-exclusions', (_e, id, exclusions) => learningCases.setExclusions(verifiedExperiencesPath(), learningCases.validCaseId(id), exclusions));
ipcMain.handle('learning:case-delete', (_e, id) => learningCases.deleteCase(verifiedExperiencesPath(), path.join(app.getPath('userData'), 'learning', 'verified-experiences.deleted.jsonl'), learningCases.validCaseId(id)));

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
  // The examples a beta would be trained with (one per turn), and those that do not fit in the limit.
  const built = versions.buildTrainingExamples(prepared, trainingPreferences.maxTokens);
  return { counts: prepared.counts, splitCounts: prepared.splitCounts, trainingReady: prepared.trainingReady, examples: built.examples.length, droppedExamples: built.dropped, skippedTurns: built.skippedTurns };
});

// Dades preparades › Mostra: the prepared data, to look at in the window; nothing is written.
const examplesFor = (item) => versions.toTrainingExamples(item, trainingPreferences.maxTokens);
ipcMain.handle('learning:dataset-view', async () => datasetView(await readPreparedExperienceDataset(), examplesFor));
// Dades preparades › Descarrega: one .jsonl where the user chooses (and the usual copy in learning/candidates).
let lastDatasetExport = null;
ipcMain.handle('learning:export-dataset', async () => {
  const prepared = await readPreparedExperienceDataset();
  if (prepared.counts.included === 0) throw new Error('No hi ha casos confirmats aptes per descarregar.');
  const result = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), `dataset-${new Date().toISOString().slice(0, 10)}.jsonl`), filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }] });
  if (result.canceled || !result.filePath) return { saved: false };
  await fs.writeFile(result.filePath, datasetJsonl(prepared, examplesFor), { encoding: 'utf8', mode: 0o600 });
  await writeTrainingCandidate(prepared, path.join(app.getPath('userData'), 'learning', 'candidates'));
  lastDatasetExport = result.filePath;
  return { saved: true, path: result.filePath, examples: prepared.counts.included };
});
// Only the file just saved can be shown in the Finder.
ipcMain.handle('learning:reveal-export', () => { if (lastDatasetExport) shell.showItemInFolder(lastDatasetExport); return Boolean(lastDatasetExport); });
ipcMain.handle('learning:prepare-dataset', async () => {
  const prepared = await readPreparedExperienceDataset();
  if (prepared.counts.included === 0) throw new Error('No hi ha casos confirmats aptes per preparar.');
  const candidatesDirectory = path.join(app.getPath('userData'), 'learning', 'candidates');
  const candidate = await writeTrainingCandidate(prepared, candidatesDirectory);
  return { prepared: true, directory: candidate.directory, manifest: candidate.manifest };
});

// What trains and fuses: mlx_lm on a Mac (with the GPU lock), PEFT on Linux (src/core/assistant/cuda-lora.py,
// the same command line).
const trainingLauncher = () => path.join(__dirname, '..', 'core', 'assistant', mlxModels.engineFor() === 'mlx' ? 'mlx-locked.py' : 'cuda-lora.py');
// Training a version of our own from the verified cases (src/electron/learning-training.cjs), in the
// background: one run at a time, with progress sent to the window and cancellable.
let trainingRun = null;
const sendTraining = (event) => { if (win && !win.isDestroyed()) win.webContents.send('learning:train-progress', event); };

function runStreaming(command, args, { onLine, signal, env } = {}) {
  return new Promise((resolve) => {
    const child = processes.start(command, args, { cwd: projectModelsDirectory(), env: { AGENT_MLX_LOCK_LABEL: 'un entrenament d’Agentic Coder', ...process.env, ...env } });
    let output = '';
    let partial = '';
    const take = (chunk) => {
      const text = chunk.toString();
      output = (output + text).slice(-20000);
      const lines = (partial + text).split(/\r?\n|\r/);
      partial = lines.pop() || '';
      for (const line of lines) if (line.trim()) onLine?.(line);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const stop = () => processes.stopTree(child, 'SIGTERM');
    signal?.addEventListener('abort', stop, { once: true });
    child.on('error', (error) => { signal?.removeEventListener('abort', stop); resolve({ code: -1, output: error.message }); });
    child.on('close', (code) => { signal?.removeEventListener('abort', stop); resolve({ code: code ?? -1, output }); });
  });
}

/**
 * Runs scripts/evaluate-agent.cjs for one model in its own process, as the developer runs it from the
 * terminal. Null when the benchmark is not there (it ships with the app, but not in every build).
 */
async function runBenchmarkProcess({ modelId, adapterPath = '', out, turnLog = 'off', repeat = 1, keepIn = '', tasks = [], signal, onLine }) {
  const script = path.join(__dirname, '..', '..', 'scripts', 'evaluate-agent.cjs');
  if (!fsSync.existsSync(script)) return null;
  const nodeExecutable = findNodeExecutable();
  return runStreaming(nodeExecutable, [script, '--model', modelId, '--repeat', String(repeat), '--out', out, ...(keepIn ? ['--keep'] : []), ...(tasks.length ? ['--task', tasks.join(',')] : [])], {
    signal, onLine,
    // The project's npm, npx and Vite run on that same Node.
    env: { PATH: [path.dirname(nodeExecutable), process.env.PATH || ''].join(path.delimiter), ...(keepIn ? { AGENT_BENCHMARK_WORKDIR: keepIn } : {}), AGENT_MLX_LOCK_LABEL: adapterPath ? 'el benchmark d’un entrenament' : 'una avaluació d’Agentic Coder', AGENT_MODELS_DIR: projectModelsDirectory(), AGENT_MLX_PYTHON: mlxPythonPath(), AGENT_PYTHON_ENGINE: agentPreferences.pythonEngine ? '1' : '', AGENT_MLX_ADAPTER_PATH: adapterPath || '', AGENT_TURN_LOG: turnLog, ...(llmTrace.open ? { AGENT_LLM_TRACE: '1', AGENT_LLM_TRACE_SOURCE: adapterPath ? 'benchmark de beta' : 'avaluació', AGENT_LLM_CALLS_LOG: llmCallsLog() } : {}), ...(nodeExecutable === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
  });
}

// The evaluation panel: the same benchmark, run from the window with the selected model. Each run is
// kept in the data folder (benchmarks/<date>-<model>.json) with what the model did at every turn.
let benchmarkRun = null;
const benchmarksDirectory = () => path.join(app.getPath('userData'), 'benchmarks');
const sendBenchmark = (event) => { if (win && !win.isDestroyed()) win.webContents.send('benchmark:progress', event); };

// The benchmark's tasks, for choosing which ones to run (scripts/agent-benchmark/).
function benchmarkTasks() {
  try {
    const { tasks } = require(path.join(__dirname, '..', '..', 'scripts', 'agent-benchmark', 'run.cjs'));
    return tasks.map((task) => ({ id: task.id, description: task.description, prompt: task.prompt, kind: /^app-/.test(task.id) ? 'app' : task.reference ? 'reference' : 'open' }));
  } catch { return []; }
}
ipcMain.handle('benchmark:tasks', async () => benchmarkTasks());
ipcMain.handle('benchmark:status', async () => ({ running: Boolean(benchmarkRun), ...(benchmarkRun ? { model: benchmarkRun.label, current: benchmarkRun.current || null } : {}) }));
ipcMain.handle('benchmark:cancel', async () => { benchmarkRun?.controller.abort(); return { cancelled: Boolean(benchmarkRun) }; });
ipcMain.handle('benchmark:start', async (_e, request) => {
  if (benchmarkRun) throw new Error('Ja hi ha una avaluació en marxa.');
  if (trainingRun) throw new Error('Hi ha un entrenament en marxa; avalua quan acabi.');
  if (activeModelRequestId !== null) throw new Error('Espera que acabi la resposta abans d’avaluar.');
  const model = await currentModel();
  if (!model || !await mlxModels.modelDirectory(model, projectModelsDirectory())) throw new Error('El model triat no és disponible en aquest Mac.');
  const repeat = request?.repeat === 2 ? 2 : 1;
  const known = new Set(benchmarkTasks().map((task) => task.id));
  const tasks = Array.isArray(request?.tasks) ? request.tasks.filter((id) => typeof id === 'string' && known.has(id)) : [];
  if (Array.isArray(request?.tasks) && tasks.length === 0) throw new Error('Tria almenys una tasca.');
  await fs.mkdir(benchmarksDirectory(), { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${model.id}`;
  const out = path.join(benchmarksDirectory(), `${id}.json`);
  // The chat model would take the memory the benchmark's own model process needs.
  if (modelWorker) { const child = modelWorker; modelWorker = null; child.kill('SIGTERM'); }
  const controller = new AbortController();
  // A training or an evaluation needs the memory: the resident Whisper goes first.
  residentWhisper.release();
  benchmarkRun = { controller, label: model.label, modelId: model.id, id };
  (async () => {
    let result = null;
    try {
      result = await runBenchmarkProcess({
        modelId: model.id, out, repeat, tasks, signal: controller.signal, turnLog: path.join(benchmarksDirectory(), `${id}.turns.jsonl`),
        // What the model built is kept, to be opened from the panel as a project.
        keepIn: path.join(benchmarksDirectory(), `${id}-projectes`),
        onLine: (line) => {
          const started = /^TASCA (\d+)\/(\d+) (\S+) #(\d+)/.exec(line);
          if (started) {
            benchmarkRun.current = { index: Number(started[1]), total: Number(started[2]), task: started[3], run: Number(started[4]), since: Date.now() };
            sendBenchmark({ step: 'task', message: `Tasca ${started[1]} de ${started[2]}: ${started[3]} #${started[4]}`, current: benchmarkRun.current });
          } else if (/^(PASSA|FALLA|Model:)/.test(line) || /carregat amb MLX/.test(line)) sendBenchmark({ step: 'progress', message: line.slice(0, 300) });
        },
      });
    } finally {
      benchmarkRun = null;
      const done = fsSync.existsSync(out);
      sendBenchmark(done
        ? { step: 'finished', id, message: `Avaluació acabada: ${model.label}.` }
        : { step: 'failed', message: controller.signal.aborted ? 'Avaluació cancel·lada.' : result ? `L’avaluació no ha donat resultat (codi ${result.code}).` : 'El benchmark no és en aquesta instal·lació.' });
    }
  })();
  return { started: true, id };
});

async function readBenchmarkReports() {
  const reports = [];
  // A run's finished report; not the partial one an unfinished run keeps (<id>.partial.json).
  for (const name of (await fs.readdir(benchmarksDirectory()).catch(() => [])).filter((item) => item.endsWith('.json') && !item.endsWith('.partial.json')).sort()) {
    try { reports.push({ id: name.replace(/\.json$/, ''), ...JSON.parse(await fs.readFile(path.join(benchmarksDirectory(), name), 'utf8')) }); } catch { /* an unreadable report is skipped */ }
  }
  return reports;
}

ipcMain.handle('benchmark:list', async () => {
  const reports = await readBenchmarkReports();
  const labels = Object.fromEntries((await allModels()).map((model) => [model.modelId, model.label]));
  const models = summarizeReports(reports, { labels });
  // Runs cut before their end: a turn log without a report, and not the one running now.
  const names = await fs.readdir(benchmarksDirectory()).catch(() => []);
  const incomplete = [];
  for (const name of names.filter((item) => item.endsWith('.turns.jsonl'))) {
    const id = name.replace(/\.turns\.jsonl$/, '');
    if (names.includes(`${id}.json`) || (benchmarkRun && benchmarkRun.id === id)) continue;
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(.+)$/.exec(id);
    const known = match && (await allModels()).find((model) => model.id === match[6]);
    // The tasks it finished, if it saved them (scripts/evaluate-agent.cjs, <id>.partial.json).
    let partial = null;
    try { partial = JSON.parse(await fs.readFile(path.join(benchmarksDirectory(), `${id}.partial.json`), 'utf8')); } catch {}
    if (known) incomplete.push({ id, at: `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`, model: known.modelId, ...(partial && Array.isArray(partial.results) ? { done: partial.results.length, total: partial.total || null, passed: partial.results.filter((result) => result.pass).length } : {}) });
  }
  return {
    comparison: comparisonByModel(reports, { labels, incomplete }),
    runs: reports.map((report) => ({ id: report.id, at: report.at, model: labels[report.model] || report.model, adapter: report.adapter || null, runtime: report.runtime || null, summary: report.summary })).reverse(),
    models,
    chart: models.length ? renderBenchmarkSvg(models) : '',
  };
});

ipcMain.handle('benchmark:report', async (_e, id) => {
  if (typeof id !== 'string' || !/^[\w.-]+$/.test(id)) throw new Error('Aquesta avaluació no és vàlida.');
  const report = JSON.parse(await fs.readFile(path.join(benchmarksDirectory(), `${id}.json`), 'utf8'));
  return { id, at: report.at, model: report.model, summary: report.summary, results: report.results.map(({ task, run, pass, detail, seconds, toolCalls, toolsByName, filesChanged, answer, transcript, error, folder }) => ({ task, run, pass, detail, seconds, toolCalls, toolsByName, filesChanged, answer, transcript: transcript || [], error, hasProject: typeof folder === 'string' && fsSync.existsSync(folder) })) };
});

// Every project a model built in the evaluations run from the app that is still on disk, newest first.
ipcMain.handle('benchmark:projects', async () => {
  const labels = Object.fromEntries((await allModels()).map((model) => [model.modelId, model.label]));
  const projects = [];
  for (const report of await readBenchmarkReports()) {
    (report.results || []).forEach((result, index) => {
      if (typeof result.folder === 'string' && fsSync.existsSync(result.folder)) {
        projects.push({ id: report.id, index, at: report.at, model: labels[report.model] || report.model, task: result.task, run: result.run, pass: result.pass === true, detail: String(result.detail || '').slice(0, 200) });
      }
    });
  }
  return projects.reverse();
});

// Opens, as the current project, the folder where the model worked on one task of an evaluation.
ipcMain.handle('benchmark:open-project', async (_e, id, index) => {
  if (typeof id !== 'string' || !/^[\w.-]+$/.test(id) || !Number.isInteger(index)) throw new Error('Aquesta tasca no és vàlida.');
  const report = JSON.parse(await fs.readFile(path.join(benchmarksDirectory(), `${id}.json`), 'utf8'));
  const folder = report.results?.[index]?.folder;
  if (typeof folder !== 'string') throw new Error('Aquesta avaluació no va guardar el projecte.');
  const real = await fs.realpath(folder).catch(() => null);
  const base = await fs.realpath(benchmarksDirectory());
  if (!real || !real.startsWith(base + path.sep)) throw new Error('El projecte d’aquesta tasca ja no hi és.');
  selectedProject = real;
  await saveSettings();
  return { path: selectedProject, files: await listFiles(selectedProject) };
});

ipcMain.handle('learning:train-status', async () => ({ running: Boolean(trainingRun), ...(trainingRun ? { name: trainingRun.name, base: trainingRun.base } : {}) }));
ipcMain.handle('learning:train-cancel', async () => { trainingRun?.controller.abort(); return { cancelled: Boolean(trainingRun) }; });
// Learning in versions, beta → stable (src/electron/learning-versions.cjs). Only from the panel's buttons.
/** The base a version is trained from: the chosen model, or the base of a chosen beta; never a trained one. */
async function trainingBase() {
  const model = await currentModel();
  const base = model.beta ? (await allModels()).find((item) => item.id === model.baseId) : model;
  // A Mac trains on its built-in models; Linux on the ones added (not on a stable version made here).
  if (!base || (base.own && (mlxModels.engineFor() === 'mlx' || base.stable))) throw new Error('Tria un model base (no un d’entrenat) al selector per entrenar-ne versions.');
  const directory = await mlxModels.modelDirectory(base, projectModelsDirectory());
  if (!directory) throw new Error('El model base no és disponible en aquest Mac.');
  return { id: base.id, label: base.label, modelId: base.modelId, directory };
}
async function benchmarkSummary(base, adapterPath, signal, step) {
  const out = path.join(app.getPath('temp'), `agentic-benchmark-${Date.now()}.json`);
  const result = await runBenchmarkProcess({ modelId: base.id, adapterPath, out, signal, onLine: (line) => { if (/^(PASSA|FALLA)/.test(line)) sendTraining({ step, message: line.slice(0, 300) }); } });
  if (!result) return null;
  try { const report = JSON.parse(await fs.readFile(out, 'utf8')); await fs.rm(out, { force: true }); return { passed: report.summary.passed, runs: report.summary.runs }; }
  catch { return null; }
}
async function startVersionRun(kind) {
  if (trainingRun) throw new Error('Ja hi ha un entrenament en marxa.');
  if (benchmarkRun) throw new Error('Hi ha una avaluació en marxa; entrena quan acabi.');
  if (activeModelRequestId !== null) throw new Error('Espera que acabi la resposta abans d’entrenar.');
  const base = await trainingBase();
  const prepared = await readPreparedExperienceDataset();
  const needed = kind === 'beta' ? versions.BETA_MIN_CASES : versions.STABLE_MIN_CASES;
  if (prepared.counts.included < needed) throw new Error(`Calen ${needed} casos verificats vàlids; n’hi ha ${prepared.counts.included}.`);
  // Only one model on the GPU: the chat's model is unloaded first, and the training takes the GPU lock.
  await stopModelWorker();
  const controller = new AbortController();
  // A training or an evaluation needs the memory: the resident Whisper goes first.
  residentWhisper.release();
  trainingRun = { controller, name: kind, base: base.label, baseId: base.id };
  (async () => {
    try {
      const adapter = await versions.trainAdapter({ kind, base, prepared, preferences: trainingPreferences, modelsRoot: projectModelsDirectory(), python: mlxPythonPath(), launcher: trainingLauncher(), run: runStreaming, onProgress: sendTraining, signal: controller.signal });
      if (kind === 'beta') {
        sendTraining({ step: 'finished', published: true, message: `Beta ${adapter.number} a punt: ${base.label} beta · ${adapter.cases} ${adapter.cases === 1 ? 'cas' : 'casos'}${adapter.truncated ? ` (${adapter.truncated} retallats)` : ''}. Tria-la al selector per provar-la.` });
        return;
      }
      sendTraining({ step: 'benchmark-base', message: `Benchmark del model base (${base.label})…` });
      const baseResult = await benchmarkSummary(base, '', controller.signal, 'benchmark-base');
      sendTraining({ step: 'benchmark-adapter', message: 'Benchmark de la candidata a estable…' });
      const candidateResult = await benchmarkSummary(base, adapter.adapterPath, controller.signal, 'benchmark-adapter');
      if (controller.signal.aborted) throw new Error('Entrenament aturat.');
      if (!baseResult || !candidateResult) throw new Error('El benchmark no ha donat resultat; la candidata queda sense comparativa.');
      await versions.recordComparison(adapter, { base: baseResult, candidate: candidateResult });
      sendTraining({ step: 'finished', published: false, message: `Comparativa: base ${baseResult.passed}/${baseResult.runs}, candidata ${candidateResult.passed}/${candidateResult.runs}. Decideix tu si la promociones.` });
    } catch (error) {
      sendTraining({ step: 'failed', message: error instanceof Error ? error.message : String(error) });
    } finally { trainingRun = null; }
  })();
  return { started: true };
}
ipcMain.handle('learning:versions', async () => {
  const prepared = await readPreparedExperienceDataset();
  let base = null;
  try { base = await trainingBase(); } catch { /* the panel says so */ }
  const betas = base ? await versions.listBetas(projectModelsDirectory(), base.id) : [];
  const candidate = base ? await versions.latestCandidate(projectModelsDirectory(), base.id) : null;
  const summary = (item) => item && { folder: item.folder, number: item.number, cases: item.cases, createdAt: item.createdAt, durationSeconds: item.durationSeconds, finalLoss: item.finalLoss, truncated: item.truncated, dropped: item.dropped, comparison: item.comparison || null, promoted: item.promoted || null };
  return {
    cases: prepared.counts.included,
    base: base && { id: base.id, label: base.label },
    betas: betas.map(summary),
    candidate: summary(candidate),
    buttons: versions.learningButtons({ cases: prepared.counts.included, running: Boolean(trainingRun), otherWork: activeModelRequestId !== null || Boolean(benchmarkRun), candidate }),
    running: trainingRun ? { kind: trainingRun.name } : null,
    fewCases: versions.FEW_CASES,
  };
});
ipcMain.handle('learning:train-beta', () => startVersionRun('beta'));
ipcMain.handle('learning:prepare-stable', () => startVersionRun('candidata'));
ipcMain.handle('learning:promote-stable', async (_e, name) => {
  if (trainingRun) throw new Error('Ja hi ha un entrenament en marxa.');
  if (activeModelRequestId !== null || benchmarkRun) throw new Error('Espera que acabi la resposta o l’avaluació.');
  const base = await trainingBase();
  const candidate = await versions.latestCandidate(projectModelsDirectory(), base.id);
  await stopModelWorker();
  const meta = await versions.promoteStable({ candidate, name, base, modelsRoot: projectModelsDirectory(), python: mlxPythonPath(), launcher: trainingLauncher(), run: runStreaming });
  return { label: meta.label, id: meta.id, models: await getAvailableModels() };
});
ipcMain.handle('learning:delete-beta', async (_e, folder) => {
  const base = await trainingBase();
  if ((await currentModel()).adapterPath?.endsWith(path.sep + folder)) throw new Error('Aquesta beta és la del xat; tria un altre model abans d’esborrar-la.');
  return versions.deleteBeta(projectModelsDirectory(), base.id, folder);
});
ipcMain.handle('preferences:training', async () => ({ values: trainingPreferences, defaults: versions.defaultTrainingPreferences(), limits: versions.TRAINING_LIMITS }));
ipcMain.handle('preferences:set-training', async (_e, change) => {
  trainingPreferences = versions.normalizeTrainingPreferences({ ...trainingPreferences, ...(change && typeof change === 'object' ? change : {}) }, trainingPreferences);
  await saveSettings();
  return trainingPreferences;
});

ipcMain.handle('agent:ask', async (_e, request) => {
  if (!selectedProject) throw new Error('Obre primer un projecte.');
  // Training uses the memory the chat model would need; both at once run out of GPU memory.
  if (trainingRun) throw new Error('Hi ha un entrenament en marxa. Espera que acabi o cancel·la’l al panell d’aprenentatge.');
  if (benchmarkRun) throw new Error('Hi ha una avaluació en marxa. Espera que acabi o cancel·la-la al panell d’avaluació.');
  const payload = request && typeof request === 'object' ? request : { prompt: request };
  const images = validateChatImages(payload.images);
  if (images.length) {
    const model = await currentModel();
    if (!await mlxModels.hasVision(await mlxModels.modelDirectory(model, projectModelsDirectory()))) throw new Error(`${model.label} no pot veure imatges. Tria un model amb visió o treu les imatges.`);
  }
  if (!payload.turn) return askModel(String(payload.prompt || ''), selectedProject, payload.history, images);
  // A turn of a conversation: kept here while it runs, and written into the conversation here when it
  // ends, so a reloaded or reopened window neither loses it nor sends it again.
  if (activeModelRequestId !== null) throw new Error('Ja hi ha una petició al model local en marxa.');
  const turn = activeTurns.start(payload.turn);
  if (!turn) throw new Error('La petició del xat no és vàlida.');
  let outcome;
  try { outcome = { answer: await askModel(String(payload.prompt || ''), selectedProject, payload.history, images) }; }
  catch (error) { outcome = { error: error?.message || String(error) }; }
  return endChatTurn(turn.id, outcome);
});
ipcMain.handle('agent:active-turn', () => activeTurns.current());

/** Writes the end of the turn into its conversation and tells the window (whichever it is now). */
function endChatTurn(id, outcome) {
  const ended = activeTurns.finish(id, outcome);
  if (!ended) return { turnId: id, session: null };
  let session = null;
  try {
    const store = getChatStore();
    // A conversation deleted while it was answering stays in the trash; it is not brought back.
    const deleted = store.listDeleted().some((item) => item.id === ended.turn.sessionId);
    if (!deleted) { session = withTurn(store.get(ended.turn.sessionId), ended.turn, ended.messages); store.saveMany([session]); }
  } catch (error) { console.error('[chat] No s’ha pogut desar el final del torn:', error); }
  const result = { turnId: id, sessionId: ended.turn.sessionId, session };
  if (win && !win.isDestroyed()) win.webContents.send('agent:turn-finished', result);
  return result;
}

ipcMain.handle('permissions:get', async () => permissionMode);

/** Unloads the chat's model (its worker and the MLX process under it); the next message loads it again. */
async function stopModelWorker() {
  if (!modelWorker) return;
  const child = modelWorker;
  modelWorker = null;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
}

// Dictation (src/electron/dictation.cjs): one transcription at a time, after the chat has finished what it
// generates and its model is unloaded, so only one model is ever on the GPU.
function runDictation({ file, model, language }) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, '..', 'core', 'assistant', 'mlx_dictation.py');
    const child = spawn(mlxPythonPath(), ['-u', script, dictation.dictationModelDirectory(model, projectModelsDirectory()), file, language], { env: { ...process.env, AGENT_MLX_LOCK_LABEL: 'el dictat d’Agentic Coder', AGENT_DICTATION_ENGINE: mlxModels.engineFor() }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-200_000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', () => {
      clearTimeout(timer);
      try { resolve(dictation.parseDictationOutput(stdout)); }
      catch (error) { reject(stdout.trim() ? error : new Error(`El dictat no ha acabat bé. ${stderr.trim().split('\n').pop() || ''}`.trim())); }
    });
  });
}
const enqueueDictation = dictation.createDictationQueue({
  chatIdle: () => activeModelRequestId === null,
  freeGpu: stopModelWorker,
  run: runDictation,
  onWaiting: () => { if (win && !win.isDestroyed()) win.webContents.send('agent:status', { type: 'status', message: 'El dictat espera que el xat acabi de respondre…' }); },
});
ipcMain.handle('dictation:info', async () => ({
  preferences: dictationPreferences,
  languages: dictation.DICTATION_LANGUAGES,
  models: await Promise.all(dictation.dictationModels().map(async (model) => ({ id: model.id, label: model.label, repo: model.repo, bytes: model.bytes, installed: await dictation.dictationModelInstalled(model, projectModelsDirectory()) }))),
}));
ipcMain.handle('preferences:set-dictation', async (_event, change) => {
  dictationPreferences = dictation.normalizeDictationPreferences({ ...dictationPreferences, ...(change && typeof change === 'object' ? change : {}) }, dictationPreferences);
  await saveSettings();
  return dictationPreferences;
});
// macOS asks the user once for the microphone; the answer is the system's.
ipcMain.handle('dictation:microphone', async () => process.platform === 'darwin' ? systemPreferences.askForMediaAccess('microphone') : true);
// Live dictation: a warm Whisper while the user speaks (partial text every few seconds), then the final
// pass over the whole recording. Only while the chat is not answering: one model on the GPU at a time.
// The warm Whisper (live dictation) stays resident between dictations (the next one starts at once) and is
// closed after ten minutes without dictation, before a training or an evaluation and when the app quits.
// By default it holds the GPU lock like any model (one at a time: the chat's model is unloaded while it is
// there, and it is closed before the chat answers). With Preferències › Agent › Dictat › «conviu» on, it
// takes no lock and lives beside the chat's model (with little free memory, it goes back to the default).
let liveModel = null;
const residentWhisper = dictation.createResidentTranscriber({
  start: () => {
    const script = path.join(__dirname, '..', 'core', 'assistant', 'mlx_dictation.py');
    const child = spawn(mlxPythonPath(), ['-u', script, '--serve', dictation.dictationModelDirectory(liveModel, projectModelsDirectory()), dictationPreferences.language], { env: { ...process.env, AGENT_MLX_LOCK_LABEL: 'el dictat d’Agentic Coder', AGENT_DICTATION_ENGINE: mlxModels.engineFor(), ...(liveModel.shared ? { AGENT_DICTATION_SHARED: '1' } : {}) }, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdout.setEncoding('utf8');
    return dictation.createLiveTranscriber(child);
  },
});
let liveDictation = null;
async function dictationModelReady() {
  const model = dictation.dictationModels().find((item) => item.id === dictationPreferences.model);
  if (!await dictation.dictationModelInstalled(model, projectModelsDirectory())) throw new Error(`Falta el model de dictat ${model.label} (${model.repo}, ${Math.round(model.bytes / 1e6)} MB) a models/whisper/${model.folder}.`);
  return model;
}
ipcMain.handle('dictation:live-start', async () => {
  if (trainingRun || benchmarkRun) return { live: false, reason: 'Hi ha un entrenament o una avaluació en marxa.' };
  const model = await dictationModelReady();
  const shared = dictationPreferences.coexist && dictation.roomForWhisper(require('node:os').freemem(), require('node:os').totalmem());
  // One model at a time (the default): not while the chat answers, and the chat's model is unloaded.
  if (!shared && activeModelRequestId !== null) return { live: false, reason: 'El xat està responent: el text sortirà quan acabis de parlar.' };
  // Another model, language or way than the resident one: that one goes and this one comes.
  if (liveModel && (liveModel.id !== model.id || liveModel.language !== dictationPreferences.language || liveModel.shared !== shared)) residentWhisper.release();
  liveModel = { ...model, language: dictationPreferences.language, shared };
  if (!shared && !residentWhisper.resident) await stopModelWorker();
  try { liveDictation = await residentWhisper.acquire(); } catch (error) { liveDictation = null; return { live: false, reason: error.message }; }
  return { live: true };
});
async function liveTranscribe(audio) {
  if (!liveDictation) throw new Error('El dictat en directe no està en marxa.');
  const { buffer } = dictation.validateDictationAudio(audio);
  const file = await dictation.writeDictationAudio(path.join(app.getPath('userData'), 'dictation'), buffer);
  try { return await liveDictation.transcribe(file); }
  finally { await fs.rm(file, { force: true }).catch(() => {}); }
}
ipcMain.handle('dictation:live-partial', async (_event, audio) => ({ text: await liveTranscribe(audio) }));
// The final pass; the warm Whisper then stays resident for the next dictation (closed after ten idle minutes).
ipcMain.handle('dictation:live-final', async (_event, audio) => {
  try { return { text: await liveTranscribe(audio) }; }
  finally { liveDictation = null; residentWhisper.idle(); }
});
ipcMain.handle('dictation:live-stop', async () => { liveDictation = null; residentWhisper.idle(); return true; });
ipcMain.handle('dictation:transcribe', async (_event, audio) => {
  if (trainingRun || benchmarkRun) throw new Error('Hi ha un entrenament o una avaluació en marxa: el dictat pot esperar que acabi.');
  const { buffer } = dictation.validateDictationAudio(audio);
  const model = dictation.dictationModels().find((item) => item.id === dictationPreferences.model);
  if (!await dictation.dictationModelInstalled(model, projectModelsDirectory())) throw new Error(`Falta el model de dictat ${model.label} (${model.repo}, ${Math.round(model.bytes / 1e6)} MB) a models/whisper/${model.folder}.`);
  const file = await dictation.writeDictationAudio(path.join(app.getPath('userData'), 'dictation'), buffer);
  try { return { text: await enqueueDictation({ file, model, language: dictationPreferences.language }) }; }
  finally { await fs.rm(file, { force: true }).catch(() => {}); }
});
// Preferències › Model and Agent: the limits and switches of the agent, kept in settings.json.
ipcMain.handle('preferences:agent', async () => ({ values: agentPreferences, defaults: defaultAgentPreferences(), limits: AGENT_LIMITS }));
ipcMain.handle('preferences:set-agent', async (_event, change) => {
  const before = agentPreferences.pythonEngine;
  agentPreferences = normalizeAgentPreferences(change, agentPreferences);
  await saveSettings();
  // Another engine: the chat's model is unloaded (as when choosing another model) and the next message loads it with that one.
  if (agentPreferences.pythonEngine !== before && activeModelRequestId === null && !trainingRun && !benchmarkRun) await stopModelWorker();
  return agentPreferences;
});
ipcMain.handle('permissions:set', async (_event, mode) => {
  permissionMode = mode === 'auto' ? 'auto' : 'ask';
  await saveSettings();
  return permissionMode;
});
// The selector offers only the models switched on in Gestiona els models (and always the chosen one).
const selectorModels = async () => (await getAvailableModels()).filter((model) => model.shown);
ipcMain.handle('models:list', async () => ({ selectedModel, models: await selectorModels() }));
ipcMain.handle('models:select', async (_e, modelId) => {
  if (activeModelRequestId !== null) throw new Error('Espera que acabi la resposta abans de canviar de model.');
  const model = (await allModels()).find((candidate) => candidate.id === modelId);
  if (!model) throw new Error('Aquest model no és vàlid.');
  const available = (await getAvailableModels()).find((candidate) => candidate.id === model.id);
  if (!available?.available) throw new Error(available?.reason || 'Aquest model encara no està disponible en aquest Mac.');
  if (trainingRun) throw new Error('Hi ha un entrenament en marxa; canvia de model quan acabi.');
  if (benchmarkRun) throw new Error('Hi ha una avaluació en marxa; canvia de model quan acabi.');
  if (selectedModel !== model.id) await stopModelWorker();
  selectedModel = model.id;
  await saveSettings();
  return { selectedModel, models: await selectorModels() };
});

// Aprenentatge local › Gestiona els models (src/electron/model-manager.cjs): every model on this Mac with
// its size, its switch for the selector, adding one from Hugging Face and removing one to the Trash.
// Nothing here loads a model.
async function managedModels() {
  const root = projectModelsDirectory();
  const loadedId = modelWorker?.connected ? modelWorkerModelId : null;
  const rows = [];
  for (const model of await allModels()) {
    const directory = model.beta ? model.adapterPath : await mlxModels.modelDirectory(model, root);
    // What goes to the Trash: a beta's adapter, a cached model's whole cache entry, or the model's folder.
    const folder = model.beta ? model.adapterPath : model.hfCache ? path.join(root, '.hf', 'hub', `models--${model.hfCache.replace('/', '--')}`) : directory;
    let meta = null;
    if (model.own) { try { meta = JSON.parse(await fs.readFile(path.join(root, model.dir || 'mlx', model.folder, 'agentic-model.json'), 'utf8')); } catch {} }
    const vision = !model.beta && await mlxModels.hasVision(directory);
    rows.push({
      id: model.id, label: model.label, repo: model.modelId, installed: Boolean(directory), folder,
      kind: model.beta ? 'beta' : meta?.stable ? 'estable' : vision ? 'visió' : 'text',
      source: model.beta || meta?.stable ? 'entrenat aquí' : meta?.source === 'huggingface' ? 'Hugging Face' : model.own ? 'local' : 'app',
      baseId: model.beta ? model.baseId : meta?.base?.id || null, number: model.number ?? meta?.version ?? null, cases: model.cases ?? meta?.cases ?? null, createdAt: model.createdAt || meta?.createdAt || null,
      // A built-in model that is not here can be downloaded again from its repository (not the Hugging Face cache one).
      downloadable: !directory && !model.beta && !model.own && Boolean(model.folder),
      shown: modelManager.shownInSelector(model, modelVisibility, selectedModel), selected: model.id === selectedModel,
      isDefault: model.id === mlxModels.DEFAULT_MODEL_ID, loaded: model.id === loadedId,
      bytes: directory ? await modelManager.folderBytes(folder) : 0,
    });
  }
  for (const model of dictation.dictationModels()) {
    const directory = dictation.dictationModelDirectory(model, root);
    const installed = await dictation.dictationModelInstalled(model, root);
    rows.push({ id: model.id, label: model.label, repo: model.repo, installed, folder: directory, kind: 'dictat', source: 'app', downloadable: !installed, shown: null, selected: dictationPreferences.model === model.id, isDefault: model.id === dictation.DEFAULT_DICTATION_MODEL, loaded: residentWhisper.resident && dictationPreferences.model === model.id, bytes: installed ? await modelManager.folderBytes(directory) : 0 });
  }
  const state = {
    selectedId: selectedModel, loadedId, defaultId: mlxModels.DEFAULT_MODEL_ID,
    betaBases: new Set(rows.filter((row) => row.kind === 'beta').map((row) => row.baseId)),
    busyIds: new Set([benchmarkRun?.modelId, trainingRun?.baseId].filter(Boolean)),
    dictationLoadedId: residentWhisper.resident ? dictationPreferences.model : null,
  };
  return rows.map((row) => ({ ...row, removeBlock: modelManager.removalBlock(row, state), shownBlock: row.kind === 'dictat' ? null : row.selected ? 'És el model triat al xat: no es pot amagar.' : !row.installed ? 'No és en aquest Mac.' : null }));
}
// The renderer gets everything but the folders.
const managedModelsView = async () => ({ models: (await managedModels()).map(({ folder, ...row }) => row), download: modelDownload ? { id: modelDownload.id, label: modelDownload.label, done: modelDownload.done, total: modelDownload.total } : null });
ipcMain.handle('models:manage', async () => managedModelsView());

ipcMain.handle('models:set-shown', async (_event, id, shown) => {
  const chat = (await getAvailableModels()).filter((model) => model.available);
  const models = (await allModels()).filter((model) => chat.some((item) => item.id === model.id));
  modelVisibility = modelManager.setShown(modelVisibility, String(id), Boolean(shown), { selectedId: selectedModel, models });
  await saveSettings();
  return managedModelsView();
});

ipcMain.handle('models:remove', async (_event, id) => {
  const row = (await managedModels()).find((item) => item.id === id);
  if (!row) throw new Error('Aquest model ja no hi és.');
  if (row.removeBlock) throw new Error(row.removeBlock);
  // To the Trash, never deleted: it can be put back from the Finder.
  await shell.trashItem(row.folder);
  if (id in modelVisibility) { const { [id]: _removed, ...rest } = modelVisibility; modelVisibility = rest; await saveSettings(); }
  return managedModelsView();
});

// The listing of a repository on Hugging Face (files and sizes); null when there is no such public model.
// On Linux, the memory of the NVIDIA GPUs bounds the models that can be added (model-manager.cjs).
let gpuMemoryBytes;
function modelSizeLimit() {
  if (mlxModels.engineFor() === 'mlx') return modelManager.maxModelBytes('darwin');
  if (gpuMemoryBytes === undefined) {
    try { gpuMemoryBytes = modelManager.parseNvidiaMemory(require('node:child_process').execFileSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000 })); }
    catch { gpuMemoryBytes = null; }
  }
  return modelManager.maxModelBytes(process.platform, gpuMemoryBytes);
}
async function huggingFaceListing(repo) {
  const [org, name] = repo.split('/');
  const response = await fetch(`https://huggingface.co/api/models/${encodeURIComponent(org)}/${encodeURIComponent(name)}?blobs=true`, { signal: AbortSignal.timeout(20_000) });
  if (response.status === 401 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Hugging Face ha respost ${response.status}.`);
  return response.json();
}

ipcMain.handle('models:check', async (_event, repo) => {
  const clean = String(repo || '').trim();
  if (!modelManager.validRepoId(clean)) throw new Error('Escriu el nom del model com a Hugging Face: organització/nom.');
  const result = modelManager.checkRepository(await huggingFaceListing(clean), clean, { maxBytes: modelSizeLimit() });
  return { repo: clean, ...result, size: result.bytes ? modelManager.formatBytes(result.bytes) : null };
});

let modelDownload = null;
const sendModelDownload = (event) => { if (win && !win.isDestroyed()) win.webContents.send('models:download-progress', event); };
// Starts a download (only from a click in Gestiona els models): a model from Hugging Face, or a model the
// app knows that is not on this Mac. It goes to a hidden partial folder, renamed when complete.
ipcMain.handle('models:add', async (_event, request) => {
  if (modelDownload) throw new Error('Ja s’està baixant un model; espera que acabi.');
  const root = projectModelsDirectory();
  const rows = await managedModels();
  let repo, label, target, meta = null, total;
  if (request?.id) {
    const row = rows.find((item) => item.id === request.id);
    if (!row?.downloadable) throw new Error('Aquest model no es pot baixar d’aquí.');
    const info = await huggingFaceListing(row.repo);
    if (!info) throw new Error('El model ja no és a Hugging Face.');
    ({ repo, label, folder: target } = row);
    if (row.kind !== 'dictat') target = path.join(root, 'mlx', (await allModels()).find((model) => model.id === row.id).folder);
    total = modelManager.downloadBytes(info, row.kind === 'dictat' ? modelManager.DICTATION_PATTERNS : modelManager.DOWNLOAD_PATTERNS);
  } else {
    repo = String(request?.repo || '').trim();
    if (!modelManager.validRepoId(repo)) throw new Error('Escriu el nom del model com a Hugging Face: organització/nom.');
    const checked = modelManager.checkRepository(await huggingFaceListing(repo), repo, { maxBytes: modelSizeLimit() });
    if (!checked.ok) throw new Error(checked.problem);
    const added = modelManager.addedModel({ repo, label: request?.label, modelsRoot: root });
    if (rows.some((row) => row.id === added.meta.id || row.repo === repo)) throw new Error('Aquest model ja és a la llista.');
    ({ directory: target, meta } = added);
    label = meta.label;
    total = checked.bytes;
  }
  if (fsSync.existsSync(target)) throw new Error('Ja hi ha una carpeta amb aquest nom a models/.');
  // A dictation model (Whisper) may be a CTranslate2 model.bin on Linux: its own file patterns.
  const dictationDownload = Boolean(request?.id) && rows.find((item) => item.id === request.id)?.kind === 'dictat';
  const partial = path.join(path.dirname(target), `.${path.basename(target)}.partial`);
  await fs.rm(partial, { recursive: true, force: true });
  await fs.mkdir(partial, { recursive: true });
  const controller = new AbortController();
  modelDownload = { id: request?.id || meta.id, label, done: 0, total, controller };
  const timer = setInterval(async () => {
    if (!modelDownload) return;
    modelDownload.done = Math.min(await modelManager.folderBytes(partial), total);
    sendModelDownload({ step: 'progress', id: modelDownload.id, label, done: modelDownload.done, total });
  }, 1000);
  (async () => {
    let result = null;
    try {
      result = await runStreaming(mlxPythonPath(), [path.join(__dirname, '..', 'core', 'assistant', 'mlx_download.py'), repo, partial, ...(dictationDownload ? modelManager.DICTATION_PATTERNS : modelManager.DOWNLOAD_PATTERNS)], { signal: controller.signal, env: { AGENT_MLX_LOCK_LABEL: 'una baixada' } });
      if (result.code === 0 && !controller.signal.aborted) {
        await fs.rm(path.join(partial, '.cache'), { recursive: true, force: true });
        if (meta) await fs.writeFile(path.join(partial, 'agentic-model.json'), JSON.stringify({ ...meta, addedAt: new Date().toISOString() }, null, 2));
        await fs.rename(partial, target);
      }
    } catch (error) { result = { code: -1, output: error.message }; }
    finally {
      clearInterval(timer);
      const ok = result?.code === 0 && !controller.signal.aborted && fsSync.existsSync(target);
      if (!ok) await fs.rm(partial, { recursive: true, force: true }).catch(() => {});
      modelDownload = null;
      sendModelDownload(ok
        ? { step: 'finished', label, message: `${label} ja és en aquest Mac.` }
        : { step: 'failed', label, message: controller.signal.aborted ? 'Baixada cancel·lada.' : `No s’ha pogut baixar ${label}: ${(result?.output || '').trim().split('\n').pop()?.slice(0, 200) || `codi ${result?.code}`}` });
    }
  })();
  return { started: true };
});
ipcMain.handle('models:add-cancel', async () => { modelDownload?.controller.abort(); return { cancelled: Boolean(modelDownload) }; });

ipcMain.handle('agent:cancel', async () => cancelModelRequest());

ipcMain.handle('git:snapshot', async () => {
  if (!selectedProject) return { available: false, reason: 'Selecciona primer un projecte.' };
  return getGitSnapshot(selectedProject);
});

ipcMain.handle('git:history', async () => {
  if (!selectedProject) return { available: false, reason: 'Selecciona primer un projecte.', commits: [], branches: [] };
  return getGitHistory(selectedProject);
});

ipcMain.handle('git:commit-details', async (_event, hash) => {
  if (!selectedProject) throw new Error('Selecciona primer un projecte.');
  return getGitCommitDetails(selectedProject, hash);
});

ipcMain.handle('project:run-tests', async () => {
  if (!selectedProject) throw new Error('Obre primer un projecte.');
  const root = await fs.realpath(selectedProject);
  return executeProjectTests(root);
});

ipcMain.handle('terminal:run', async (_e, rawCommand) => {
  if (!selectedProject) throw new Error('Obre primer un projecte.');
  const command = String(rawCommand || '').trim();
  if (!command || command.length > 2000) throw new Error('Ordre buida o massa llarga.');
  // A dev server never ends: run here it would be cut at the two-minute limit. It is started as the
  // project's server instead, which keeps running until «stop» or until the app closes.
  const server = /^(?:npm|pnpm|yarn)\s+(?:run\s+)?(dev|start|preview)$/.exec(command);
  if (server || command === 'stop') {
    const root = await fs.realpath(selectedProject);
    const say = (text) => { if (win && !win.isDestroyed()) win.webContents.send('terminal:output', text); };
    try {
      if (command === 'stop') {
        const stopped = await dispatchAgentTool({ name: 'stop_project' }, root);
        say(stopped.alreadyStopped ? 'No hi ha cap servidor en marxa.\r\n' : 'Servidor aturat.\r\n');
        return { code: 0, output: '' };
      }
      const started = await dispatchAgentTool({ name: 'start_project', arguments: { script: server[1] } }, root);
      if (started.started) say(`\r\n[Servidor en marxa${started.url ? ` a ${started.url}` : ''}. Escriu «stop» per aturar-lo.]\r\n`);
      return { code: started.started ? 0 : (typeof started.code === 'number' ? started.code : 1), output: '' };
    } catch (error) {
      say(`${error instanceof Error ? error.message : String(error)}\r\n`);
      return { code: 1, output: '' };
    }
  }
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
