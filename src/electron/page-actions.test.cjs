const assert = require('node:assert/strict');
const test = require('node:test');
const { checkedActions, pageActionsScript } = require('./page-actions.cjs');

test('page actions are validated before they reach the page', () => {
  const actions = checkedActions([
    { type: 'click', target: { by: 'role', role: 'button', value: 'Increment' } },
    { type: 'fill', target: { by: 'label', value: 'Nom' }, value: 'Cel' },
    { type: 'assertText', text: 'Count: 1' },
  ]);
  assert.equal(actions.length, 3);
  assert.match(pageActionsScript(actions), /"Count: 1"\]\)$/);
  assert.throws(() => checkedActions([{ type: 'click', target: { by: 'css', value: 'button' } }]), /no és vàlid/);
  assert.throws(() => checkedActions([{ type: 'click', target: { by: 'role', role: 'document', value: '' } }]), /rol/);
  assert.throws(() => checkedActions([{ type: 'eval', target: { by: 'text', value: 'x' } }]), /no és admès/);
  assert.throws(() => checkedActions(Array.from({ length: 13 }, () => ({ type: 'assertText', text: 'x' }))), /12 accions/);
});
