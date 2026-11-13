const fs = require('node:fs/promises');
const path = require('node:path');
const { runNpmScript } = require('./sandbox-tools.cjs');

// Fixed, small coding tasks. Each one has its own files, a prompt as a person would write it in the
// app, and an objective check that only looks at the folder afterwards (and at the answer, for the
// question). Files listed in `protected` must stay byte for byte: changing the test to make it pass
// is a failure. None of them needs the network or any installed package.

const testScript = { name: 'fixture', private: true, scripts: { test: 'node --test' } };
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

const read = (root, file) => fs.readFile(path.join(root, file), 'utf8').catch(() => null);
async function testsPass(root) {
  const result = await runNpmScript(root, 'test');
  return { pass: result.code === 0, detail: result.code === 0 ? 'npm test passa' : `npm test falla (codi ${result.code})` };
}

const sumFixture = {
  'package.json': json(testScript),
  'src/math.cjs': 'function sum(a, b) {\n  return a - b;\n}\n\nmodule.exports = { sum };\n',
  'test/math.test.cjs': "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { sum } = require('../src/math.cjs');\n\ntest('sum adds two numbers', () => {\n  assert.equal(sum(2, 3), 5);\n  assert.equal(sum(-1, 1), 0);\n});\n",
};

const tasks = [
  {
    id: 'fix-failing-test',
    description: 'Una prova falla per un error a la funció; cal trobar-lo sol, corregir-lo i provar.',
    prompt: 'Les proves d’aquest projecte fallen. Troba l’error, corregeix el codi i comprova que npm test passa.',
    files: sumFixture,
    protected: ['test/math.test.cjs'],
    check: testsPass,
  },
  {
    id: 'fix-failing-test-directed',
    // A reference, not part of the open total: the prompt says exactly what to change.
    reference: true,
    description: 'El mateix error amb la instrucció concreta que ja va funcionar a mà (vegeu docs/engine-and-learning.md).',
    prompt: 'A src/math.cjs canvia `return a - b` per `return a + b` i executa npm test.',
    files: sumFixture,
    protected: ['test/math.test.cjs'],
    check: testsPass,
  },
  {
    id: 'add-function',
    description: 'Afegir una funció nova que una prova ja existent espera.',
    prompt: 'Afegeix a src/text.cjs una funció slugify(text) que passi el text a minúscules, canviï els espais per guions i tregui els accents, i exporta-la. Després executa npm test.',
    files: {
      'package.json': json(testScript),
      'src/text.cjs': "function capitalize(text) {\n  return text.charAt(0).toUpperCase() + text.slice(1);\n}\n\nmodule.exports = { capitalize };\n",
      'test/text.test.cjs': "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst text = require('../src/text.cjs');\n\ntest('capitalize', () => assert.equal(text.capitalize('hola'), 'Hola'));\ntest('slugify', () => {\n  assert.equal(typeof text.slugify, 'function');\n  assert.equal(text.slugify('Hola Món'), 'hola-mon');\n  assert.equal(text.slugify('Una Cançó Nova'), 'una-canco-nova');\n});\n",
    },
    protected: ['test/text.test.cjs'],
    check: testsPass,
  },
  {
    id: 'create-html-page',
    description: 'Crear un fitxer nou en una carpeta gairebé buida.',
    prompt: 'Crea un fitxer index.html amb el títol «Hola IA» i un encapçalament que digui Hola IA.',
    files: { 'README.md': '# Prova\n' },
    protected: [],
    check: async (root) => {
      const html = await read(root, 'index.html');
      if (html === null) return { pass: false, detail: 'no hi ha index.html' };
      const title = /<title>[^<]*Hola IA[^<]*<\/title>/i.test(html);
      const heading = /<h[1-3][^>]*>[^<]*Hola IA[^<]*<\/h[1-3]>/i.test(html);
      return { pass: title && heading, detail: `títol: ${title ? 'sí' : 'no'}; encapçalament: ${heading ? 'sí' : 'no'}` };
    },
  },
  {
    id: 'counter-page',
    description: 'Una pàgina petita amb comportament: un botó que compta clics. La comprovació és estàtica (no obre cap navegador).',
    prompt: 'Fes una pàgina index.html amb un botó que compti quantes vegades s’ha clicat i mostri el número a la pàgina. Tot en un sol fitxer.',
    files: { 'README.md': '# Comptador\n' },
    protected: [],
    check: async (root) => {
      const html = await read(root, 'index.html');
      if (html === null) return { pass: false, detail: 'no hi ha index.html' };
      const button = /<button\b/i.test(html);
      const script = /<script\b[\s\S]*?(addEventListener\s*\(\s*['"]click|onclick)/i.test(html) || /onclick\s*=/i.test(html);
      const counter = /(\+\+|\+=\s*1|\+\s*1\b)/.test(html);
      return { pass: button && script && counter, detail: `botó: ${button ? 'sí' : 'no'}; clic gestionat: ${script ? 'sí' : 'no'}; increment: ${counter ? 'sí' : 'no'}` };
    },
  },
  {
    id: 'answer-without-editing',
    description: 'Una pregunta sobre el projecte: la resposta ha de ser correcta i no s’ha de tocar cap fitxer.',
    prompt: 'Quina ordre he d’executar per arrencar aquest projecte, i quin fitxer s’executa?',
    files: {
      'package.json': json({ name: 'fixture', private: true, scripts: { start: 'node server.cjs', test: 'node --test' } }),
      'server.cjs': "require('node:http').createServer((_, res) => res.end('ok')).listen(3000);\n",
    },
    protected: ['package.json', 'server.cjs'],
    readOnly: true,
    check: async (_root, answer) => {
      const command = /npm\s+(run\s+)?start/i.test(answer);
      const file = /server\.cjs/i.test(answer);
      return { pass: command && file, detail: `esmenta npm start: ${command ? 'sí' : 'no'}; esmenta server.cjs: ${file ? 'sí' : 'no'}` };
    },
  },
];

module.exports = { tasks };
