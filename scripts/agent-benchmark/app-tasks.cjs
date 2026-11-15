const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runCommand } = require('./sandbox-tools.cjs');

// Whole apps from a completely empty folder, asked the way a person asks for them in the chat: no
// files, steps or library versions in the prompt. The model has to write package.json, install,
// write the code and build it by itself; these tasks get the network for installs (allowInstall).
//
// The check is objective and only looks at the folder: `npm run build` passes, the page it builds
// loads without console errors and shows something, and for a Chakra UI request, @chakra-ui/react is
// version 3 and the code uses no API that version 3 removed.

// APIs of Chakra UI v2 that v3 removed or renamed (https://chakra-ui.com/docs/get-started/migration).
const CHAKRA_V2_PATTERNS = [
  [/\bextendTheme\b/, 'extendTheme'],
  [/<ChakraProvider(?![^>]*\bvalue=)/, 'ChakraProvider sense value'],
  [/\buseColorMode\b|\bColorModeScript\b/, 'useColorMode/ColorModeScript'],
  [/\bFormControl\b|\bFormLabel\b|\bFormErrorMessage\b/, 'FormControl'],
  [/\bisDisabled\b|\bisOpen=|\bisChecked\b|\bisInvalid\b|\bisLoading\b|\bisRequired\b/, 'props is*'],
  [/\bcolorScheme=/, 'colorScheme'],
  [/\b(?:Modal|ModalOverlay|ModalContent|ModalHeader|ModalBody)\b/, 'Modal'],
  [/\buseToast\b/, 'useToast'],
  [/\bspacing=\{/, 'spacing'],
  [/\b(?:Divider|Collapse|AlertIcon|TabList|TabPanels)\b/, 'component de v2'],
];

async function sourceFiles(root, directory = root, found = []) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (['node_modules', 'dist', 'build', '.git'].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await sourceFiles(root, full, found);
    else if (/\.(?:jsx?|tsx?|mjs|cjs|html)$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** Serves the built app with `vite preview` and loads it in Electron. Null when it cannot be tried. */
async function loadBuiltPage(root) {
  const vite = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');
  const electron = process.platform === 'win32' ? require('electron') : path.join(__dirname, '..', '..', 'node_modules', '.bin', 'electron');
  if (!fsSync.existsSync(vite) || !fsSync.existsSync(electron)) return null;
  const port = 4800 + Math.floor(Math.random() * 400);
  // On Windows the project's vite is vite.cmd; stopped with its whole tree (src/electron/processes.cjs).
  const preview = process.platform === 'win32'
    ? require('../../src/electron/processes.cjs').start('vite', ['preview', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore', env: { ...process.env, PATH: `${path.join(root, 'node_modules', '.bin')};${process.env.PATH || ''}` } })
    : spawn(vite, ['preview', '--port', String(port), '--strictPort'], { cwd: root, detached: true, stdio: 'ignore' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const result = await runCommand(electron, [path.join(__dirname, 'load-page.cjs'), `http://localhost:${port}/`], __dirname, 60000);
    const line = result.output.split('\n').find((item) => item.startsWith('PAGE_RESULT '));
    return line ? JSON.parse(line.slice('PAGE_RESULT '.length)) : { errors: [`no s’ha pogut carregar: ${result.output.slice(-300)}`], textLength: 0 };
  } finally { require('../../src/electron/processes.cjs').stopTree(preview, 'SIGKILL'); }
}

function appCheck({ chakra }) {
  return async (root) => {
    const reasons = [];
    let pkg;
    try { pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); }
    catch { return { pass: false, detail: 'no hi ha cap package.json vàlid' }; }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    let v2Usage = [];
    if (chakra) {
      const range = String(deps['@chakra-ui/react'] || '');
      let installed = '';
      try { installed = JSON.parse(await fs.readFile(path.join(root, 'node_modules', '@chakra-ui', 'react', 'package.json'), 'utf8')).version; } catch {}
      if (!range) reasons.push('package.json no té @chakra-ui/react');
      else if (!/^\D*3(?:\.|$)/.test(installed || range.replace(/^[^\d]*/, ''))) reasons.push(`Chakra UI ${installed || range}, no la v3`);
      for (const file of await sourceFiles(root)) {
        const text = await fs.readFile(file, 'utf8');
        for (const [pattern, label] of CHAKRA_V2_PATTERNS) if (pattern.test(text)) v2Usage.push(`${path.relative(root, file)}: ${label}`);
      }
      if (v2Usage.length) reasons.push(`API de v2: ${v2Usage.slice(0, 4).join(', ')}`);
    }
    if (typeof pkg.scripts?.build !== 'string') return { pass: false, detail: [...reasons, 'no hi ha script build'].join('; ') };
    if (!fsSync.existsSync(path.join(root, 'node_modules'))) await runCommand('npm', ['install'], root, 600000);
    const build = await runCommand('npm', ['run', 'build'], root, 300000);
    if (build.code !== 0) reasons.push(`npm run build falla (codi ${build.code})`);
    let page = null;
    if (build.code === 0) {
      page = await loadBuiltPage(root);
      if (page && page.errors.length) reasons.push(`errors a la consola: ${page.errors.slice(0, 2).join(' | ')}`);
      if (page && !page.textLength) reasons.push('la pàgina compilada no mostra res');
    }
    return {
      pass: reasons.length === 0,
      detail: reasons.length ? reasons.join('; ') : `build passa${chakra ? ', Chakra v3 sense API de v2' : ''}${page ? `, la pàgina mostra ${page.textLength} caràcters sense errors` : ''}`,
      build: build.code, v2Usage, page,
    };
  };
}

const appTasks = [
  {
    id: 'app-chakra-ui',
    description: 'Des d’una carpeta buida: la petició de referència de cel, tal com la diu.',
    prompt: 'Munta’m una interfície amb Chakra UI',
    files: {}, protected: [], allowInstall: true, timeoutMinutes: 20,
    check: appCheck({ chakra: true }),
  },
  {
    id: 'app-chakra-todo',
    description: 'Des d’una carpeta buida: una variant oberta amb una llista de tasques.',
    prompt: 'Fes una app amb Chakra UI amb una llista de tasques on es puguin afegir i esborrar',
    files: {}, protected: [], allowInstall: true, timeoutMinutes: 20,
    check: appCheck({ chakra: true }),
  },
  {
    id: 'app-react-todo',
    description: 'Des d’una carpeta buida: una app React sense dir cap llibreria.',
    prompt: 'Fes una aplicació React amb una llista de tasques on es puguin afegir i esborrar tasques',
    files: {}, protected: [], allowInstall: true, timeoutMinutes: 20,
    check: appCheck({ chakra: false }),
  },
];

module.exports = { appTasks, appCheck, CHAKRA_V2_PATTERNS };
