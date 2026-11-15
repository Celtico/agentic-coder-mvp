// Log del model: reading logs/llm-calls.jsonl (written by src/core/assistant/llm-trace.ts) for the panel.
const fs = require('node:fs/promises');

// Only the end of a big log is read: the panel shows the last calls.
const TAIL_BYTES = 16 * 1024 * 1024;

async function tailLines(file) {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').split('\n');
      if (length < size) lines.shift(); // the first line may be cut
      return lines.filter(Boolean);
    } finally { await handle.close(); }
  } catch { return []; }
}

/** The last `limit` calls from the files (oldest file first), newest first, each with its tools. */
async function readCalls(files, limit = 50) {
  const calls = [];
  const tools = new Map();
  for (const file of files) {
    for (const line of await tailLines(file)) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.type === 'call' && typeof record.id === 'string') calls.push(record);
      else if (record?.type === 'tool' && typeof record.callId === 'string') tools.set(record.callId, [...(tools.get(record.callId) || []), record]);
    }
  }
  return { calls: calls.slice(-limit).reverse().map((call) => ({ ...call, tools: tools.get(call.id) || [] })) };
}

module.exports = { readCalls, TAIL_BYTES };
