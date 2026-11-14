// The log of the agent's turns (logs/agent-turns.jsonl), as the main process writes to it: the same file
// the agent writes each turn to (src/core/assistant/agent.ts), so a stopped request shows up there too.
const path = require('node:path');
const fs = require('node:fs/promises');

/** Where the log is: AGENT_TURN_LOG if set ('off' turns it off), else the data folder when installed, else the app's logs/. */
function turnLogPath({ env = process.env, isPackaged = false, userData = '', appRoot }) {
  if (env.AGENT_TURN_LOG === 'off') return null;
  if (env.AGENT_TURN_LOG) return env.AGENT_TURN_LOG;
  return isPackaged ? path.join(userData, 'logs', 'agent-turns.jsonl') : path.join(appRoot, 'logs', 'agent-turns.jsonl');
}

async function appendTurnLog(file, entry, now = new Date()) {
  if (!file) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify({ at: now.toISOString(), ...entry }) + '\n');
  return true;
}

module.exports = { turnLogPath, appendTurnLog };
