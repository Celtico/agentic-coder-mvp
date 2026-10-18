const { LocalExperienceEmbedder } = require('../src/core/assistant/agent-runtime.cjs');

// Synthetic retrieval checks: no user conversations or verified examples are read.
const experiences = [
  { id: 'login-validation', prompt: 'Fix errors in authentication form validation', answer: '', evidence: '' },
  { id: 'gitignore', prompt: 'Respect generated folders excluded by nested gitignore files', answer: '', evidence: '' },
  { id: 'project-chat', prompt: 'Store conversations under a project path and restore it when reopening the chat', answer: '', evidence: '' },
  { id: 'browser-inspection', prompt: 'Inspect a local website and report actual console and network errors', answer: '', evidence: '' },
  { id: 'safe-edit', prompt: 'Keep a backup and do not overwrite a user file without approval', answer: '', evidence: '' },
  { id: 'semantic-search', prompt: 'Search verified examples by meaning using local text embeddings', answer: '', evidence: '' },
  { id: 'unrelated-food', prompt: 'Prepare a recipe for sourdough bread and vegetable soup', answer: '', evidence: '' },
];

const cases = [
  { query: 'Arregla la validació del formulari d’accés.', expected: 'login-validation' },
  { query: 'Respeta las carpetas generadas excluidas en gitignore anidado.', expected: 'gitignore' },
  { query: 'Torna a obrir el xat dins la carpeta del projecte que tenia associada.', expected: 'project-chat' },
  { query: 'Comprueba los errores de consola y red de una página local.', expected: 'browser-inspection' },
  { query: 'No perdis el fitxer original quan l’agent hi desa canvis.', expected: 'safe-edit' },
  { query: 'Busca ejemplos por significado con vectores de texto.', expected: 'semantic-search' },
  { query: 'Quin temps farà demà a Júpiter?', expected: null },
];

const stopWords = new Set('amb als aquest aquesta això com del dels dins el ella elles en es fer fins hi i les més molt no per però que qui se ser si sobre un una unes uns'.split(' '));
const tokens = (value) => new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((word) => !stopWords.has(word)));

function lexicalTop3(query) {
  const queryWords = tokens(query);
  return experiences.map((item) => {
    const sampleWords = tokens(item.prompt);
    const overlap = [...queryWords].filter((word) => sampleWords.has(word)).length;
    return { id: item.id, score: overlap };
  }).filter((item) => item.score >= 2 && item.score / Math.max(1, queryWords.size) >= 0.2)
    .sort((left, right) => right.score - left.score).slice(0, 3).map((item) => item.id);
}

function reciprocalRank(ranked, expected) {
  const index = ranked.indexOf(expected);
  return index < 0 ? 0 : 1 / (index + 1);
}

async function main() {
  const embedder = new LocalExperienceEmbedder();
  const semanticRanks = [];
  const lexicalRanks = [];
  const results = [];
  for (const item of cases) {
    const semantic = (await embedder.rank(item.query, experiences)).map((value) => value.id);
    const lexical = lexicalTop3(item.query);
    if (item.expected) {
      semanticRanks.push(reciprocalRank(semantic, item.expected));
      lexicalRanks.push(reciprocalRank(lexical, item.expected));
    }
    results.push({ query: item.query, expected: item.expected, semanticTop3: semantic, lexicalTop3: lexical, semanticHit: semantic.includes(item.expected), lexicalHit: lexical.includes(item.expected) });
  }
  const expectedCases = cases.filter((item) => item.expected);
  const relevantResults = results.filter((item) => item.expected);
  const mean = (values) => Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));
  console.log(JSON.stringify({
    dataset: '6 synthetic retrieval queries plus 1 irrelevant control; no user data',
    model: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    metric: 'Recall@3 and MRR@3',
    semantic: { recallAt3: relevantResults.filter((value) => value.semanticHit).length / expectedCases.length, mrrAt3: mean(semanticRanks), irrelevantQueryReturnedAny: results.at(-1).semanticTop3.length > 0 },
    lexicalBaseline: { recallAt3: relevantResults.filter((value) => value.lexicalHit).length / expectedCases.length, mrrAt3: mean(lexicalRanks), irrelevantQueryReturnedAny: results.at(-1).lexicalTop3.length > 0 },
    results,
    note: 'A small synthetic smoke benchmark only; it does not establish general retrieval quality or authorize model training.',
  }, null, 2));
}

main().catch((error) => {
  console.error(`Memory evaluation failed: ${error.message || error}`);
  process.exitCode = 1;
});
