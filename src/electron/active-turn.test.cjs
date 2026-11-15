// The chat's turn in progress lives in the main process (src/electron/active-turn.cjs): a reloaded window
// finds it, and its end is written into the conversation there, once, whatever the window does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createActiveTurns, withTurn, turnMessages, cleanTurn, PLAN_PREFIX, STOPPED_WHILE_REVIEWING, CANCELLED_TEXT } = require('./active-turn.cjs');
const { ChatStore } = require('./chat-store.cjs');

const TURN = 'turn-0123456789abcdef';
const user = { role: 'user', text: 'Crea una app de Vite amb React' };
const request = { id: TURN, sessionId: 'chat-1', projectPath: '/tmp/projecte', userMessage: user };

test('the turn in progress, as a reloaded window gets it: activity, plan and iteration; none once it has ended', () => {
  const turns = createActiveTurns({ now: () => new Date('2026-11-15T00:00:00Z') });
  assert.equal(turns.current(), null);
  turns.start(request);
  turns.status({ type: 'status', message: 'El model està analitzant la tasca i el projecte…' });
  turns.status({ type: 'progress', iteration: 9, maxIterations: 28, tool: 'start_project' });
  turns.status({ type: 'plan', message: '1. Crear el projecte 2. Arrencar-lo' });
  turns.status({ type: 'status', message: 'Iniciant l’app (dev)…' });
  assert.deepEqual(turns.current(), { id: TURN, sessionId: 'chat-1', projectPath: '/tmp/projecte', startedAt: '2026-11-15T00:00:00.000Z', label: 'Iniciant l’app (dev)…', plan: '1. Crear el projecte 2. Arrencar-lo', progress: { iteration: 9, maxIterations: 28, tool: 'start_project' } });
  // A copy: what the window does with it does not change the turn.
  turns.current().progress.iteration = 99;
  assert.equal(turns.current().progress.iteration, 9);
  // Progress that is not one is ignored.
  turns.status({ type: 'progress', iteration: 'nou', maxIterations: 28 });
  assert.equal(turns.current().progress.iteration, 9);
  assert.equal(turns.finish('another-turn-id', { answer: 'x' }), null, 'only the turn in progress ends');
  assert.ok(turns.finish(TURN, { answer: 'Fet.' }));
  assert.equal(turns.current(), null);
  assert.equal(cleanTurn({ ...request, id: 'x' }), null);
});

test('the main process writes the end into the conversation even with no window: user message, plan and answer, each once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-turn-'));
  const store = new ChatStore(path.join(dir, 'conversations.sqlite'));
  try {
    // The window had saved the user's message and the plan before it was reloaded.
    store.saveMany([{ id: 'chat-1', title: 'Crea una app de Vite amb React', updatedAt: '2026-11-15T00:00:00Z', projectPath: '/tmp/projecte', messages: [user, { role: 'assistant', text: `${PLAN_PREFIX}1. Crear 2. Arrencar` }] }]);
    const turns = createActiveTurns();
    turns.start(request);
    turns.status({ type: 'plan', message: '1. Crear 2. Arrencar' });
    const ended = turns.finish(TURN, { answer: 'Pla: 1. Crear 2. Arrencar\n\nL’app és a http://localhost:5173/.' });
    const session = withTurn(store.get('chat-1'), ended.turn, ended.messages);
    store.saveMany([session]);
    const saved = store.get('chat-1');
    assert.deepEqual(saved.messages.map((message) => [message.role, message.text, message.turn]), [
      ['user', user.text, undefined],
      ['assistant', `${PLAN_PREFIX}1. Crear 2. Arrencar`, undefined],
      ['assistant', 'L’app és a http://localhost:5173/.', TURN],
    ]);
    // Written again (the answer to the request and the event both reach the window): nothing doubles.
    store.saveMany([withTurn(store.get('chat-1'), ended.turn, ended.messages)]);
    assert.equal(store.get('chat-1').messages.length, 3);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a conversation the window never saved is made from the turn, with its message and title', () => {
  const turns = createActiveTurns();
  turns.start(request);
  const ended = turns.finish(TURN, { answer: 'Fet.' });
  const session = withTurn(null, ended.turn, ended.messages, new Date('2026-11-15T00:01:00Z'));
  assert.equal(session.id, 'chat-1');
  assert.equal(session.title, 'Crea una app de Vite amb React');
  assert.equal(session.projectPath, '/tmp/projecte');
  assert.deepEqual(session.messages.map((message) => message.text), [user.text, 'Fet.']);
});

