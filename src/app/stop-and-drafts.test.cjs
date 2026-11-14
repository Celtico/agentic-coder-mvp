// The window: stopping takes two clicks, and a stopped answer the reviewer sent back is kept
// (src/app/App.tsx). These read the source, like the other checks of the window's wiring.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');

test('the stop button arms on the first click and stops on the second, within three seconds', () => {
  assert.match(app, /const STOP_CONFIRM_MS = 3000;/);
  assert.match(app, /onClick=\{\(\) => void stopPrompt\(\)\}/);
  const body = app.slice(app.indexOf('async function stopPrompt()'), app.indexOf('async function cancelPrompt()'));
  assert.match(body, /if \(!stopArmed\) \{[\s\S]*setStopArmed\(true\)[\s\S]*setTimeout\(\(\) => setStopArmed\(false\), STOP_CONFIRM_MS\)[\s\S]*return;/);
  assert.match(body, /await cancelPrompt\(\);/);
  assert.equal((app.match(/onClick=\{cancelPrompt\}/g) || []).length, 0, 'nothing stops on a single click');
  assert.match(app, /Torna a clicar per aturar/);
});

test('a draft from the reviewer is kept when the work is stopped; other stops and errors are notices', () => {
  assert.match(app, /if \(s\.type === 'draft'\)/);
  // The stop and the error are written into the conversation by the main process (src/electron/active-turn.cjs).
  const turns = fs.readFileSync(path.join(__dirname, '..', 'electron', 'active-turn.cjs'), 'utf8');
  assert.match(turns, /if \(cancelled && turn\.draft\)/);
  assert.match(turns, /else if \(cancelled\) messages\.push\(\{ role: 'assistant', text: CANCELLED_TEXT, notice: true/);
  assert.match(turns, /notice: true, error: true, turn: turn\.id/);
  // Notices are not sent to the model nor offered as a verified case.
  assert.match(app, /filter\(\(message\) => !isWindowNotice\(message\)\)\.map\(\(message\) => \(\{ role: message\.role, content: message\.text \}\)\)/);
  assert.match(app, /previousUser && !isWindowNotice\(message\)/);
  // A file that cannot be opened is said in the status bar, not in the chat.
  assert.doesNotMatch(app, /appendMessage\('assistant', `No s’ha pogut obrir el fitxer/);
});
