const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');

const MAX_OUTPUT = 240_000;

function runGit(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      shell: false,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', PAGER: 'cat' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const append = (target, chunk) => {
      const text = chunk.toString('utf8');
      const remaining = Math.max(0, MAX_OUTPUT - size);
      const accepted = text.slice(0, remaining);
      if (target === 'stdout') stdout += accepted;
      else stderr += accepted;
      size += accepted.length;
      if (accepted.length < text.length) truncated = true;
    };
    const timer = setTimeout(() => {
      truncated = true;
      timedOut = true;
      child.kill('SIGTERM');
    }, 12_000);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, truncated });
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.on('error', (error) => finish({ code: -1, error: error.message }));
    child.on('close', (code, signal) => finish({ code, signal, timedOut }));
  });
}

async function getGitSnapshot(projectRoot) {
  let root;
  try { root = await fs.realpath(projectRoot); }
  catch (error) { return { available: false, reason: error.message }; }

  const top = await runGit(['rev-parse', '--show-toplevel'], root);
  if (top.code !== 0) return { available: false, reason: 'Aquesta carpeta no és un repositori Git.' };
  let repositoryRoot;
  try { repositoryRoot = await fs.realpath(top.stdout.trim()); }
  catch { return { available: false, reason: 'No s’ha pogut resoldre la carpeta del repositori Git.' }; }
  if (repositoryRoot !== root) {
    return { available: false, reason: 'Selecciona la carpeta arrel del repositori per veure’n els canvis amb seguretat.' };
  }

  const [status, unstaged, staged] = await Promise.all([
    runGit(['status', '--short', '--branch', '--untracked-files=all', '--', '.'], root),
    runGit(['diff', '--no-ext-diff', '--no-color', '--no-renames', '--', '.'], root),
    runGit(['diff', '--cached', '--no-ext-diff', '--no-color', '--no-renames', '--', '.'], root),
  ]);
  const failed = [status, unstaged, staged].find((result) => result.code !== 0);
  if (failed) return { available: false, reason: failed.stderr.trim() || 'Git no ha pogut llegir l’estat del repositori.' };
  return {
    available: true,
    branch: status.stdout.split(/\r?\n/, 1)[0] || '',
    status: status.stdout,
    unstagedDiff: unstaged.stdout,
    stagedDiff: staged.stdout,
    truncated: status.truncated || unstaged.truncated || staged.truncated,
  };
}

module.exports = { getGitSnapshot };
