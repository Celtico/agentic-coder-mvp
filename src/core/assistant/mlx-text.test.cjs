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

test('a Gemma call written as JSON after «call:» is read too', { skip: !available && 'no MLX runtime' }, () => {
  const out = run(`${header}
print(json.dumps(mlx_text.normalize_tool_calls('<|tool_call>call:{"name":"run_tests"}<tool_call|>', tools, gemma4.tool_call_start, gemma4.tool_call_end, gemma4.parse_tool_call)))`);
  assert.equal(out, '<tool_call>{"name": "run_tests", "arguments": {}}</tool_call>');
});

test('past calls go back to the model in its own format, with the reply as a tool message', { skip: !available && 'no MLX runtime' }, () => {
  const out = run(`${header}
history = [
  {"role": "system", "content": "S"},
  {"role": "user", "content": "Executa les proves"},
  {"role": "assistant", "content": 'Les executo. <tool_call>{"name": "run_tests", "arguments": {}}</tool_call>'},
  {"role": "user", "content": "Resultat: ok"},
  {"role": "assistant", "content": '{"type":"final","content":"Fet."}'},
  {"role": "user", "content": "Gràcies"},
]
print(json.dumps(mlx_text.native_history(history)))`);
  assert.deepEqual(out, [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'Executa les proves' },
    { role: 'assistant', content: 'Les executo.', tool_calls: [{ type: 'function', function: { name: 'run_tests', arguments: {} } }] },
    { role: 'tool', name: 'run_tests', content: 'Resultat: ok' },
    { role: 'assistant', content: '{"type":"final","content":"Fet."}' },
    { role: 'user', content: 'Gràcies' },
  ]);
});

const gemmaWeights = path.join(__dirname, '..', '..', '..', 'models', 'mlx', 'gemma-4-12b-it-4bit', 'chat_template.jinja');
test('the Gemma 4 template renders that history in its native form', { skip: (!available || !fs.existsSync(gemmaWeights)) && 'no Gemma 4 weights' }, () => {
  const out = run(`${header}
from pathlib import Path
from mlx_lm.tokenizer_utils import load
t = load(Path(${JSON.stringify(path.dirname(gemmaWeights))}))
h = mlx_text.native_history([{"role": "user", "content": "Executa"}, {"role": "assistant", "content": '<tool_call>{"name": "run_tests", "arguments": {}}</tool_call>'}, {"role": "user", "content": "Resultat: ok"}])
print(json.dumps(t.apply_chat_template(h, tokenize=False, add_generation_prompt=True, enable_thinking=False)))`);
  assert.match(out, /<\|tool_call>call:run_tests\{\}<tool_call\|><\|tool_response>response:run_tests\{value:<\|"\|>Resultat: ok<\|"\|>\}<tool_response\|>$/);
  assert.doesNotMatch(out, /<tool_call>\{/);
});

// A model whose tokenizer has no tool parser in mlx_lm (MiMo V2.6 with vision, 15-11-2026: 2 of 9 in the
// evaluation, every call ignored). Plain Python, no MLX needed.
test('without a parser: JSON inside <function=…>, and the XML parameters, still become calls', () => {
  const result = spawnSync('python3', ['-I', '-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(__dirname)})
import mlx_text
n = lambda t: mlx_text.normalize_tool_calls(t, None, None, None, None)
print(json.dumps([n('Vull revisar.<tool_call><function=read_file>{"path": "src/math.cjs"}</function></tool_call><tool_call><function=run_tests>{}</function></tool_call>'), n('<tool_call>\\n<function=write_file>\\n<parameter=path>\\na.txt\\n</parameter>\\n<parameter=content>\\nhola\\n</parameter>\\n</function>\\n</tool_call>'), n('Sense cap eina.'), n('<tool_call>no és una crida</tool_call>'), n('<tool_call><function=run_tests></function></tool_call>'), n('<tool_call>{"name": "read_file", "parameter": {"path": "a"}}</tool_call>'), n('Vull veure-ho.<tool_call><function=search_text>{"query": "bg.inverted"}</tool_call>')]))`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const [tagged, xml, plain, broken, empty, named, unclosed] = JSON.parse(result.stdout.trim());
  assert.equal(unclosed, 'Vull veure-ho.<tool_call>{"name": "search_text", "arguments": {"query": "bg.inverted"}}</tool_call>', 'the closing </function> left out');
  assert.equal(empty, '<tool_call>{"name": "run_tests", "arguments": {}}</tool_call>', 'a call without arguments');
  assert.equal(named, '<tool_call>{"name": "read_file", "arguments": {"path": "a"}}</tool_call>', 'arguments named «parameter»');
  assert.equal(tagged, 'Vull revisar.<tool_call>{"name": "read_file", "arguments": {"path": "src/math.cjs"}}</tool_call><tool_call>{"name": "run_tests", "arguments": {}}</tool_call>');
  assert.equal(xml, '<tool_call>{"name": "write_file", "arguments": {"path": "a.txt", "content": "hola"}}</tool_call>');
  assert.equal(plain, 'Sense cap eina.');
  assert.equal(broken, '<tool_call>no és una crida</tool_call>');
});

// MiMo V2.6 with vision (nativ-community) lost `tool_parser_type`; mlx_lm then guesses json_tools and
// neither reads its XML calls nor gives it its history in its own format. Its template says which it is.
test('a model without its tool-call format declared gets the one its chat template writes; a declared one is kept', () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'agentic-parser-hint-'));
  try {
    const model = (name, config, template) => {
      fs.mkdirSync(path.join(root, name));
      if (config) fs.writeFileSync(path.join(root, name, 'tokenizer_config.json'), JSON.stringify(config));
      if (template) fs.writeFileSync(path.join(root, name, 'chat_template.jinja'), template);
      return path.join(root, name);
    };
    const xml = "{{- '<tool_call><function=' ~ tool_call.name ~ '>' -}}";
    const dirs = [
      model('lost', { tokenizer_class: 'Qwen2Tokenizer' }, xml),
      model('declared', { tool_parser_type: 'qwen3_coder' }, xml),
      model('inline', { chat_template: xml }, null),
      model('json', {}, '<tool_call>\n{"name": ...}</tool_call>'),
      model('empty', null, null),
    ];
    const result = spawnSync('python3', ['-I', '-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(__dirname)})
import mlx_text
print(json.dumps([mlx_text.tool_parser_hint(d) for d in ${JSON.stringify(dirs)}]))`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), ['qwen3_coder', null, 'qwen3_coder', null, null]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const worker = fs.readFileSync(path.join(__dirname, 'mlx-worker.py'), 'utf8');
  assert.match(worker, /_tool_parser = mlx_text\.tool_parser_hint\(sys\.argv\[1\]\)\n\s*model, tokenizer = load\(sys\.argv\[1\], adapter_path=adapter_path, \*\*\(\{"tokenizer_config": \{"tool_parser_type": _tool_parser\}\} if _tool_parser else \{\}\)\)/);
});
