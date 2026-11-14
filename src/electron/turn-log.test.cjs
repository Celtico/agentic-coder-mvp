// A stopped request is written to the same log as the agent's turns (src/electron/turn-log.cjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { turnLogPath, appendTurnLog } = require('./turn-log.cjs');

test('the log is where the agent writes it: AGENT_TURN_LOG, the data folder when installed, or the app’s logs/', () => {
  assert.equal(turnLogPath({ env: { AGENT_TURN_LOG: 'off' }, appRoot: '/app' }), null);
  assert.equal(turnLogPath({ env: { AGENT_TURN_LOG: '/x/turns.jsonl' }, appRoot: '/app' }), '/x/turns.jsonl');
  assert.equal(turnLogPath({ env: {}, isPackaged: true, userData: '/data', appRoot: '/app' }), path.join('/data', 'logs', 'agent-turns.jsonl'));
  assert.equal(turnLogPath({ env: {}, isPackaged: false, userData: '/data', appRoot: '/app' }), path.join('/app', 'logs', 'agent-turns.jsonl'));
});

test('a stop is one line with its time and kind', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-turn-log-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'logs', 'agent-turns.jsonl');
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, '{"at":"2026-11-14T17:28:52.695Z","iteration":3}\n');
  assert.equal(await appendTurnLog(file, { kind: 'cancelled', requestId: 7 }, new Date('2026-11-14T17:29:40.000Z')), true);
  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines[1], { at: '2026-11-14T17:29:40.000Z', kind: 'cancelled', requestId: 7 });
  assert.equal(await appendTurnLog(null, { kind: 'cancelled' }), false);
});
