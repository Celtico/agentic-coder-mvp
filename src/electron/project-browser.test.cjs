const assert = require('node:assert/strict');
const test = require('node:test');
const { findLocalProjectUrl } = require('./project-browser.cjs');

test('finds the local address printed by a Vite start script', () => {
  assert.equal(findLocalProjectUrl('  Local:   http://localhost:5173/\n'), 'http://localhost:5173/');
});

test('removes terminal color codes and accepts loopback hosts', () => {
  assert.equal(findLocalProjectUrl('\u001b[32mLocal: http://127.0.0.1:3000/\u001b[39m'), 'http://127.0.0.1:3000/');
});

test('does not open a non-local address or invalid port', () => {
  assert.equal(findLocalProjectUrl('Local: https://example.com/'), null);
  assert.equal(findLocalProjectUrl('Local: http://localhost:99999/'), null);
});
