import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Provider } from "../components/ui/provider"
import { App } from "./App"

const root = document.getElementById("root")
if (!root) throw new Error("No s’ha trobat el contenidor de l’app.")

// La interfície usa sempre el mode fosc; Chakra també ha de conèixer el mode,
// no n'hi ha prou amb posar `color-scheme: dark` al CSS del navegador.
document.documentElement.classList.add("dark")

createRoot(root).render(
  <StrictMode>
    <Provider>
      <App />
    </Provider>
  </StrictMode>,
)
