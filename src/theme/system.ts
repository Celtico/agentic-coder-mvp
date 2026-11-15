import { createSystem, defaultConfig, defineConfig, type SystemStyleObject } from "@chakra-ui/react"
import { accentSemantic, accentTokens, brandSemantic, BRAND_TOKENS, type Accent } from "./accent"
import { accordionRecipe, dialogRecipe, floatingPanelRecipe, paneCardRecipe, paneHeaderRecipe, paneToolbarRecipe } from "./pane-recipes"

// Tema de l'aplicació: els components Chakra consumeixen aquests colors semàntics.
// The accent (Preferències) decides which palette «agentic» is (src/theme/accent.ts).
export const buildSystem = (accent: Accent = "agentic") => createSystem(defaultConfig, defineConfig({
  globalCss: {
    "html, body, #root": { height: "100%", width: "100%", margin: 0, overflow: "hidden" },
    // Colours, fonts, box sizing… are Chakra's own (its globalCss and preflight); only the app's layout here.
    "webview": { display: "flex" },
    // Fons general «Translúcid» (src/app/App.tsx): nothing paints over the window's vibrancy.
    "html[data-translucent], html[data-translucent] body": { bg: "transparent" },
    // The app's own title bar on macOS: the part marked data-drag-region moves the window.
    // (an Electron property, not in Chakra's style types).
    "[data-drag-region]": { WebkitAppRegion: "drag" } as unknown as SystemStyleObject,
  },
  theme: {
    // Every pane's header and second row, with the tone chosen in Preferències (src/theme/pane-recipes.ts).
    slotRecipes: { paneHeader: paneHeaderRecipe, paneToolbar: paneToolbarRecipe, card: paneCardRecipe, dialog: dialogRecipe, floatingPanel: floatingPanelRecipe, accordion: accordionRecipe },
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
    },
    textStyles: {
      chatMessage: {
        value: { fontSize: "sm", lineHeight: "1.7" },
      },
    },
    semanticTokens: {
      colors: {
        brand: brandSemantic("brand"),
        agentic: accentSemantic(accent),
        // The window is a canvas; every pane is a rounded panel resting on it (dark by default; light
        // when chosen in Preferències).
        // Chakra's own bg values (white / black), as in its docs: the panels (bg.panel: white / gray.950) rest
        // on it. Written as the colours, not as {colors.bg}, so «Fons de les finestres» (which re-points bg)
        // never changes the window itself.
        canvas: { value: { _light: "{colors.white}", _dark: "{colors.black}" } },
        // bg, fg and border (and their members: bg.subtle, bg.muted, fg.muted, border.subtle…) are Chakra's own,
        // untouched, as in its docs; Preferències › Aparença › Fons de les finestres chooses among the bg ones.
        accent: { value: "{colors.agentic.500}" },
        // The traffic lights of a floating window, like macOS (src/app/window-controls.tsx).
        // Chakra's red, yellow and green, as macOS's lights.
        "window.close": { value: "{colors.red.500}" },
        "window.minimize": { value: "{colors.yellow.400}" },
        "window.maximize": { value: "{colors.green.500}" },
        "window.lightBorder": { value: "{colors.blackAlpha.200}" },
        "window.lightGlyph": { value: "{colors.blackAlpha.700}" },
      },
    },
  },
}))

export const system = buildSystem()
