// The chat's turn in progress, kept by the main process so it survives the window: a reload (⌘R) or a
// reopened window finds it here (agent:active-turn), shows it as still working, and gets its end like the
// window that sent it. When the turn ends, the main process writes its answer (or its error, or the stop)
// into the conversation in the chat store itself, so nothing depends on the window that asked still being
// there. Each turn has an id (`turn` on the messages it adds): written twice, it is still there once.

const PLAN_PREFIX = 'Pla abans de començar:\n';
// Must match the agent's status text (src/core/assistant/agent.ts).
const PLAN_ACTIVITY_PREFIX = 'El model està triant l’acció següent segons el pla:';
const STOPPED_WHILE_REVIEWING = '_(Aturat mentre es revisava: aquesta resposta no s’ha acabat de comprovar.)_';
const CANCELLED_TEXT = 'Generació cancel·lada. El model local es tornarà a carregar quan enviïs la següent petició.';
const CANCELLED_ERROR = 'Generació cancel·lada.';

const TURN_ID = /^[A-Za-z0-9_-]{8,100}$/;

/** An answer without the reviewer's note the app used to append to it («Revisor: …», its last paragraph). */
function withoutReviewerNote(text) {
  return String(text).replace(/\n*\s*Revisor: (?:ha demanat corregir això abans d’acabar|ha llegit els fitxers escrits i no hi ha trobat cap problema)[\s\S]*$/, '');
}

/** The plan in a status message, if it carries one (its own «plan» status or the activity that quotes it). */
function planFromStatus(value) {
  if (!value || typeof value !== 'object' || typeof value.message !== 'string') return '';
  if (value.type === 'plan') return value.message.trim();
  if (value.type === 'status' && value.message.startsWith(PLAN_ACTIVITY_PREFIX)) return value.message.slice(PLAN_ACTIVITY_PREFIX.length).trim();
  return '';
}

/** The agent's progress (src/core/assistant/agent.ts): the iteration it is on of the limit in force, and its tool. */
function cleanProgress(value) {
  if (!value || typeof value !== 'object') return null;
  const { iteration, maxIterations, tool } = value;
  if (!Number.isInteger(iteration) || !Number.isInteger(maxIterations) || iteration < 1 || maxIterations < 1 || iteration > 1000 || maxIterations > 1000) return null;
  return { iteration, maxIterations, ...(typeof tool === 'string' && /^[a-z_]{1,60}$/.test(tool) ? { tool } : {}) };
}

/** The turn a window asks for, checked: its id, its conversation, its folder and the user's message as saved. */
function cleanTurn(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.id !== 'string' || !TURN_ID.test(value.id)) return null;
  if (typeof value.sessionId !== 'string' || !value.sessionId.trim() || value.sessionId.length > 200) return null;
  const user = value.userMessage && typeof value.userMessage === 'object' && typeof value.userMessage.text === 'string' ? value.userMessage : null;
  return {
    id: value.id,
    sessionId: value.sessionId,
    projectPath: typeof value.projectPath === 'string' && value.projectPath.length <= 4096 ? value.projectPath : undefined,
    userMessage: user ? { ...user, role: 'user' } : null,
  };
}

/**
 * What the turn adds to its conversation when it ends: the plan, if it was published and is not there
 * yet, and the answer, the error or the stop (with what the reviewer had, if it was stopped then).
 */
function turnMessages(turn, outcome) {
  const messages = [];
  if (turn.plan) messages.push({ role: 'assistant', text: `${PLAN_PREFIX}${turn.plan}`, turn: turn.id });
  if (outcome && typeof outcome.answer === 'string') {
    // The plan is already its own message; the answer does not repeat it.
    const text = turn.plan ? outcome.answer.replace(/^Pla: [^\n]*\n\n(?=\S)/, '') : outcome.answer;
    messages.push({ role: 'assistant', text, turn: turn.id, ...(turn.review ? { review: turn.review } : {}) });
    return messages;
  }
  const error = String(outcome?.error || 'error desconegut');
  const cancelled = error.includes(CANCELLED_ERROR);
  if (cancelled && turn.draft) messages.push({ role: 'assistant', text: `${turn.draft}\n\n${STOPPED_WHILE_REVIEWING}`, turn: turn.id });
  else if (cancelled) messages.push({ role: 'assistant', text: CANCELLED_TEXT, notice: true, turn: turn.id });
  else messages.push({ role: 'assistant', text: `Error: ${error}\n\nLa resposta no s’ha pogut generar. Si el procés local del model s’ha aturat, la finestra de l’app hauria de continuar oberta.`, notice: true, error: true, turn: turn.id });
  return messages;
}

