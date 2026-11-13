const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn, spawnSync } = require('node:child_process');

// mlx_lock.py only needs Python's standard library.
const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;
const script = (body) => `import sys, time; sys.path.insert(0, ${JSON.stringify(__dirname)})\nimport mlx_lock\n${body}`;

test('only one process holds the GPU lock; the next one waits, then says who has it', { skip: !python && 'no python3' }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-mlx-lock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, AGENT_MLX_LOCK: path.join(dir, 'mlx.lock'), AGENT_MLX_LOCK_LABEL: 'el xat de l’app' };
  const holder = spawn(python, ['-c', script('h = mlx_lock.acquire(); print("held", flush=True); time.sleep(2)')], { env });
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  const refused = spawnSync(python, ['-c', script('mlx_lock.acquire(timeout=0.5)')], { env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Ja hi ha un altre model carregat en aquest Mac \(pid \d+: el xat de l’app\)/);
  const waited = spawnSync(python, ['-c', script('mlx_lock.acquire(timeout=10); print("ok")')], { env, encoding: 'utf8' });
  assert.equal(waited.status, 0, waited.stderr);
  assert.match(waited.stdout, /ok/);
  await new Promise((resolve) => holder.once('exit', resolve));
});
