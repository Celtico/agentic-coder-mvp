// Preferències › Model and Agent, as the main process keeps and checks them (src/electron/preferences.cjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const { AGENT_LIMITS, AGENT_PREFERENCES_VERSION, defaultAgentPreferences, normalizeAgentPreferences, migrateAgentPreferences, limitHistory } = require('./preferences.cjs');

test('the defaults are what the agent did before there were preferences', () => {
  // 20 messages of history by default: the whole conversation (up to 100) made every step slower and the model
  // copied the shape of its earlier answers. A value already saved in Preferències is kept.
  assert.deepEqual(defaultAgentPreferences({}), { answerTokens: 2400, maxIterations: 28, historyMessages: 20, review: false, webSearch: false });
  assert.equal(normalizeAgentPreferences({ historyMessages: 100 }, defaultAgentPreferences({})).historyMessages, 100);
  assert.equal(defaultAgentPreferences({ AGENT_REVIEW: '0' }).review, false);
  assert.equal(defaultAgentPreferences({ AGENT_WEB_SEARCH: '1' }).webSearch, true);
  assert.deepEqual(Object.keys(AGENT_LIMITS).sort(), ['answerTokens', 'historyMessages', 'maxIterations']);
});

test('saved or changed values are rounded into their range, and anything else keeps what it was', () => {
  const base = defaultAgentPreferences({});
  assert.deepEqual(normalizeAgentPreferences(undefined, base), base);
  assert.deepEqual(normalizeAgentPreferences('nope', base), base);
  assert.deepEqual(normalizeAgentPreferences({ answerTokens: 99999, maxIterations: 0, historyMessages: -5 }, base), { ...base, answerTokens: 8192, maxIterations: 1, historyMessages: 0 });
  assert.deepEqual(normalizeAgentPreferences({ answerTokens: 1000.6, maxIterations: '12', review: false, webSearch: true }, base), { ...base, answerTokens: 1001, maxIterations: 12, review: false, webSearch: true });
  assert.deepEqual(normalizeAgentPreferences({ answerTokens: NaN, maxIterations: 'many', review: 'yes', webSearch: 1, extra: 3 }, base), base);
  // A change of one value keeps the others as they were.
  const changed = normalizeAgentPreferences({ historyMessages: 10 }, { ...base, review: false });
  assert.deepEqual(changed, { ...base, review: false, historyMessages: 10 });
});

test('the history sent with a request is the last messages, or none', () => {
  const history = Array.from({ length: 5 }, (_, index) => ({ role: 'user', content: String(index) }));
  assert.deepEqual(limitHistory(history, 2).map((item) => item.content), ['3', '4']);
  assert.deepEqual(limitHistory(history, 100), history);
  assert.deepEqual(limitHistory(history, 0), []);
  assert.deepEqual(limitHistory(null, 3), []);
});

test('saved preferences move to the new defaults once: history 100 → 20 and the reviewer off; a chosen value stays', () => {
  // cel's settings as they were: the old defaults, saved before there was a version.
  const old = { answerTokens: 2400, maxIterations: 28, historyMessages: 100, review: true, webSearch: true };
  const moved = migrateAgentPreferences(old, undefined);
  assert.equal(moved.migrated, true);
  assert.deepEqual(normalizeAgentPreferences(moved.agent, defaultAgentPreferences({})), { answerTokens: 2400, maxIterations: 28, historyMessages: 20, review: false, webSearch: true });
  // A value the user chose (not the old default) is kept.
  assert.equal(migrateAgentPreferences({ historyMessages: 40, review: false }, undefined).agent.historyMessages, 40);
  // Already at the current version: nothing moves, not even a reviewer turned back on or 100 messages.
  const later = migrateAgentPreferences({ historyMessages: 100, review: true }, AGENT_PREFERENCES_VERSION);
  assert.equal(later.migrated, false);
  assert.deepEqual(later.agent, { historyMessages: 100, review: true });
  // The settings are saved with the version, so the move happens only once.
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, 'main.cjs'), 'utf8');
  assert.match(main, /agent: agentPreferences, agentPreferencesVersion: AGENT_PREFERENCES_VERSION/);
  assert.match(main, /if \(migratedSettings\) await saveSettings\(\)/);
});