/**
 * A conversation with the turn's messages in it, each once: the user's message if the window had not
 * saved it yet, the plan if no plan of this turn is there, and the end if this turn has none yet.
 */
function withTurn(session, turn, additions, now = new Date()) {
  const base = session || { id: turn.sessionId, title: 'Conversa nova', messages: [], ...(turn.projectPath ? { projectPath: turn.projectPath } : {}) };
  const messages = [...(base.messages || [])];
  if (turn.userMessage && !messages.some((message) => message.role === 'user' && message.text === turn.userMessage.text)) messages.push(turn.userMessage);
  const ended = messages.some((message) => message.turn === turn.id && !message.text.startsWith(PLAN_PREFIX));
  if (!ended) {
    for (const message of additions) {
      const isPlan = message.text.startsWith(PLAN_PREFIX);
      // A plan the window already put on screen (with or without this turn's id) is not written twice.
      if (isPlan && messages.some((existing) => existing.role === 'assistant' && existing.text === message.text)) continue;
      messages.push(message);
    }
  }
  const prompt = messages.find((message) => message.role === 'user')?.text.trim();
  const title = base.title === 'Conversa nova' && prompt ? (prompt.length > 42 ? `${prompt.slice(0, 39)}…` : prompt) : base.title;
  return { ...base, title, updatedAt: now.toISOString(), messages: messages.slice(-100) };
}

/** The one turn in progress (the local model answers one request at a time). */
function createActiveTurns({ now = () => new Date() } = {}) {
  let active = null;
  return {
    start(value) {
      const turn = cleanTurn(value);
      if (!turn) return null;
      active = { ...turn, startedAt: now().toISOString(), label: '', plan: '', draft: '', review: '' };
      return active;
    },
    /** Follows the agent's status: the last activity, the plan and the reviewer's finished draft. */
    status(value) {
      if (!active || !value || typeof value !== 'object') return;
      if (value.type === 'progress') { const progress = cleanProgress(value); if (progress) active.progress = progress; return; }
      if (value.type === 'draft') { if (typeof value.message === 'string' && value.message) active.draft = value.message; return; }
      // The reviewer's note: shown under the answer, never part of its text (so never sent back to the model).
      if (value.type === 'review') { if (typeof value.message === 'string' && value.message) active.review = value.message.slice(0, 4000); return; }
      const plan = planFromStatus(value);
      if (plan) active.plan = active.plan || plan;
      if (typeof value.message === 'string' && value.message) active.label = value.message;
    },
    /** What a window that has just loaded needs to show the turn: a copy, never the live object. */
    current() {
      if (!active) return null;
      const { id, sessionId, projectPath, startedAt, label, plan, progress } = active;
      return { id, sessionId, ...(projectPath ? { projectPath } : {}), startedAt, label, plan, ...(progress ? { progress: { ...progress } } : {}) };
    },
    /** Ends the turn `id` and gives what it adds to its conversation; null if it is not the turn in progress. */
    finish(id, outcome) {
      if (!active || active.id !== id) return null;
      const turn = active;
      active = null;
      return { turn, messages: turnMessages(turn, outcome) };
    },
  };
}

module.exports = { createActiveTurns, cleanTurn, cleanProgress, withoutReviewerNote, planFromStatus, turnMessages, withTurn, PLAN_PREFIX, STOPPED_WHILE_REVIEWING, CANCELLED_TEXT };
