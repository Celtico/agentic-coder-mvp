const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const { Git } = require('git-interface');

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

  const [status, unstaged, staged, localBranches, remotes] = await Promise.all([
    runGit(['status', '--short', '--branch', '--untracked-files=all', '--', '.'], root),
    runGit(['diff', '--no-ext-diff', '--no-color', '--no-renames', '--', '.'], root),
    runGit(['diff', '--cached', '--no-ext-diff', '--no-color', '--no-renames', '--', '.'], root),
    new Git({ dir: root }).getLocalBranchList(),
    new Git({ dir: root }).getRemotes(),
  ]);
  const failed = [status, unstaged, staged].find((result) => result.code !== 0);
  if (failed) return { available: false, reason: failed.stderr.trim() || 'Git no ha pogut llegir l’estat del repositori.' };
  return {
    available: true,
    branch: status.stdout.split(/\r?\n/, 1)[0] || '',
    localBranches,
    remotes: remotes.filter(Boolean),
    status: status.stdout,
    unstagedDiff: unstaged.stdout,
    stagedDiff: staged.stdout,
    truncated: status.truncated || unstaged.truncated || staged.truncated,
  };
}

async function getGitHistory(projectRoot) {
  let root;
  try { root = await fs.realpath(projectRoot); }
  catch (error) { return { available: false, reason: error.message, commits: [], branches: [] }; }
  const top = await runGit(['rev-parse', '--show-toplevel'], root);
  if (top.code !== 0) return { available: false, reason: 'Aquesta carpeta no és un repositori Git.', commits: [], branches: [] };
  let repositoryRoot;
  try { repositoryRoot = await fs.realpath(top.stdout.trim()); }
  catch { return { available: false, reason: 'No s’ha pogut resoldre la carpeta del repositori Git.', commits: [], branches: [] }; }
  if (repositoryRoot !== root) return { available: false, reason: 'Selecciona la carpeta arrel del repositori per veure’n l’historial.', commits: [], branches: [] };

  const [log, refs, branch] = await Promise.all([
    runGit(['log', '--all', '--decorate=short', '--date=iso-strict', '--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%ad%x00%D%x1e', '--max-count=120'], root),
    runGit(['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(HEAD)', 'refs/heads', 'refs/remotes'], root),
    runGit(['branch', '--show-current'], root),
  ]);
  const failed = [log, refs, branch].find((result) => result.code !== 0);
  if (failed) return { available: false, reason: failed.stderr.trim() || 'Git no ha pogut llegir l’historial.', commits: [], branches: [] };
  const commits = log.stdout.split('\x1e').map((record) => {
    const fields = record.trim().split('\0');
    if (fields.length < 7 || !/^[0-9a-f]{40,64}$/i.test(fields[0])) return null;
    return { hash: fields[0], shortHash: fields[1], subject: fields[2], author: fields[3], email: fields[4], date: fields[5], decorations: fields[6].trim() };
  }).filter(Boolean);
  const branches = refs.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, hash, head] = line.split('\0');
    return { name, hash, current: head === '*' || name === branch.stdout.trim(), remote: name.startsWith('origin/') };
  }).filter((ref) => ref.name && ref.hash);
  return { available: true, branch: branch.stdout.trim(), branches, commits, truncated: log.truncated };
}

async function getGitCommitDetails(projectRoot, hash) {
  if (typeof hash !== 'string' || !/^[0-9a-f]{40,64}$/i.test(hash)) throw new Error('Identificador de commit no vàlid.');
  let root;
  try { root = await fs.realpath(projectRoot); }
  catch (error) { throw new Error(error.message); }
  const top = await runGit(['rev-parse', '--show-toplevel'], root);
  if (top.code !== 0) throw new Error('Aquesta carpeta no és un repositori Git.');
  const repositoryRoot = await fs.realpath(top.stdout.trim());
  if (repositoryRoot !== root) throw new Error('Selecciona la carpeta arrel del repositori per veure’n els commits.');
  const [summary, files] = await Promise.all([
    runGit(['show', '-s', '--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%aI%x00%D', hash], root),
    runGit(['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '--no-renames', hash], root),
  ]);
  const failed = [summary, files].find((result) => result.code !== 0);
  if (failed) throw new Error(failed.stderr.trim() || 'Git no ha pogut llegir el commit.');
  const [fullHash, shortHash, subject, author, email, date, decorations = ''] = summary.stdout.trim().split('\0');
  const fileParts = files.stdout.split('\0').filter(Boolean);
  const changedFiles = [];
  for (let index = 0; index + 1 < fileParts.length; index += 2) changedFiles.push({ status: fileParts[index], path: fileParts[index + 1] });
  return { hash: fullHash, shortHash, subject, author, email, date, decorations: decorations.trim(), files: changedFiles, truncated: files.truncated };
}

async function getGitCommitCandidates(projectRoot) {
  let root;
  try { root = await fs.realpath(projectRoot); }
  catch (error) { return { available: false, reason: error.message }; }
  const top = await runGit(['rev-parse', '--show-toplevel'], root);
  if (top.code !== 0) return { available: false, reason: 'Aquesta carpeta no és un repositori Git.' };
  let repositoryRoot;
  try { repositoryRoot = await fs.realpath(top.stdout.trim()); }
  catch { return { available: false, reason: 'No s’ha pogut resoldre la carpeta del repositori Git.' }; }
  if (repositoryRoot !== root) return { available: false, reason: 'Selecciona la carpeta arrel del repositori per crear un commit amb seguretat.' };
  const status = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], root);
  if (status.code !== 0 || status.timedOut || status.truncated) return { available: false, reason: status.stderr.trim() || 'Git no ha pogut llegir tots els canvis; no es crearà cap commit.' };
  const entries = status.stdout.split('\0').filter(Boolean);
  const paths = [];
  for (const entry of entries) {
    const filePath = entry.slice(3);
    if (!filePath || filePath.includes('\n') || filePath.includes('\r')) return { available: false, reason: 'Hi ha un nom de fitxer que no es pot mostrar de manera segura.' };
    paths.push(filePath);
  }
  return { available: true, root, paths: [...new Set(paths)], status: status.stdout };
}

module.exports = { getGitSnapshot, getGitHistory, getGitCommitDetails, getGitCommitCandidates };
