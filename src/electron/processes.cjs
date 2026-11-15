// Starting and stopping the processes the app runs (npm, npx, the model's Python, a project's dev server)
// on every platform. On macOS and Linux a process started in its own group is stopped with its whole
// group (a negative pid). Windows has no groups nor signals: `taskkill /T /F` stops the process and its
// children. And there npm and npx are .cmd files, which Node only starts through the shell: their
// arguments are quoted, and an argument the shell would read as an instruction is refused.
const { spawn } = require('node:child_process');

const SHELL_SCRIPTS = new Set(['npm', 'npx', 'vite']);
// What cmd.exe would read as something else than text: never inside an argument.
const CMD_SPECIAL = /[&|<>^%"\r\n]/;

/** An argument for cmd.exe: quoted when it has spaces; refused when the shell would read it as an instruction. */
function quoteForCmd(value) {
  const text = String(value);
  if (CMD_SPECIAL.test(text)) throw new Error(`Aquest argument no es pot passar a l’ordre a Windows: ${text.slice(0, 80)}`);
  return /\s/.test(text) || text === '' ? `"${text}"` : text;
}

/** How to start `command` with `args` on `platform`: { command, args, shell }. */
function commandFor(command, args = [], platform = process.platform) {
  if (platform === 'win32' && SHELL_SCRIPTS.has(command)) return { command: `${command}.cmd`, args: args.map(quoteForCmd), shell: true };
  return { command, args, shell: false };
}

/** Starts a process the same way on every platform (see commandFor); `options` as child_process.spawn's. */
function start(command, args, options = {}, platform = process.platform) {
  const how = commandFor(command, args, platform);
  return spawn(how.command, how.args, { ...options, shell: how.shell, detached: platform !== 'win32' && options.detached !== false });
}

/** Stops a process and everything it started: its group on macOS/Linux, its tree on Windows. */
function stopTree(child, signal = 'SIGTERM', platform = process.platform, run = spawn) {
  if (!child?.pid) return;
  try {
    if (platform === 'win32') run('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

module.exports = { commandFor, quoteForCmd, start, stopTree };
