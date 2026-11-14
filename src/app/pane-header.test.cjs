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
import { Pane, PaneHeader, PaneToolbar, PaneToneContext, PaneStyleContext } from ${JSON.stringify(path.join(__dirname, 'pane-header.tsx'))}
export const render = (props: any, accent: any = "agentic") => renderToStaticMarkup(<ChakraProvider value={buildSystem(accent)}><PaneHeader {...props}/></ChakraProvider>)
export const renderInContext = (props: any, tone: any) => renderToStaticMarkup(<ChakraProvider value={buildSystem("agentic")}><PaneToneContext.Provider value={tone}><PaneHeader {...props}/></PaneToneContext.Provider></ChakraProvider>)
export const renderPane = (variant: any, fromContext = false) => renderToStaticMarkup(<ChakraProvider value={buildSystem("agentic")}><PaneStyleContext.Provider value={fromContext ? variant : "subtle"}><Pane variant={fromContext ? undefined : variant} label="Git" header={<PaneHeader icon={LuGitBranch} title="Git"/>}>contingut</Pane></PaneStyleContext.Provider></ChakraProvider>)
export const renderToolbar = (props: any, tone: any) => renderToStaticMarkup(<ChakraProvider value={buildSystem("agentic")}><PaneToneContext.Provider value={tone}><PaneToolbar {...props}/></PaneToneContext.Provider></ChakraProvider>)
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

test('the look is the theme’s slot recipes, with the three tones; the component has no colour of its own', () => {
  const recipes = fs.readFileSync(path.join(__dirname, '..', 'theme', 'pane-recipes.ts'), 'utf8');
  const system = fs.readFileSync(path.join(__dirname, '..', 'theme', 'system.ts'), 'utf8');
  assert.match(system, /slotRecipes: \{ paneHeader: paneHeaderRecipe, paneToolbar: paneToolbarRecipe, card: paneCardRecipe \}/);
  assert.match(recipes, /slots: \["root", "icon", "title", "subtitle", "actions"\]/);
  assert.match(recipes, /slots: \["root", "field", "action"\]/);
  assert.match(recipes, /brand: \{ root: \{ bg: "transparent" \}, icon: \{ color: "brand\.solid" \}, title: \{ color: "fg" \} \}/);
  assert.match(recipes, /mono: \{ root: \{ bg: "transparent" \}, icon: \{ color: "fg\.muted" \}, title: \{ color: "fg\.muted" \} \}/);
  assert.match(recipes, /tinted: \{ root: \{ bg: "brand\.subtle" \}, icon: \{ color: "brand\.fg" \}, title: \{ color: "brand\.fg" \} \}/);
  assert.match(recipes, /defaultVariants: \{ tone: "brand" \}/);
  assert.doesNotMatch(recipes, /#[0-9a-f]{3,8}\b|rgb\(/i);
  const component = fs.readFileSync(path.join(__dirname, 'pane-header.tsx'), 'utf8');
  assert.match(component, /useSlotRecipe\(\{ recipe: paneHeaderRecipe \}\)/);
  assert.match(component, /useSlotRecipe\(\{ recipe: paneToolbarRecipe \}\)/);
  assert.doesNotMatch(component, /color="|bg="|brand\.solid|fg\.muted|#[0-9a-f]{3,8}\b/i);
  for (const accent of ['agentic', 'blue', 'yellow']) assert.match(render({ icon: icons.LuPlus, title: 'Consola' }, accent), />Consola</);
});

test('each tone renders, from the prop or from Preferències (the context); its colours change', () => {
  const tone = (html) => /data-tone="([a-z]+)"/.exec(html)?.[1];
  const classes = (html) => /data-pane-header[^>]*|class="([^"]*)"[^>]*data-pane-header/.exec(html)?.[0];
  assert.equal(tone(render({ icon: icons.LuPlus, title: 'Git' })), 'brand');
  for (const value of ['brand', 'mono', 'tinted']) assert.equal(tone(render({ icon: icons.LuPlus, title: 'Git', tone: value })), value);
  assert.equal(tone(built.renderInContext({ icon: icons.LuPlus, title: 'Git' }, 'tinted')), 'tinted');
  // Different tones give the header different styles.
  const styles = (value) => built.render({ icon: icons.LuPlus, title: 'Git', tone: value });
  assert.notEqual(classes(styles('brand')), classes(styles('tinted')));
});

test('the second row: 36 px, its field (an address, a path) and its actions, in the same tone', () => {
  const html = built.renderToolbar({ field: '/Users/cel/Desktop/AGENT', fieldTitle: '/Users/cel/Desktop/AGENT', children: 'Buida' }, 'mono').replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
  assert.match(html, /data-pane-toolbar/);
  assert.match(html, /data-tone="mono"/);
  assert.match(html, /title="\/Users\/cel\/Desktop\/AGENT"[^>]*>\/Users\/cel\/Desktop\/AGENT</);
  assert.match(html, />Buida</);
});

