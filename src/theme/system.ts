import { createSystem, defaultConfig, defineConfig, type SystemStyleObject } from "@chakra-ui/react"
import { accentSemantic, accentTokens, brandSemantic, BRAND_TOKENS, type Accent } from "./accent"
import { dialogRecipe, paneCardRecipe, paneHeaderRecipe, paneToolbarRecipe } from "./pane-recipes"

// Tema de l'aplicació: els components Chakra consumeixen aquests colors semàntics.
// The accent (Preferències) decides which palette «agentic» is (src/theme/accent.ts).
export const buildSystem = (accent: Accent = "agentic") => createSystem(defaultConfig, defineConfig({
  globalCss: {
    "html, body, #root": { height: "100%", width: "100%", margin: 0, overflow: "hidden" },
    html: { colorScheme: "light", "&.dark": { colorScheme: "dark" } },
    body: { minHeight: "100dvh", bg: "bg", color: "fg", fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" },
    "*, *::before, *::after": { boxSizing: "border-box" },
    "button, input, textarea": { font: "inherit" },
    "input, textarea, [contenteditable=true]": { cursor: "text" },
    "button, [role=button], a[href]": { cursor: "pointer" },
    // Els botons neutres de Chakra prenen el color de text de l'app, en mode clar i fosc.
    '.chakra-button[data-variant="outline"], .chakra-button[data-variant="ghost"]': { color: "fg" },
    "webview": { display: "flex" },
    // The app's own title bar on macOS: the part marked data-drag-region moves the window.
    // (an Electron property, not in Chakra's style types).
    "[data-drag-region]": { WebkitAppRegion: "drag" } as unknown as SystemStyleObject,
  },
  theme: {
    // Every pane's header and second row, with the tone chosen in Preferències (src/theme/pane-recipes.ts).
    slotRecipes: { paneHeader: paneHeaderRecipe, paneToolbar: paneToolbarRecipe, card: paneCardRecipe, dialog: dialogRecipe },
    // The mark turns and breathes while the model works (src/app/App.tsx, Mark).
    keyframes: {
      agenticTurn: { to: { transform: "rotate(360deg)" } },
      agenticBreathe: { "0%, 100%": { opacity: 0.45 }, "50%": { opacity: 1 } },
      agenticBeat: { "0%, 100%": { transform: "scale(.55)" }, "50%": { transform: "scale(1.15)" } },
    },
    tokens: {
      colors: {
        brand: BRAND_TOKENS,
        agentic: accentTokens(accent),
      },
      // Every panel of the window (columns, the Converses and Fitxers boxes, the evaluation cards).
      radii: {
        panel: { value: "10px" },
      },
      // A floating window's title bar is a thin macOS one: 28 px high, with the traffic lights 12 px
      // round, 8 px apart and 12 px in from the edge, centred in the bar (src/app/window-controls.tsx).
      sizes: {
        windowTitleBar: { value: "28px" },
        // The app's own title bar on macOS (App.tsx, data-drag-region); floating windows stay below it.
        appTitleBar: { value: "36px" },
        windowLight: { value: "12px" },
        windowLights: { value: "52px" },
      },
      spacing: {
        windowLightGap: { value: "8px" },
        windowLightInset: { value: "12px" },
      },
      shadows: {
        composer: { value: "0 4px 24px #0002" },
      },
    },
    textStyles: {
      chatMessage: {
        value: { fontSize: "sm", lineHeight: "1.7" },
      },
      interface: {
        value: { fontSize: "sm", lineHeight: "1.45" },
      },
      caption: {
        value: { fontSize: "xs", lineHeight: "1.35" },
      },
    },
    semanticTokens: {
      colors: {
        brand: brandSemantic("brand"),
        agentic: accentSemantic(accent),
        // The window is a canvas; every pane is a rounded panel resting on it (dark by default; light
        // when chosen in Preferències).
        canvas: { value: { _light: "#f2f2f2", _dark: "#171717" } },
        bg: { value: { _light: "#ffffff", _dark: "#212121" } },
        fg: { value: { _light: "#1f1f1f", _dark: "#ececec" } },
        "fg.muted": { value: { _light: "#5e5e5e", _dark: "#a1a1a1" } },
        surface: { value: { _light: "#ececec", _dark: "#303030" } },
        "surface.subtle": { value: { _light: "#f2f2f2", _dark: "#171717" } },
        border: { value: { _light: "#dcdcdc", _dark: "#393939" } },
        accent: { value: "{colors.agentic.500}" },
        // The traffic lights of a floating window, like macOS (src/app/window-controls.tsx).
        "window.close": { value: "#ff5f57" },
        "window.minimize": { value: "#febc2e" },
        "window.maximize": { value: "#28c840" },
        "window.lightBorder": { value: "#0000001f" },
        "window.lightGlyph": { value: "#00000099" },
      },
    },
  },
}))

export const system = buildSystem()
