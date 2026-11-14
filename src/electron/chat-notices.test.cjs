// The window's own messages in a chat are not part of the conversation with the model
// (src/electron/chat-notices.cjs in the main process, src/app/chat-notices.ts in the window).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { isChatNotice, LEGACY_NOTICES } = require('./chat-notices.cjs');
const { buildSessionTrajectory } = require('./learning-trajectory.cjs');
const { ChatStore } = require('./chat-store.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-chat-notices-'));
const out = path.join(dir, 'chat-notices.cjs');
esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'app', 'chat-notices.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
const windowNotices = require(out);

const samples = [
  ['Generació cancel·lada. El model local es tornarà a carregar quan enviïs la següent petició.', true],
  ['Error: worker exited\n\nLa resposta no s’ha pogut generar. Si el procés local del model s’ha aturat, la finestra de l’app hauria de continuar oberta.', true],
  ['No s’ha pogut obrir el fitxer: Error invoking remote method \'project:read\': Error: ENOENT: no such file or directory, realpath \'/Users/x/AGENT/package.json\'', true],
  ['No s’han pogut executar les comprovacions: no hi ha projecte', true],
  ['Executant les comprovacions del projecte…', true],
  ['He creat index.html amb el botó.', false],
  ['La generació cancel·lada de la funció s’ha corregit.', false],
];

test('notices are recognised by their flag, or by their text in chats saved before the flag', () => {
  for (const [text, notice] of samples) {
    assert.equal(isChatNotice({ role: 'assistant', content: text }), notice, text);
    assert.equal(isChatNotice({ role: 'user', content: text }), false, 'what the user wrote is never a notice');
  }
  assert.equal(isChatNotice({ role: 'assistant', content: 'Qualsevol text', notice: true }), true);
  assert.equal(isChatNotice({ role: 'assistant', content: 'Qualsevol text', error: true }), true);
});

test('the window and the main process recognise the same notices', () => {
  assert.deepEqual(windowNotices.LEGACY_NOTICES.map(String), LEGACY_NOTICES.map(String));
  for (const [text, notice] of samples) assert.equal(windowNotices.isWindowNotice({ role: 'assistant', text }), notice, text);
  assert.equal(windowNotices.isWindowNotice({ role: 'assistant', text: 'Fet.', notice: true }), true);
  assert.equal(windowNotices.isWindowNotice({ role: 'assistant', text: 'Fet.', error: true }), true);
  assert.equal(windowNotices.isWindowNotice({ role: 'assistant', text: 'Fet.' }), false);
});

test('a verified case keeps no notice among its steps', () => {
  const steps = { steps: [{ name: 'write_file', arguments: { path: 'a' }, result: 'ok', ok: true }] };
  const trajectory = buildSessionTrajectory([
    { role: 'user', content: 'Crea a' },
    { role: 'assistant', content: 'Generació cancel·lada. El model local es tornarà a carregar quan enviïs la següent petició.' },
    { role: 'assistant', content: 'No s’ha pogut obrir el fitxer: ENOENT', notice: true },
    { role: 'assistant', content: 'He creat a.' },
  ], (text) => (text === 'He creat a.' ? steps : null));
  assert.deepEqual(trajectory.turns.map((turn) => [turn.request, turn.answer]), [['Crea a', 'He creat a.']]);
});

test('the chat store keeps the notice flag', (t) => {
  const file = path.join(dir, 'chats.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ChatStore(file);
  store.saveMany([{ id: 'a', title: 't', updatedAt: '2026-11-14T00:00:00.000Z', messages: [{ role: 'user', text: 'hola' }, { role: 'assistant', text: 'Aturat', notice: true }, { role: 'assistant', text: 'Error', error: true, notice: true }] }]);
  assert.deepEqual(store.get('a').messages, [{ role: 'user', text: 'hola' }, { role: 'assistant', text: 'Aturat', notice: true }, { role: 'assistant', text: 'Error', error: true, notice: true }]);
  store.close();
});
