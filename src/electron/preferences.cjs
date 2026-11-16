// The agent's preferences, kept by the main process in settings.json with the model and the permission
// mode, and sent to the agent with each request: how long an answer may be, how many steps a task may
// take, whether the reviewer and the web search are on, and how much of the chat goes with a request.
const AGENT_LIMITS = {
  answerTokens: { min: 256, max: 8192, default: 2400 },
  maxIterations: { min: 1, max: 60, default: 28 },
  historyMessages: { min: 0, max: 100, default: 20 },
};

/** The values the app had before there were preferences (the reviewer and web search could be set by environment). */
function defaultAgentPreferences(env = process.env) {
  return {
    answerTokens: AGENT_LIMITS.answerTokens.default,
    maxIterations: AGENT_LIMITS.maxIterations.default,
    historyMessages: AGENT_LIMITS.historyMessages.default,
    // The reviewer is opt-in (Preferències › Agent): the same small model reviewing its own work invented
    // and contradicted demands, and its note taught the model to answer «done» before doing anything.
    review: env.AGENT_REVIEW === '1',
    webSearch: env.AGENT_WEB_SEARCH === '1',
    // The Python worker (mlx-lm) for every model, instead of the native engine where it can run one.
    pythonEngine: env.AGENT_PYTHON_ENGINE === '1',
  };
}

/** `value` (saved, or a change from the window) over `base`: numbers rounded into their range, anything else keeps `base`. */
function normalizeAgentPreferences(value, base = defaultAgentPreferences()) {
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = { ...base };
  for (const [key, limit] of Object.entries(AGENT_LIMITS)) {
    const number = typeof saved[key] === 'number' ? saved[key] : typeof saved[key] === 'string' && saved[key].trim() ? Number(saved[key]) : NaN;
    if (Number.isFinite(number)) result[key] = Math.min(limit.max, Math.max(limit.min, Math.round(number)));
  }
  for (const key of ['review', 'webSearch', 'pythonEngine']) if (typeof saved[key] === 'boolean') result[key] = saved[key];
  return result;
}

/**
 * The version of the agent's defaults. Version 2 (15-11-2026): history 20 messages (was 100) and the
 * reviewer off (was on).
 */
const AGENT_PREFERENCES_VERSION = 2;

/**
 * Saved preferences brought to the current defaults, once: a value that is still the old default moves to
 * the new one; a value the user chose is kept. After this the settings are saved with the current version,
 * so a value changed later is never moved again.
 */
function migrateAgentPreferences(value, version) {
  const saved = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  if (Number(version) >= AGENT_PREFERENCES_VERSION) return { agent: saved, migrated: false };
  if (saved.historyMessages === 100) saved.historyMessages = AGENT_LIMITS.historyMessages.default;
  if (saved.review === true) saved.review = false;
  return { agent: saved, migrated: true };
}

/** The last `count` messages of the chat (none with 0). */
function limitHistory(history, count) {
  if (!Array.isArray(history) || count <= 0) return [];
  return history.slice(-count);
}

module.exports = { AGENT_LIMITS, AGENT_PREFERENCES_VERSION, defaultAgentPreferences, normalizeAgentPreferences, migrateAgentPreferences, limitHistory };
