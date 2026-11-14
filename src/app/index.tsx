import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Provider } from "../components/ui/provider"
import { App } from "./App"
import { loadViewState } from "./view-state"
import { applyColorMode } from "./color-mode"
import { resolveColorMode } from "./preferences"

const root = document.getElementById("root")
if (!root) throw new Error("No s’ha trobat el contenidor de l’app.")

// The mode chosen in Preferències (dark unless changed) is set before the first paint; Chakra reads it
// from the class of <html>, not only from the browser's colour scheme.
const { appearance } = loadViewState(localStorage)
applyColorMode(resolveColorMode(appearance.colorMode, window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true))

createRoot(root).render(
  <StrictMode>
    <Provider initialAccent={appearance.accent}>
      <App />
    </Provider>
  </StrictMode>,
)
