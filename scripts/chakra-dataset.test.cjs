// The Chakra UI v3 dataset (chakra-dataset.cjs): one case per documented section with code, nothing invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const { casesOf } = require('./chakra-dataset.cjs');
const { readExample } = require('../src/electron/learning-imports.cjs');

const doc = [
  '# Button', '', '## Usage', '', 'Import it.', '', '```jsx', 'import { Button } from "@chakra-ui/react"', '```', '',
  '## Examples', '', '### Sizes', '', 'Use the `size` prop.', '', '```tsx', '# not a heading inside code', '<Button size="sm">Desa</Button>', '```', '',
  '### No code here', '', 'Only text.', '', '## Props', '', '```ts', 'size: string', '```',
].join('\n');

test('each section with code becomes a case: the documentation’s text and code as the answer, a Catalan question', () => {
  const cases = casesOf(doc, 'components');
  assert.deepEqual(cases.map((item) => item.task), ['Chakra UI v3: Button › Usage', 'Chakra UI v3: Button › Examples › Sizes']);
  assert.equal(cases[1].prompt, 'Com faig «Sizes» amb el component Button de Chakra UI v3?');
  assert.equal(cases[1].answer, 'Use the `size` prop.\n\n```tsx\n# not a heading inside code\n<Button size="sm">Desa</Button>\n```');
  assert.match(cases[1].evidence, /llms-components\.txt\): Button › Examples › Sizes/);
  // Dades JSON reads them as cases written with «Crea un cas».
  assert.deepEqual(readExample(JSON.stringify(cases[1])).messages.map((message) => message.role), ['user', 'assistant']);
});

test('a stray unclosed ``` does not hide the components after it: a fence with a language always opens one', () => {
  const stray = [
    '# Card', '', '## Explorer', '', 'Explore the parts.', '', '```', '', '```tsx', '<Card.Root />', '```', '',
    '# Input', '', '## Usage', '', '```tsx', '<Input />', '```',
  ].join('\n');
  assert.deepEqual(casesOf(stray, 'components').map((item) => item.task).filter((task) => /Input/.test(task)), ['Chakra UI v3: Input › Usage']);
});
