import { createSystem, defaultConfig, defineConfig, type SystemStyleObject } from "@chakra-ui/react"

// Tema de l'aplicació: els components Chakra consumeixen aquests colors semàntics.
export const system = createSystem(defaultConfig, defineConfig({
  globalCss: {
    "html, body, #root": { height: "100%", width: "100%", margin: 0, overflow: "hidden" },
    html: { colorScheme: "dark" },
    body: { minHeight: "100dvh", bg: "bg", color: "fg", fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" },
    "*, *::before, *::after": { boxSizing: "border-box" },
    "button, input, textarea": { font: "inherit" },
    "input, textarea, [contenteditable=true]": { cursor: "text" },
    "button, [role=button], a[href]": { cursor: "pointer" },
    // El MVP és sempre fosc: els botons neutres de Chakra no han d'agafar el
    // gris fosc del mode clar per damunt del fons fosc.
    '.chakra-button[data-variant="outline"], .chakra-button[data-variant="ghost"]': { color: "fg" },
    "webview": { display: "flex" },
    // The app's own title bar on macOS: the part marked data-drag-region moves the window.
    // (an Electron property, not in Chakra's style types).
    "[data-drag-region]": { WebkitAppRegion: "drag" } as unknown as SystemStyleObject,
  },
  theme: {
    // The mark turns and breathes while the model works (src/app/App.tsx, Mark).
    keyframes: {
      agenticTurn: { to: { transform: "rotate(360deg)" } },
      agenticBreathe: { "0%, 100%": { opacity: 0.45 }, "50%": { opacity: 1 } },
      agenticBeat: { "0%, 100%": { transform: "scale(.55)" }, "50%": { transform: "scale(1.15)" } },
    },
    tokens: {
      colors: {
        agentic: {
          50: { value: "#e6fff6" }, 100: { value: "#c5f7e5" }, 200: { value: "#91e9ca" },
          300: { value: "#65c9ad" }, 400: { value: "#28b891" }, 500: { value: "#10a37f" },
          600: { value: "#078565" }, 700: { value: "#08694f" }, 800: { value: "#09543f" },
          900: { value: "#094534" }, 950: { value: "#04271d" },
        },
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
        agentic: {
          solid: { value: "{colors.agentic.500}" },
          contrast: { value: "white" },
          fg: { value: { _light: "{colors.agentic.700}", _dark: "{colors.agentic.200}" } },
          muted: { value: { _light: "{colors.agentic.100}", _dark: "{colors.agentic.900}" } },
          subtle: { value: { _light: "{colors.agentic.50}", _dark: "{colors.agentic.950}" } },
          emphasized: { value: { _light: "{colors.agentic.200}", _dark: "{colors.agentic.800}" } },
          focusRing: { value: "{colors.agentic.500}" },
        },
        // The window is a dark canvas; every pane is a rounded panel resting on it.
        canvas: { value: "#171717" },
        bg: { value: "#212121" },
        fg: { value: "#ececec" },
        "fg.muted": { value: "#a1a1a1" },
        surface: { value: "#303030" },
        "surface.subtle": { value: "#171717" },
        border: { value: "#393939" },
        accent: { value: "{colors.agentic.500}" },
      },
    },
  },
}))
