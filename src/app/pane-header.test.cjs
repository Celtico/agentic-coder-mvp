// The header every pane shares (src/app/pane-header.tsx), rendered with the app's theme.
const test = require('node:test');
const chakraCardElevated = () => require('@chakra-ui/react').defaultConfig.theme.slotRecipes.card.variants.variant.elevated;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-pane-header-'));
const entry = path.join(dir, 'entry.tsx');
fs.writeFileSync(entry, `
import { renderToStaticMarkup } from "react-dom/server"
import { ChakraProvider, Dialog } from "@chakra-ui/react"
import { LuGitBranch, LuPlus } from "react-icons/lu"
import { buildSystem } from ${JSON.stringify(path.join(__dirname, '..', 'theme', 'system.ts'))}
import { Pane, PaneHeader, PaneTitle, PaneToolbar, PaneToneContext, PaneStyleContext } from ${JSON.stringify(path.join(__dirname, 'pane-header.tsx'))}
export const render = (props: any, accent: any = "agentic") => renderToStaticMarkup(<ChakraProvider value={buildSystem(accent)}><PaneHeader {...props}/></ChakraProvider>)
export const renderInContext = (props: any, tone: any) => renderToStaticMarkup(<ChakraProvider value={buildSystem("agentic")}><PaneToneContext.Provider value={tone}><PaneHeader {...props}/></PaneToneContext.Provider></ChakraProvider>)
export const renderPane = (variant: any, fromContext = false) => renderToStaticMarkup(<ChakraProvider value={buildSystem("agentic")}><PaneStyleContext.Provider value={fromContext ? variant : "subtle"}><Pane variant={fromContext ? undefined : variant} label="Git" header={<PaneHeader icon={LuGitBranch} title="Git"/>}>contingut</Pane></PaneStyleContext.Provider></ChakraProvider>)
export const renderDialog = (material?: any) => renderToStaticMarkup(<ChakraProvider value={buildSystem("agentic")}><Dialog.Root open {...(material ? { material } : {})}><Dialog.Positioner><Dialog.Content>Preferències<Dialog.CloseTrigger asChild><button>x</button></Dialog.CloseTrigger></Dialog.Content></Dialog.Positioner></Dialog.Root></ChakraProvider>)
export const renderTitle = (tone: any) => renderToStaticMarkup(<ChakraProvider value={buildSystem("agentic")}><PaneToneContext.Provider value={tone}><PaneTitle icon={LuGitBranch} title="Historial local" subtitle="src"/></PaneToneContext.Provider></ChakraProvider>)
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
  assert.match(system, /slotRecipes: \{ paneHeader: paneHeaderRecipe, paneToolbar: paneToolbarRecipe, card: paneCardRecipe, dialog: dialogRecipe, floatingPanel: floatingPanelRecipe \}/);
  assert.match(recipes, /slots: \["root", "icon", "title", "subtitle", "actions"\]/);
  assert.match(recipes, /slots: \["root", "field", "action"\]/);
  assert.match(recipes, /brand: \{ root: \{ bg: "transparent" \}, icon: \{ color: "colorPalette\.solid" \}, title: \{ color: "fg" \} \}/);
  assert.match(recipes, /mono: \{ root: \{ bg: "transparent" \}, icon: \{ color: "fg\.muted" \}, title: \{ color: "fg\.muted" \} \}/);
  assert.match(recipes, /tinted: \{ root: \{ bg: "colorPalette\.subtle" \}, icon: \{ color: "colorPalette\.fg" \}, title: \{ color: "colorPalette\.fg" \} \}/);
  // The colour palette is the accent: «agentic», which Preferències points at the chosen palette.
  assert.equal((recipes.match(/root: \{ colorPalette: "agentic",/g) || []).length, 2);
  assert.doesNotMatch(recipes.slice(0, recipes.indexOf('export const paneCardRecipe')), /brand\./, 'the panes follow the accent, not the fixed green');
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
  // «Amb ombra» is Chakra's own elevated card (bg.panel and the md shadow), as in its docs.
  assert.match(recipes, /elevated: \{ root: \{ bg: "bg\.panel", boxShadow: "md" \} \}/);
  assert.deepEqual(chakraCardElevated(), { root: { bg: 'bg.panel', boxShadow: 'md' } });
  assert.match(recipes, /defaultVariants: \{ \.\.\.chakraCard\.defaultVariants, variant: "subtle", size: "pane" \}/);
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  assert.equal((app.match(/<PaneCard[ >]/g) || []).length, 8, 'terminal, the two frames, evaluation, the two columns, the chat, and the preview in Preferències');
  // The chat is a pane like the others: the same card and header (the mark, «Agentic Coder», the model).
  assert.match(app, /<PaneCard label="Agentic Coder" header=\{<PaneHeader icon=\{ChatMark\} title="Agentic Coder" subtitle=\{chatModelLabel\}\/>\}>/);
  assert.doesNotMatch(app, /<Text flex="none" fontSize="xs" fontWeight="semibold">Agentic Coder<\/Text>/, 'no loose label on top of the chat');
  assert.equal((app.match(/borderRadius="panel" overflow="hidden"/g) || []).length, 0, 'no pane draws its own box any more, the chat neither');
  assert.match(app, /const chatPane = \(\n\s*<PaneCard label="Agentic Coder"/);
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

test('every dialog has Chakra’s panel background, from the theme’s dialog recipe', () => {
  const recipes = fs.readFileSync(path.join(__dirname, '..', 'theme', 'pane-recipes.ts'), 'utf8');
  assert.match(recipes, /content: \{ \.\.\.chakraDialog\.base\.content, bg: "bg\.panel", color: "fg", borderWidth: "1px", borderColor: "border"/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'theme', 'system.ts'), 'utf8'), /dialog: dialogRecipe, floatingPanel: floatingPanelRecipe \}/);
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  const contents = app.match(/<Dialog\.Content[^>]*>/g) || [];
  assert.equal(contents.length, 10);
  for (const tag of contents) assert.doesNotMatch(tag, /bg=|borderColor=|boxShadow=/, 'no dialog sets its own background');
  const html = built.renderDialog().replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
  assert.match(html, /chakra-dialog__content/);
});

test('every dialog and the floating Historial local window speak the panes’ language', () => {
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  // Dialogs: the panes' header with the close button, the title kept for screen readers, ghost secondary buttons.
  assert.match(app, /const DialogHeading = [\s\S]*?<Dialog\.Title srOnly>\{title\}<\/Dialog\.Title>\s*<PaneHeader icon=\{icon\} title=\{title\} subtitle=\{subtitle\} actions=\{<Dialog\.CloseTrigger asChild><IconButton icon=\{X\} label="Tanca"\/><\/Dialog\.CloseTrigger>\}\/>/);
  assert.equal((app.match(/<DialogHeading /g) || []).length, 10);
  assert.doesNotMatch(app, /<Dialog\.Header><Dialog\.Title>/);
  for (const title of ['Desa com a cas verificat', 'Edita el cas desat', 'Esborra el cas desat', 'Detall del cas', 'Preferències']) assert.match(app, new RegExp(`<DialogHeading icon=\\{\\w+\\} title="${title}"\\/>`), title);
  const footers = app.match(/<Dialog\.Footer>[\s\S]*?<\/Dialog\.Footer>/g) || [];
  assert.equal(footers.length, 10);
  // Footer buttons are all size sm: the secondary one outlined (visible, not bare text), the main one solid.
  for (const footer of footers) {
    assert.doesNotMatch(footer, /<Button /, 'no xs buttons in a footer');
    assert.match(footer, /<ChakraButton size="sm" variant="outline"/);
  }
  const recipes = fs.readFileSync(path.join(__dirname, '..', 'theme', 'pane-recipes.ts'), 'utf8');
  assert.match(recipes, /header: \{ \.\.\.chakraDialog\.base\.header, p: "0", display: "block" \}/);
  // Historial local: panel background, the panes' title in its bar, plain labels, the selection in brand.
  assert.match(app, /<FloatingPanel\.Content [^>]*\{\.\.\.DIALOG_MATERIALS\[appearance\.dialogs\]\.content\}/);
  assert.match(app, /<WindowTitleBar name="l’historial" stage=\{fileHistoryStage\} icon=\{History\} title="Historial local" subtitle=\{fileHistoryScopePath \|\| project\?\.path \|\| fileHistoryPath \|\| undefined\}\/>/);
  assert.doesNotMatch(app, />CARPETA<|>HISTORIAL DELS FITXERS</);
  assert.match(app, /fileHistoryVersionPath === version\.path \? 'agentic' : 'gray'/);
  assert.match(app, /<ChakraButton size="sm" variant="outline" onClick=\{\(\) => setFileHistoryPath\(null\)\}>Tanca<\/ChakraButton>/);
});

test('the title of a floating window uses the panes’ header recipe, with its tone', () => {
  const html = built.renderTitle('tinted').replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
  assert.match(html, /data-pane-title/);
  assert.match(html, />Historial local</);
  assert.match(html, />src</);
});

test('dialogs are solid or frosted (glaçat): the dialog recipe’s material variant, chosen in Preferències', () => {
  const recipes = fs.readFileSync(path.join(__dirname, '..', 'theme', 'pane-recipes.ts'), 'utf8');
  assert.match(recipes, /solid: \{ content: \{ bg: "bg\.panel", borderColor: "border" \}, backdrop: \{ bg: "blackAlpha\.600" \} \}/);
  assert.match(recipes, /glass: \{ content: \{ bg: "bg\.panel\/80", backdropFilter: "blur\(16px\) saturate\(1\.2\)", borderColor: "border\.subtle" \}, backdrop: \{ bg: "blackAlpha\.400" \} \}/);
  assert.match(recipes, /material: \{\s*solid: \{ content: DIALOG_MATERIALS\.solid\.content, backdrop: DIALOG_MATERIALS\.solid\.backdrop \},\s*glass: \{ content: DIALOG_MATERIALS\.glass\.content, backdrop: DIALOG_MATERIALS\.glass\.backdrop \},/);
  assert.match(recipes, /defaultVariants: \{ \.\.\.chakraDialog\.defaultVariants, material: "glass" \}/);
  // Both render, and give the dialog different styles.
  const solid = built.renderDialog('solid');
  const glass = built.renderDialog('glass');
  assert.match(solid, /chakra-dialog__content/);
  assert.match(glass, /chakra-dialog__content/);
  assert.match(glass, /backdrop-filter:blur\(16px\) saturate\(1\.2\)/);
  assert.doesNotMatch(solid, /backdrop-filter:blur\(16px\)/);
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  assert.equal((app.match(/<Dialog\.Root \{\.\.\.dialogMaterial\} /g) || []).length, 10);
  // The backdrop is the recipe's too: no dialog sets its own.
  assert.equal((app.match(/<Dialog\.Backdrop\/>/g) || []).length, 10);
  assert.doesNotMatch(app, /<Dialog\.Backdrop [^/]/);
  assert.match(app, /const dialogMaterial = \{ material: appearance\.dialogs \} as Record<string, string>;/);
  assert.match(app, /DIALOG_MATERIAL_OPTIONS\.map\(\(material\) => <Box key=\{material\}[^>]*onClick=\{\(\) => setAppearance\(\(current\) => \(\{ \.\.\.current, dialogs: material \}\)\)\}>/);
  assert.match(app, /solid: 'Sòlid', glass: 'Glaçat'/);
});

test('the dialogs’ ✕ is one of the header’s actions, in its flow: not Chakra’s corner button', () => {
  const recipes = fs.readFileSync(path.join(__dirname, '..', 'theme', 'pane-recipes.ts'), 'utf8');
  assert.match(recipes, /closeTrigger: \{ \.\.\.chakraDialog\.base\.closeTrigger, pos: "static", top: "auto", insetEnd: "auto" \}/);
  const html = built.renderDialog('solid');
  const cssClass = /class="chakra-dialog__closeTrigger (css-[a-z0-9]+)"/.exec(html)?.[1];
  assert.ok(cssClass, 'the close button has its recipe class');
  const rule = new RegExp(`\\.${cssClass}\\{([^}]*)\\}`).exec(html)?.[1] || '';
  assert.match(rule, /position:static/);
  assert.doesNotMatch(rule, /position:absolute/);
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  // The same IconButton (xs, ghost, muted) as the panes' + or ↻.
  assert.match(app, /actions=\{<Dialog\.CloseTrigger asChild><IconButton icon=\{X\} label="Tanca"\/><\/Dialog\.CloseTrigger>\}/);
  assert.match(app, /const IconButton = \(\{ icon: Icon, label, \.\.\.props \}: IconButtonProps\) => <Tip label=\{label\}><Button aria-label=\{label\} variant="ghost" size="xs"/);
});

test('the secondary bar: ghost actions, plain/subtle fields, the same small height and an even gap', () => {
  const recipe = fs.readFileSync(path.join(__dirname, '..', 'theme', 'pane-recipes.ts'), 'utf8');
  assert.match(recipe, /root: \{[^}]*gap: "2"/);
  assert.match(recipe, /action: \{[^}]*gap: "2"/);
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  const bars = [...app.matchAll(/<PaneToolbar[\s\S]*?(?:<\/PaneToolbar>|\/>)/g)].map((match) => match[0]);
  assert.equal(bars.length, 4);
  for (const bar of bars) {
    for (const button of bar.match(/<Button\b[^>]*>/g) || []) { assert.match(button, /variant="ghost"/, button); assert.match(button, /size="xs"/, button); }
    for (const select of bar.match(/<NativeSelect\.Root\b[^>]*>/g) || []) assert.match(select, /variant="plain"/, select);
    for (const input of bar.match(/<Input\b[^>]*>/g) || []) assert.match(input, /variant="subtle"/, input);
    assert.doesNotMatch(bar, /variant="(?:solid|outline)"/);
  }
  assert.match(app, /variant="ghost" colorPalette="agentic" disabled=\{loading \|\| chosenCount === 0\}/, 'the benchmark button: ghost, in the accent');
});

test('Converses and Fitxers: their lists scroll inside the pane, and a handle between them sets their widths', () => {
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  for (const name of ['conversationsColumn', 'filesColumn']) {
    const column = app.slice(app.indexOf(`const ${name} = (`), app.indexOf('</PaneCard>', app.indexOf(`const ${name} = (`)));
    assert.match(column, /<Box flex="1" minH="0" \{\.\.\.scrollArea\} scrollbarGutter="stable"/, name);
  }
  // The whole list of the project's conversations, not the first 12: a long list scrolls.
  const conversations = app.slice(app.indexOf('const conversationsColumn = ('), app.indexOf('const filesColumn = ('));
  assert.doesNotMatch(conversations, /\.slice\(0, 12\)/);
  // Each with its own divider, as every pane of the row (src/app/pane-row.tsx).
  assert.match(app, /<PaneRow items=\{topItems\} flexId="chat"/);
  assert.doesNotMatch(app, /templateColumns=\{`repeat\(\$\{navigationColumns\}/, 'no fixed grid of equal columns');
});