test('stopped or failed: the reviewer’s draft is kept, other stops and errors are notices', () => {
  const turn = { id: TURN, plan: '', draft: '' };
  assert.deepEqual(turnMessages(turn, { error: 'Generació cancel·lada.' }), [{ role: 'assistant', text: CANCELLED_TEXT, notice: true, turn: TURN }]);
  assert.deepEqual(turnMessages({ ...turn, draft: 'Resposta revisada' }, { error: 'Generació cancel·lada.' }), [{ role: 'assistant', text: `Resposta revisada\n\n${STOPPED_WHILE_REVIEWING}`, turn: TURN }]);
  const [failed] = turnMessages(turn, { error: 'El procés aïllat del model s’ha aturat' });
  assert.equal(failed.error, true);
  assert.equal(failed.notice, true);
  assert.match(failed.text, /^Error: El procés aïllat del model s’ha aturat/);
});

test('the wiring: main keeps the turn and writes its end; the window reconnects on load and sends nothing again', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  assert.match(main, /activeTurns\.status\(message\.value\); win\?\.webContents\.send\('agent:status'/);
  assert.match(main, /ipcMain\.handle\('agent:active-turn', \(\) => activeTurns\.current\(\)\)/);
  assert.match(main, /session = withTurn\(store\.get\(ended\.turn\.sessionId\), ended\.turn, ended\.messages\); store\.saveMany\(\[session\]\)/);
  assert.match(main, /win\.webContents\.send\('agent:turn-finished', result\)/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
  const reconnect = app.slice(app.indexOf('const offTurnFinished'), app.indexOf('const persistMessages = useCallback'));
  assert.match(reconnect, /window\.agentic\.activeTurn\?\.\(\)/);
  assert.match(reconnect, /setLoading\(true\); setLoadingLabel\(turn\.label \|\| PREPARING_MODEL\); setTurnProgress\(turn\.progress \|\| null\)/);
  assert.doesNotMatch(reconnect, /window\.agentic\.ask\(|makeSession\(/, 'a reloaded window neither sends the request again nor makes a new conversation');
  assert.match(app, /turn: \{ id: turnId, sessionId: requestSessionId, projectPath: project\.path, userMessage: pendingMessages\[pendingMessages\.length - 1\] \}/);
});

test('the reviewer’s note is a field of the answer, shown in the chat but never part of its text', () => {
  const turns = createActiveTurns();
  turns.start(request);
  turns.status({ type: 'review', message: 'Revisor: ha llegit els fitxers escrits i no hi ha trobat cap problema.' });
  const ended = turns.finish(TURN, { answer: 'He afegit el botó.' });
  assert.deepEqual(ended.messages, [{ role: 'assistant', text: 'He afegit el botó.', turn: TURN, review: 'Revisor: ha llegit els fitxers escrits i no hi ha trobat cap problema.' }]);
  // Kept by the chat store.
  const { cleanSession } = require('./chat-store.cjs');
  assert.equal(cleanSession({ id: 'x', messages: ended.messages }).messages[0].review, 'Revisor: ha llegit els fitxers escrits i no hi ha trobat cap problema.');
});

test('answers saved with the reviewer’s note at the end lose it before going back to the model', () => {
  const { withoutReviewerNote } = require('./active-turn.cjs');
  assert.equal(withoutReviewerNote('He aplicat el canvi.\n\nRevisor: ha demanat corregir això abans d’acabar: src/App.jsx: falta X · src/a.css: Y'), 'He aplicat el canvi.');
  assert.equal(withoutReviewerNote('Fet.\n\nRevisor: ha llegit els fitxers escrits i no hi ha trobat cap problema.'), 'Fet.');
  assert.equal(withoutReviewerNote('El Revisor de codi és una eina.'), 'El Revisor de codi és una eina.', 'only the app’s own note');
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  assert.match(main, /const content = \(message\.role === 'assistant' \? withoutReviewerNote\(message\.content\) : message\.content\)\.trim\(\);/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'app', 'App.tsx'), 'utf8');
  assert.match(app, /\{message\.review && <Text mt="2" fontSize="xs" color="fg\.muted" data-review-note>\{message\.review\}<\/Text>\}/);
  assert.match(app, /if \(s\.type === 'review'\) return;/);
});
