const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

// mlx_text.py with the real tool parsers of mlx_lm (Gemma 4 and Qwen 3.5 / Qwen3-Coder). It needs the
// local MLX runtime (models/.mlx-venv); without it the test is skipped.
const python = path.join(__dirname, '..', '..', '..', 'models', '.mlx-venv', 'bin', 'python');
const available = fs.existsSync(python);

function run(script) {
  const result = spawnSync(python, ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(__dirname)})\n${script}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

const header = `
import json, mlx_text
from mlx_lm.tool_parsers import gemma4, qwen3_coder
tools = [{"type": "function", "function": {"name": "write_file", "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}}}}]
`;

test('Gemma 4 and Qwen 3.5 tool calls become the JSON form the agent reads', { skip: !available && 'no MLX runtime' }, () => {
  const out = run(`${header}
g = mlx_text.normalize_tool_calls('Escric el fitxer. <|tool_call>call:write_file{path:<|"|>index.html<|"|>,content:<|"|><h1>Hola, {món}</h1><|"|>}<tool_call|>', tools, gemma4.tool_call_start, gemma4.tool_call_end, gemma4.parse_tool_call)
q = mlx_text.normalize_tool_calls('<tool_call>\\n<function=write_file>\\n<parameter=path>\\nsrc/main.jsx\\n</parameter>\\n<parameter=content>\\nimport x\\n</parameter>\\n</function>\\n</tool_call>', tools, qwen3_coder.tool_call_start, qwen3_coder.tool_call_end, qwen3_coder.parse_tool_call)
j = mlx_text.normalize_tool_calls('<tool_call>{"name": "list_files", "arguments": {}}</tool_call>', tools, qwen3_coder.tool_call_start, qwen3_coder.tool_call_end, qwen3_coder.parse_tool_call)
plain = mlx_text.normalize_tool_calls('Sense cap eina.', tools, gemma4.tool_call_start, gemma4.tool_call_end, gemma4.parse_tool_call)
print(json.dumps([g, q, j, plain]))`);
  assert.equal(out[0], 'Escric el fitxer. <tool_call>{"name": "write_file", "arguments": {"path": "index.html", "content": "<h1>Hola, {món}</h1>"}}</tool_call>');
  const qwen = JSON.parse(/<tool_call>(.*)<\/tool_call>/s.exec(out[1])[1]);
  assert.deepEqual(qwen, { name: 'write_file', arguments: { path: 'src/main.jsx', content: 'import x' } });
  assert.equal(out[2], '<tool_call>{"name": "list_files", "arguments": {}}</tool_call>');
  assert.equal(out[3], 'Sense cap eina.');
});

test('the hidden reasoning section is removed, also when only its end is in the answer', { skip: !available && 'no MLX runtime' }, () => {
  const out = run(`${header}
print(json.dumps([
  mlx_text.strip_thinking('<think>raono molt</think>{"type":"final","content":"fet"}', '<think>', '</think>'),
  mlx_text.strip_thinking('raono</think>Resposta', '<think>', '</think>'),
  mlx_text.strip_thinking('<|channel>thought\\npenso<channel|>Hola', '<|channel>thought', '<channel|>'),
  mlx_text.strip_thinking('Sense secció', '<think>', '</think>'),
  mlx_text.strip_thinking('Sense marques', None, None),
]))`);
  assert.deepEqual(out, ['{"type":"final","content":"fet"}', 'Resposta', 'Hola', 'Sense secció', 'Sense marques']);
});