test('every pane uses it', () => {
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  for (const [icon, title] of [['Conversations', 'Converses'], ['FileText', 'Fitxers'], ['ChartBar', 'Avaluació'], ['TerminalIcon', 'Terminal']]) assert.match(app, new RegExp(`<PaneHeader icon=\\{${icon}\\} title="${title}"`), title);
  for (const [icon, title] of [['FileCode', 'Editor'], ['Globe2', 'Navegador web'], ['GitBranch', 'Git'], ['Brain', 'Aprenentatge local'], ['Bug', 'Consola']]) assert.match(app, new RegExp(`frame\\(${icon}, '${title}'`), title);
  assert.match(app, /<PaneHeader icon=\{icon\} title=\{title\} \{\.\.\.extras\}\/>/);
  assert.doesNotMatch(app, /navigationHeader|<Card\.Header/);
});

test('every pane is a Chakra Card with its header and body, in Chakra’s three variants', () => {
  const strip = (html) => html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
  for (const variant of ['subtle', 'outline', 'elevated']) {
    for (const fromContext of [false, true]) {
      const html = strip(built.renderPane(variant, fromContext));
      assert.match(html, new RegExp(`data-pane-style="${variant}"`), `${variant} ${fromContext}`);
      assert.match(html, /chakra-card__root/);
      assert.match(html, /chakra-card__header[^]*>Git<[^]*chakra-card__body[^]*>contingut</);
    }
  }
  const recipes = fs.readFileSync(path.join(__dirname, '..', 'theme', 'pane-recipes.ts'), 'utf8');
  assert.match(recipes, /subtle: \{ root: \{ bg: "bg" \} \}/);
  assert.match(recipes, /outline: \{ root: \{ bg: "bg", borderWidth: "1px", borderColor: "border" \} \}/);
  assert.match(recipes, /elevated: \{ root: \{ bg: "bg", boxShadow: "md" \} \}/);
  assert.match(recipes, /defaultVariants: \{ \.\.\.chakraCard\.defaultVariants, variant: "subtle", size: "pane" \}/);
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  assert.equal((app.match(/<PaneCard[ >]/g) || []).length, 7, 'terminal, the two frames, evaluation, the two columns, and the preview in Preferències');
  // Only the chat (not one of the panes) still draws its own box.
  assert.equal((app.match(/borderRadius="panel" overflow="hidden"/g) || []).length, 1, 'no pane draws its own box any more');
  assert.match(app, /const chatPane = \(\n\s*<Flex h="full" minW="0" minH="0" direction="column" bg="bg" borderRadius="panel" overflow="hidden">/);
  assert.match(app, /<PaneStyleContext\.Provider value=\{appearance\.paneStyle\}>/);
  assert.match(app, /PANE_STYLES\.map\(\(style\) => <Box key=\{style\}[^>]*onClick=\{\(\) => setAppearance\(\(current\) => \(\{ \.\.\.current, paneStyle: style \}\)\)\}>/);
  assert.match(app, /subtle: 'Suau \(com ara\)', outline: 'Amb vora', elevated: 'Amb ombra'/);
});

test('Preferències › Aparença chooses the tone for the whole app, with a preview of each', () => {
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  assert.match(app, /<PaneToneContext\.Provider value=\{appearance\.paneTone\}>/);
  assert.match(app, /Capçaleres dels panells/);
  assert.match(app, /PANE_TONES\.map\(\(tone\) => <Box key=\{tone\}[^>]*onClick=\{\(\) => setAppearance\(\(current\) => \(\{ \.\.\.current, paneTone: tone \}\)\)\}>/);
  assert.match(app, /<PaneHeader icon=\{GitBranch\} title="Git" subtitle="Només lectura" tone=\{tone\}\/>/);
  assert.match(app, /brand: 'Icona de marca', mono: 'Monocrom', tinted: 'Tenyida'/);
  assert.match(app, /setAppearance\(defaultAppearance\(\)\)\}><RefreshCw size=\{14\}\/>Restableix l’aparença/);
  // The panes with a second row use the shared one; Git's and the browser's refresh go to the header.
  assert.equal((app.match(/<PaneToolbar[ >]/g) || []).length, 4);
  assert.match(app, /case 'browser': return frame\(Globe2, 'Navegador web', browserPane, \{ actions: <IconButton icon=\{RefreshCw\} label="Recarrega"/);
  assert.match(app, /case 'git': return frame\(GitBranch, 'Git', gitPane, \{[^\n]*actions: <IconButton icon=\{RefreshCw\} label="Actualitza l’historial de Git"/);
});

test('the Preferències dialog has Chakra’s panel background', () => {
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  assert.match(app, /<Dialog\.Content bg="bg\.panel" color="fg"[^>]*data-preferences>/);
});
