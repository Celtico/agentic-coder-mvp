/**
 * A small Model Context Protocol client: starts the servers a project declares in `mcp.json`
 * (stdio transport), lists their tools and calls them. An MCP server is a program that gives the
 * agent knowledge or abilities it does not have, such as a component library's own documentation.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

/** Reads and validates the project's server list. Same shape other tools use: { "mcpServers": { name: { command, args } } }. */
async function readMcpConfig(root) {
  for (const name of ['mcp.json', '.mcp.json']) {
    let text;
    try { text = await fs.readFile(path.join(root, name), 'utf8'); } catch { continue; }
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error(`${name} no és un JSON vàlid.`); }
    const servers = parsed && typeof parsed === 'object' ? parsed.mcpServers : null;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};
    const result = {};
    for (const [serverName, entry] of Object.entries(servers).slice(0, 5)) {
      if (!/^[\w-]{1,40}$/.test(serverName) || !entry || typeof entry !== 'object') continue;
      if (typeof entry.command !== 'string' || !entry.command.trim() || entry.command.length > 200) continue;
      const args = Array.isArray(entry.args) ? entry.args.filter((item) => typeof item === 'string' && item.length <= 500).slice(0, 20) : [];
      const env = entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env) ? Object.fromEntries(Object.entries(entry.env).filter(([key, value]) => /^[A-Z_][A-Z0-9_]*$/i.test(key) && typeof value === 'string').slice(0, 20)) : {};
      result[serverName] = { command: entry.command.trim(), args, env };
    }
    return result;
  }
  return {};
}

class McpConnection {
  constructor(name, { command, args, env }, cwd) {
    this.name = name;
    this.commandLine = [command, ...args].join(' ');
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.closed = false;
    this.child = spawn(command, args, { cwd, shell: false, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (chunk) => this.read(chunk.toString()));
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk.toString()).slice(-2000); });
    const fail = (why) => { this.closed = true; for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error(why)); } this.pending.clear(); };
    this.child.on('error', (error) => fail(`El servidor MCP «${name}» no s’ha pogut iniciar: ${error.message}`));
    this.child.on('exit', (code) => fail(`El servidor MCP «${name}» s’ha tancat (codi ${code}). ${this.stderr.trim().slice(-300)}`));
  }

  read(text) {
    this.buffer += text;
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) break;
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line.startsWith('{')) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiting = message && this.pending.get(message.id);
      if (!waiting) continue;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(`El servidor MCP «${this.name}» ha respost amb un error: ${String(message.error.message || 'desconegut').slice(0, 300)}`));
      else waiting.resolve(message.result);
    }
  }

  request(method, params, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error(`El servidor MCP «${this.name}» no està en marxa.`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`El servidor MCP «${this.name}» no ha respost a temps (${method}).`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
  }

  async start() {
    // The first start may have to download the server's package.
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agentic-coder', version: '0.1.0' } }, 120000);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return this;
  }

  async listTools() {
    const result = await this.request('tools/list', {});
    return (Array.isArray(result?.tools) ? result.tools : []).slice(0, 40).map((tool) => ({
      name: String(tool.name || '').slice(0, 80),
      description: String(tool.description || '').replace(/\s+/g, ' ').trim().slice(0, 220),
      parameters: tool.inputSchema && typeof tool.inputSchema.properties === 'object' ? Object.keys(tool.inputSchema.properties).slice(0, 12) : [],
      required: Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required.slice(0, 12) : [],
    })).filter((tool) => tool.name);
  }

  async callTool(tool, args) {
    const result = await this.request('tools/call', { name: tool, arguments: args && typeof args === 'object' ? args : {} }, 60000);
    const text = (Array.isArray(result?.content) ? result.content : []).map((part) => (part && part.type === 'text' ? String(part.text) : part && part.type ? `(contingut de tipus ${part.type})` : '')).filter(Boolean).join('\n');
    return { isError: result?.isError === true, text: text.slice(0, 9000), truncated: text.length > 9000 };
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    try { this.child.kill(); } catch { /* already gone */ }
  }
}

module.exports = { McpConnection, readMcpConfig };
