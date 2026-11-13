const test = require('node:test');
const assert = require('node:assert/strict');
const { trajectoryKey, buildSessionTrajectory, toChatExample } = require('./learning-trajectory.cjs');
const { prepareTrainingDataset } = require('./learning-dataset.cjs');

// A guided chat: the user leads step by step and approves the last answer.
const turns = [
  { role: 'user', content: 'Munta’m una interfície' },
  { role: 'assistant', content: 'He creat package.json.' },
  { role: 'user', content: 'ara compila-ho' },
  { role: 'assistant', content: 'El build passa.' },
];
const recorded = {
  [trajectoryKey('He creat package.json.')]: { model: 'm', system: 'SYSTEM', steps: [
    { name: 'write_file', arguments: { path: 'package.json', content: '{}' }, result: 'Resultat de l\'eina write_file: ok', ok: true },
  ] },
  [trajectoryKey('El build passa.')]: { model: 'm', system: 'SYSTEM 2', steps: [
    { name: 'run_project_script', arguments: { script: 'build' }, result: 'code 1', ok: false },
    { name: 'run_project_script', arguments: { script: 'build' }, result: 'code 0', ok: true },
  ] },
};
const lookup = (answer) => recorded[trajectoryKey(answer)];

test('a session keeps every request with the tool steps behind each answer', () => {
  const session = buildSessionTrajectory(turns, lookup);
  assert.equal(session.turns.length, 2);
  assert.equal(session.turns[0].request, 'Munta’m una interfície');
  assert.deepEqual(session.turns[0].steps[0].arguments, { path: 'package.json', content: '{}' });
  assert.equal(session.turns[1].steps.length, 2);
  assert.equal(session.turns[0].system, 'SYSTEM');
});

test('without any recorded steps there is no trajectory', () => {
  assert.equal(buildSessionTrajectory(turns, () => undefined), null);
  assert.equal(buildSessionTrajectory('not turns', lookup), null);
});

test('steps with an invalid tool name are dropped', () => {
  const session = buildSessionTrajectory([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }], () => ({ steps: [{ name: 'rm -rf', arguments: {}, result: '', ok: true }, { name: 'list_files', arguments: {}, result: 'r', ok: true }] }));
  assert.deepEqual(session.turns[0].steps.map((step) => step.name), ['list_files']);
});

test('a training example starts from the high-level request and keeps only the steps that worked', () => {
  const example = toChatExample({ prompt: 'ara compila-ho', answer: 'El build passa.', task: 'Munta’m una interfície', trajectory: buildSessionTrajectory(turns, lookup) });
  const roles = example.messages.map((message) => message.role);
  assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.equal(example.messages[0].content, 'Munta’m una interfície');
  // The guidance messages of the user ("ara compila-ho") are not in the example: only the request.
  assert.ok(!example.messages.some((message) => message.role === 'user' && message.content === 'ara compila-ho'));
  assert.deepEqual(JSON.parse(example.messages[1].content), { type: 'tool_call', name: 'write_file', arguments: { path: 'package.json', content: '{}' } });
  assert.equal(example.messages[4].content, 'code 0');
  assert.deepEqual(JSON.parse(example.messages[5].content), { type: 'final', content: 'El build passa.' });
});

test('an old case without trajectory stays a plain request and answer', () => {
  assert.deepEqual(toChatExample({ prompt: 'p', answer: 'a' }).messages, [{ role: 'user', content: 'p' }, { role: 'assistant', content: 'a' }]);
});

test('the dataset keeps the trajectory and still rejects secrets inside it', () => {
  const base = { verification: 'user-confirmed', projectPath: '/tmp/p', prompt: 'p', answer: 'a', evidence: 'build superat' };
  const trajectory = buildSessionTrajectory(turns, lookup);
  const prepared = prepareTrainingDataset([
    { ...base, id: '1', task: 'Munta’m una interfície', trajectory },
    { ...base, id: '2', prompt: 'q', trajectory: { turns: [{ request: 'x', answer: 'y', steps: [{ name: 'write_file', arguments: { content: 'token = ghp_abcdefghijklmnopqrstuvwxyz1234' }, result: '', ok: true }] }] } },
  ]);
  assert.equal(prepared.counts.included, 1);
  assert.equal(prepared.counts.secrets, 1);
  assert.equal(prepared.partitions.train[0].task, 'Munta’m una interfície');
  assert.equal(prepared.partitions.train[0].trajectory.turns.length, 2);
});
