// The header every pane shares (src/app/pane-header.tsx), rendered with the app's theme.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-pane-header-'));
const entry = path.join(dir, 'entry.tsx');
fs.writeFileSync(entry, `
import { renderToStaticMarkup } from "react-dom/server"
import { ChakraProvider } from "@chakra-ui/react"
import { LuGitBranch, LuPlus } from "react-icons/lu"
import { buildSystem } from ${JSON.stringify(path.join(__dirname, '..', 'theme', 'system.ts'))}
import { PaneHeader } from ${JSON.stringify(path.join(__dirname, 'pane-header.tsx'))}
export const render = (props: any, accent: any = "agentic") => renderToStaticMarkup(<ChakraProvider value={buildSystem(accent)}><PaneHeader {...props}/></ChakraProvider>)
export const icons = { LuGitBranch, LuPlus }
`);
const out = path.join(dir, 'entry.cjs');
esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent', jsx: 'automatic', nodePaths: [path.join(__dirname, '..', '..', 'node_modules')] });
const built = require(out);
const icons = built.icons;
// Only the header's markup, without the theme's style tags.
const render = (...args) => built.render(...args).replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
fs.rmSync(dir, { recursive: true, force: true });

test('a header with only an icon and a title: 40 px, a thin line below, the brand icon and the title', () => {
  const html = render({ icon: icons.LuGitBranch, title: 'Git' });
  assert.match(html, /data-pane-header/);
  assert.match(html, />Git</);
  assert.match(html, /<svg/);
  assert.doesNotMatch(html, /title="/, 'no subtitle');
  assert.doesNotMatch(html, /<button/, 'no actions');
});

test('a header with a subtitle (truncated, with its full text on hover), a badge and actions', () => {
  const html = render({ icon: icons.LuGitBranch, title: 'Fitxers', subtitle: 'AGENT · /Users/cel/Desktop/AGENT', subtitleTitle: '/Users/cel/Desktop/AGENT', badge: 'B', actions: '<acció>' });
  assert.match(html, />Fitxers</);
  assert.match(html, /title="\/Users\/cel\/Desktop\/AGENT"[^>]*>AGENT · \/Users\/cel\/Desktop\/AGENT</);
  assert.ok(html.indexOf('>Fitxers<') < html.indexOf('AGENT ·') && html.indexOf('AGENT ·') < html.indexOf('&lt;acció&gt;'), 'title, subtitle, then actions');
});

test('the same header with any accent: the icon keeps the brand green, never a fixed colour in the component', () => {
  const source = fs.readFileSync(path.join(__dirname, 'pane-header.tsx'), 'utf8');
  assert.match(source, /h="10"/);
  assert.match(source, /borderBottomWidth="1px" borderColor="border"/);
  assert.match(source, /<Icon size=\{16\}/);
  assert.match(source, /export const PANE_HEADER_TONE: PaneHeaderTone = "brand"/);
  assert.match(source, /fontSize="sm" fontWeight="semibold"/);
  assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|rgb\(|textTransform/i);
  for (const accent of ['agentic', 'blue', 'yellow']) assert.match(render({ icon: icons.LuPlus, title: 'Consola' }, accent), />Consola</);
});

test('the three colour variants are one choice: brand (default), mono and tinted', () => {
  const tone = (html) => /data-tone="([a-z]+)"/.exec(html)?.[1];
  assert.equal(tone(render({ icon: icons.LuPlus, title: 'Git' })), 'brand');
  assert.equal(tone(render({ icon: icons.LuPlus, title: 'Git', tone: 'mono' })), 'mono');
  assert.equal(tone(render({ icon: icons.LuPlus, title: 'Git', tone: 'tinted' })), 'tinted');
  const source = fs.readFileSync(path.join(__dirname, 'pane-header.tsx'), 'utf8');
  assert.match(source, /brand: \{ bg: "transparent", icon: "brand\.solid", title: "fg" \}/);
  assert.match(source, /mono: \{ bg: "transparent", icon: "fg\.muted", title: "fg\.muted" \}/);
  assert.match(source, /tinted: \{ bg: "brand\.subtle", icon: "brand\.fg", title: "brand\.fg" \}/);
});

test('every pane uses it', () => {
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  for (const [icon, title] of [['Conversations', 'Converses'], ['FileText', 'Fitxers'], ['ChartBar', 'Avaluació'], ['TerminalIcon', 'Terminal']]) assert.match(app, new RegExp(`<PaneHeader icon=\\{${icon}\\} title="${title}"`), title);
  for (const [icon, title] of [['FileCode', 'Editor'], ['Globe2', 'Navegador web'], ['GitBranch', 'Git'], ['Brain', 'Aprenentatge local'], ['Bug', 'Consola']]) assert.match(app, new RegExp(`frame\\(${icon}, '${title}'`), title);
  assert.match(app, /<PaneHeader icon=\{icon\} title=\{title\} \{\.\.\.extras\}\/>/);
  assert.doesNotMatch(app, /navigationHeader|<Card\.Header/);
});
