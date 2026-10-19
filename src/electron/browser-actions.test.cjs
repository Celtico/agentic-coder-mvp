const assert = require('node:assert/strict');
const test = require('node:test');
const { runBrowserActions } = require('./browser-actions.cjs');

function fakePage() {
  const calls = [];
  const locator = (kind, ...args) => ({
    first() { calls.push(['first']); return this; },
    async click(options) { calls.push(['click', kind, ...args, options]); },
    async fill(value, options) { calls.push(['fill', kind, ...args, value, options]); },
    async waitFor(options) { calls.push(['waitFor', kind, ...args, options]); },
  });
  return {
    calls,
    getByRole: (...args) => locator('role', ...args),
    getByLabel: (...args) => locator('label', ...args),
    getByPlaceholder: (...args) => locator('placeholder', ...args),
    getByText: (...args) => locator('text', ...args),
    getByTestId: (...args) => locator('testId', ...args),
  };
}

test('runs bounded Playwright interactions through accessible locators', async () => {
  const page = fakePage();
  const result = await runBrowserActions(page, [
    { type: 'fill', target: { by: 'label', value: 'Note title' }, value: 'Shopping list' },
    { type: 'click', target: { by: 'role', role: 'button', value: 'Save' } },
    { type: 'assertText', text: 'Saved' },
  ]);
  assert.deepEqual(result, [
    { description: '1. fill', succeeded: true },
    { description: '2. click', succeeded: true },
    { description: '3. assertText', succeeded: true },
  ]);
  assert.ok(page.calls.some(([kind]) => kind === 'fill'));
  assert.ok(page.calls.some(([kind]) => kind === 'click'));
  assert.ok(page.calls.some(([kind]) => kind === 'waitFor'));
});

test('rejects arbitrary selectors, unsupported roles, and more than twelve browser actions', async () => {
  const page = fakePage();
  await assert.rejects(runBrowserActions(page, [{ type: 'click', target: { by: 'css', value: 'button' } }]), /localitzador/);
  await assert.rejects(runBrowserActions(page, [{ type: 'click', target: { by: 'role', role: 'document', value: 'x' } }]), /rol accessible/);
  await assert.rejects(runBrowserActions(page, Array.from({ length: 13 }, () => ({ type: 'assertText', text: 'ready' }))), /12 accions/);
});

test('reports an action failure with its index and type', async () => {
  const page = fakePage();
  page.getByText = () => ({ first() { return this; }, async waitFor() { throw new Error('timeout'); } });
  await assert.rejects(runBrowserActions(page, [{ type: 'assertText', text: 'Saved' }]), /acció de navegador 1 \(assertText\).*timeout/i);
});