test('the editor: Monaco goes edge to edge, only the tabs row has padding and a line under it', () => {
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  const editor = app.slice(app.indexOf('const editorPane = ('), app.indexOf('<Editor\n', app.indexOf('const editorPane = (')));
  assert.match(editor, /<Flex h="full" minH="0" minW="0" direction="column">/);
  assert.doesNotMatch(editor, /direction="column" p="3"/, 'no padding around Monaco');
  assert.match(editor, /<Flex flex="none" align="center" justify="space-between" gap="2" px="3" minW="0" borderBottomWidth="1px" borderColor="border" data-editor-tabs>/);
});

test('every scrolling box shows a thin bar when it overflows: one shared style, the theme’s tokens', () => {
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  assert.doesNotMatch(app, /overflowY="auto"/, 'every scrolling box uses scrollArea');
  assert.ok((app.match(/\{\.\.\.scrollArea\}/g) || []).length >= 10);
  const style = fs.readFileSync(path.join(__dirname, '..', 'theme', 'scroll-area.ts'), 'utf8');
  assert.match(style, /_scrollbarThumb: \{ bg: "border\.emphasized", borderRadius: "full"/);
  assert.doesNotMatch(style, /#[0-9a-f]{3,8}\b/i);
});

test('Preferències: each tab with its icon, in the colour of the panes’ header icons for the tone chosen', () => {
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  for (const [icon, label] of [['Cpu', 'Model'], ['Bot', 'Agent'], ['Brain', 'Aprenentatge'], ['Palette', 'Aparença']]) assert.match(app, new RegExp(`<PaneIcon icon=\\{${icon}\\}/>${label}</Tabs\\.Trigger>`), label);
  const pane = fs.readFileSync(path.join(__dirname, 'pane-header.tsx'), 'utf8');
  assert.match(pane, /export const PaneIcon = [\s\S]*?useSlotRecipe\(\{ recipe: paneHeaderRecipe \}\)\(\{ tone: useContext\(PaneToneContext\) \}\)[\s\S]*?css=\{styles\.icon\}/);
});

test('no pane body paints its own background: the card’s own (and its shadow’s light inner edge) shows round every pane', () => {
  const app = fs.readFileSync(path.join(__dirname, 'App.tsx'), 'utf8');
  for (const name of ['browserPane', 'editorPane', 'consolePane', 'gitPane', 'learningPane']) {
    const start = app.indexOf(`const ${name} = (`);
    assert.ok(start > -1, name);
    const head = app.slice(start, app.indexOf('\n', app.indexOf('\n', start) + 1));
    assert.doesNotMatch(head, /bg="bg"|bg=\{paneSurface\}/, name);
  }
  assert.doesNotMatch(app, /<Box ref=\{setTerminalContainer\}[^>]*bg=/, 'the terminal neither: xterm paints the same colour as its card');
});
