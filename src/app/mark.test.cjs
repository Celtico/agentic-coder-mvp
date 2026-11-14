// The app's mark (src/app/mark.tsx): the rail's logo has the app icon's gradient and never turns.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-mark-'));
const entry = path.join(dir, 'entry.tsx');
fs.writeFileSync(entry, `
import { renderToStaticMarkup } from "react-dom/server"
import { ChakraProvider } from "@chakra-ui/react"
import { buildSystem } from ${JSON.stringify(path.join(__dirname, '..', 'theme', 'system.ts'))}
import { Mark } from ${JSON.stringify(path.join(__dirname, 'mark.tsx'))}
export const render = (node: any, accent: any = "agentic") => renderToStaticMarkup(<ChakraProvider value={buildSystem(accent)}>{node}</ChakraProvider>)
export const two = (accent: any) => render(<><Mark size={28} gradient busy/><Mark size={28} gradient/></>, accent)
export const plain = () => render(<Mark size={18} busy/>)
`);
const out = path.join(dir, 'entry.cjs');
esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent', jsx: 'automatic', nodePaths: [path.join(__dirname, '..', '..', 'node_modules')] });
const built = require(out);
fs.rmSync(dir, { recursive: true, force: true });

test('the rail’s logo is drawn with a linear gradient from brand.300 to brand.600, one id per mark', () => {
  const html = built.two('blue');
  const ids = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) assert.equal((html.match(new RegExp(`url\\(#${id}\\)`, 'g')) || []).length, 2, 'stroke and fill');
  // The stops are the brand tokens (the brand stays green whatever the accent is).
  assert.match(html, /<stop offset="0%" stop-color="var\(--chakra-colors-brand-300\)"/);
  assert.match(html, /<stop offset="100%" stop-color="var\(--chakra-colors-brand-600\)"/);
  assert.doesNotMatch(html, /#[0-9a-f]{6}"/i, 'no colour written by hand');
});

test('the rail’s logo never turns, even while the model works; the plain mark still does', () => {
  // The theme always defines the keyframes; what matters is whether a mark uses them.
  const uses = (html) => /animation(?:-name)?:\s*agentic(?:Turn|Breathe|Beat)/.test(html.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, ''));
  assert.equal(uses(built.two('agentic')), false);
  assert.equal(uses(built.plain()), true);
  const source = fs.readFileSync(path.join(__dirname, 'mark.tsx'), 'utf8');
  assert.match(source, /const moving = busy && !gradient/);
});
