#!/usr/bin/env node
// A training dataset from the Chakra UI v3 documentation for LLMs (chakra-ui.com/llms-*.txt, MIT licence),
// for Aprenentatge local › Dades JSON: one case per documented example, as «Crea un cas» writes them
// ({"task", "prompt", "answer", "evidence"}). Nothing is invented: the answer is the documentation's own
// text and code for that section; only the question is written, in Catalan, from its titles.
//
//   node scripts/chakra-dataset.cjs [folder with llms-components.txt, llms-styling.txt, llms-theming.txt
//                                    and llms-full.txt, for what only the full one has: installation, the
//                                    frameworks (Vite, Next.js…), the CLI, the migration to v3 and the charts]
//   → <folder>/chakra-v3.jsonl
const fs = require('node:fs');
const path = require('node:path');

// Longer sections would not fit a training example (the app trains with up to about 2.000 tokens).
const MAX_ANSWER_CHARS = 5000;

/** The sections of a llms-*.txt file: [{ title (the «#» heading), section, example, text }], fences kept whole. */
function sections(text) {
  const found = [];
  let h1 = '';
  let h2 = '';
  let current = null;
  let fenced = false;
  const close = () => { if (current) found.push({ ...current, text: current.lines.join('\n').trim() }); current = null; };
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) fenced = !fenced;
    const heading = !fenced && /^(#{1,3}) (.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      close();
      if (level === 1) { h1 = title; h2 = ''; }
      else if (level === 2) h2 = title;
      // A usage section, an example (a «###» under Examples), or a «##» section of a guide.
      if (level >= 2) current = { title: h1, section: level === 2 ? title : h2, example: level === 3 ? title : null, lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  close();
  return found;
}

/** The cases of one file: the sections that show code, as question and the documentation's answer. */
function casesOf(text, kind) {
  const cases = [];
  for (const { title, section, example, text: answer } of sections(text)) {
    if (!answer.includes('```') || answer.length > MAX_ANSWER_CHARS) continue;
    if (/^(Props|Explorer|Accessibility|Anatomy|Guides?)$/i.test(section) && !example) continue;
    const where = [title, section, example].filter(Boolean).join(' › ');
    const prompt = kind === 'components'
      ? (example ? `Com faig «${example}» amb el component ${title} de Chakra UI v3?` : `Com faig servir ${title} a Chakra UI v3 (${section})?`)
      : kind === 'full'
        ? `${title} amb Chakra UI v3: com es fa «${example || section}»?`
        : `Com funciona «${example || section}» de ${title} a Chakra UI v3?`;
    cases.push({ task: `Chakra UI v3: ${where}`, prompt, answer, evidence: `Documentació oficial de Chakra UI v3 per a LLMs (chakra-ui.com/llms-${kind}.txt): ${where}.` });
  }
  return cases;
}

// Pages of the full documentation about the project itself, not about using it.
const NOT_USAGE = /^(Contributing to Chakra UI|Figma|LLMs\.txt Documentation|MCP Server|AI Skills)$/;

function build(folder) {
  const all = [];
  for (const kind of ['components', 'styling', 'theming']) {
    const file = path.join(folder, `llms-${kind}.txt`);
    if (fs.existsSync(file)) all.push(...casesOf(fs.readFileSync(file, 'utf8'), kind));
  }
  // From the full documentation, only the pages the three files do not have (installation, frameworks, CLI, charts…).
  const full = path.join(folder, 'llms-full.txt');
  if (fs.existsSync(full)) {
    const covered = new Set(all.map((item) => item.task.replace(/^Chakra UI v3: /, '').split(' › ')[0]));
    all.push(...casesOf(fs.readFileSync(full, 'utf8'), 'full').filter((item) => {
      const page = item.task.replace(/^Chakra UI v3: /, '').split(' › ')[0];
      return !covered.has(page) && !NOT_USAGE.test(page);
    }));
  }
  // The same question twice (two files documenting the same section) once.
  const seen = new Set();
  return all.filter((item) => !seen.has(item.prompt) && seen.add(item.prompt));
}

if (require.main === module) {
  const folder = process.argv[2] || path.join(__dirname, '..', 'models', 'datasets', 'chakra-v3');
  const cases = build(folder);
  const out = path.join(folder, 'chakra-v3.jsonl');
  fs.writeFileSync(out, cases.map((item) => JSON.stringify(item)).join('\n') + '\n');
  console.log(`${cases.length} casos → ${out}`);
}

module.exports = { sections, casesOf, build, MAX_ANSWER_CHARS };
