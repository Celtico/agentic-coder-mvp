import { createContext, useContext, useMemo, useState, type ReactNode } from "react"
import { ChakraProvider } from "@chakra-ui/react"
import { buildSystem } from "../../theme/system"
import type { Accent } from "../../theme/accent"

/** Changes the accent of the whole app at once: the theme is built again with «agentic» on that palette. */
const AccentContext = createContext<(accent: Accent) => void>(() => {})
export const useSetAccent = () => useContext(AccentContext)

export function Provider({ children, initialAccent = "agentic" }: { children: ReactNode; initialAccent?: Accent }) {
  const [accent, setAccent] = useState<Accent>(initialAccent)
  const system = useMemo(() => buildSystem(accent), [accent])
  return <AccentContext.Provider value={setAccent}><ChakraProvider value={system}>{children}</ChakraProvider></AccentContext.Provider>
}
