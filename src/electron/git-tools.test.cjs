const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { getGitSnapshot, getGitCommitCandidates } = require('./git-tools.cjs');

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

test('reads branch, staged changes and unstaged changes without modifying the repository', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-git-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(projectRoot);
  git(projectRoot, 'init', '-q');
  git(projectRoot, 'config', 'user.name', 'Test User');
  git(projectRoot, 'config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(projectRoot, 'tracked.txt'), 'version one\n');
  git(projectRoot, 'add', 'tracked.txt');
  git(projectRoot, 'commit', '-m', 'initial', '-q');
  await fs.writeFile(path.join(projectRoot, 'tracked.txt'), 'version two\n');
  await fs.writeFile(path.join(projectRoot, 'new.txt'), 'untracked\n');
  git(projectRoot, 'add', 'tracked.txt');
  await fs.writeFile(path.join(projectRoot, 'tracked.txt'), 'version three\n');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const before = await fs.readFile(path.join(projectRoot, 'tracked.txt'), 'utf8');
  const snapshot = await getGitSnapshot(projectRoot);

  assert.equal(snapshot.available, true);
  assert.match(snapshot.branch, /^## /);
  assert.match(snapshot.status, /tracked\.txt/);
  assert.match(snapshot.status, /new\.txt/);
  assert.match(snapshot.stagedDiff, /version two/);
  assert.match(snapshot.unstagedDiff, /version three/);
  assert.equal(await fs.readFile(path.join(projectRoot, 'tracked.txt'), 'utf8'), before);
});

test('does not expose changes from a parent repository when a subfolder is selected', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-git-scope-test-'));
  const nestedRoot = path.join(tempRoot, 'repo', 'packages', 'app');
  await fs.mkdir(nestedRoot, { recursive: true });
  git(path.join(tempRoot, 'repo'), 'init', '-q');
  await fs.writeFile(path.join(tempRoot, 'repo', 'outside.txt'), 'parent change\n');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const snapshot = await getGitSnapshot(nestedRoot);

  assert.equal(snapshot.available, false);
  assert.match(snapshot.reason, /carpeta arrel/);
  assert.equal(snapshot.status, undefined);
});

test('reports a selected folder that is not in Git', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-not-git-test-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));

  const snapshot = await getGitSnapshot(projectRoot);

  assert.equal(snapshot.available, false);
  assert.match(snapshot.reason, /no és un repositori Git/);
});

test('lists only repository changes as commit candidates, including new files', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-git-commit-candidates-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(projectRoot);
  git(projectRoot, 'init', '-q');
  git(projectRoot, 'config', 'user.name', 'Test User');
  git(projectRoot, 'config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(projectRoot, 'tracked.txt'), 'initial\n');
  git(projectRoot, 'add', 'tracked.txt');
  git(projectRoot, 'commit', '-m', 'initial', '-q');
  await fs.writeFile(path.join(projectRoot, 'tracked.txt'), 'changed\n');
  await fs.writeFile(path.join(projectRoot, 'new file.txt'), 'new\n');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const result = await getGitCommitCandidates(projectRoot);

  assert.equal(result.available, true);
  assert.deepEqual(result.paths.sort(), ['new file.txt', 'tracked.txt']);
});

test('keeps large diffs bounded and marks their output as truncated', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-git-large-diff-test-'));
  const projectRoot = path.join(tempRoot, 'project');
  await fs.mkdir(projectRoot);
  git(projectRoot, 'init', '-q');
  git(projectRoot, 'config', 'user.name', 'Test User');
  git(projectRoot, 'config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(projectRoot, 'large.txt'), 'initial\n');
  git(projectRoot, 'add', 'large.txt');
  git(projectRoot, 'commit', '-m', 'initial', '-q');
  await fs.writeFile(path.join(projectRoot, 'large.txt'), `${'large diff line\n'.repeat(30_000)}end\n`);
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const snapshot = await getGitSnapshot(projectRoot);

  assert.equal(snapshot.available, true);
  assert.equal(snapshot.truncated, true);
  assert.ok(snapshot.unstagedDiff.length <= 240_000);
});
