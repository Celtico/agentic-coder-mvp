const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { McpConnection, readMcpConfig } = require('./mcp-client.cjs');

const fakeServer = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') reply(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
  else if (message.method === 'tools/list') reply(message.id, { tools: [{ name: 'get_component_example', description: 'Returns   code examples.', inputSchema: { type: 'object', properties: { component: { type: 'string' } }, required: ['component'] } }] });
  else if (message.method === 'tools/call') reply(message.id, { content: [{ type: 'text', text: 'Example for ' + message.params.arguments.component }] });
});
`;

test('reads mcp.json, starts a server, lists its tools and calls one', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-mcp-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'server.cjs'), fakeServer);
  await fs.writeFile(path.join(root, 'mcp.json'), JSON.stringify({ mcpServers: { chakra: { command: process.execPath, args: ['server.cjs'] }, 'bad name!': { command: 'x' }, empty: { command: '' } } }));
  const config = await readMcpConfig(root);
  assert.deepEqual(Object.keys(config), ['chakra']);
  const connection = await new McpConnection('chakra', config.chakra, root).start();
  t.after(() => connection.stop());
  assert.deepEqual(await connection.listTools(), [{ name: 'get_component_example', description: 'Returns code examples.', parameters: ['component'], required: ['component'] }]);
  assert.deepEqual(await connection.callTool('get_component_example', { component: 'accordion' }), { isError: false, text: 'Example for accordion', truncated: false });
});

test('a project without mcp.json has no servers', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentic-coder-mcp-none-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await readMcpConfig(root), {});
});
