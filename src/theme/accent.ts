// The accent of the app. Every component uses the «agentic» palette (colorPalette="agentic", agentic.fg,
// agentic.solid…); choosing another accent points that palette at one of Chakra's own, so the whole app
// changes without touching a component. «agentic» is the app's own green, kept as «brand».

import { defaultConfig } from "@chakra-ui/react"

export const ACCENTS = ["agentic", "gray", "red", "orange", "yellow", "green", "teal", "blue", "cyan", "purple", "pink"] as const
export type Accent = (typeof ACCENTS)[number]
export const isAccent = (value: unknown): value is Accent => typeof value === "string" && (ACCENTS as readonly string[]).includes(value)

type Token = { value: string | Record<string, string> }
const SHADES = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"] as const

export const BRAND_TOKENS: Record<string, { value: string }> = {
  50: { value: "#e6fff6" }, 100: { value: "#c5f7e5" }, 200: { value: "#91e9ca" },
  300: { value: "#65c9ad" }, 400: { value: "#28b891" }, 500: { value: "#10a37f" },
  600: { value: "#078565" }, 700: { value: "#08694f" }, 800: { value: "#09543f" },
  900: { value: "#094534" }, 950: { value: "#04271d" },
}

/** The semantic tokens of a palette built on `name`'s shades, as the app has always used them for its green. */
export const brandSemantic = (name: string): Record<string, Token> => ({
  solid: { value: `{colors.${name}.500}` },
  contrast: { value: "white" },
  fg: { value: { _light: `{colors.${name}.700}`, _dark: `{colors.${name}.200}` } },
  muted: { value: { _light: `{colors.${name}.100}`, _dark: `{colors.${name}.900}` } },
  subtle: { value: { _light: `{colors.${name}.50}`, _dark: `{colors.${name}.950}` } },
  emphasized: { value: { _light: `{colors.${name}.200}`, _dark: `{colors.${name}.800}` } },
  focusRing: { value: `{colors.${name}.500}` },
  border: { value: `{colors.${name}.500}` },
})

const chakraColors = () => (defaultConfig.theme?.tokens?.colors ?? {}) as unknown as Record<string, Record<string, { value: string }>>
const chakraSemantic = () => (defaultConfig.theme?.semanticTokens?.colors ?? {}) as unknown as Record<string, Record<string, Token>>

/** The shades the «agentic» palette takes for an accent. */
export function accentTokens(accent: Accent): Record<string, { value: string }> {
  if (accent === "agentic") return { ...BRAND_TOKENS }
  const palette = chakraColors()[accent] ?? {}
  return Object.fromEntries(SHADES.filter((shade) => palette[shade]).map((shade) => [shade, { value: palette[shade].value }]))
}

/** The semantic tokens («agentic.solid», «agentic.fg»…) for an accent: the app's own, or Chakra's for that palette. */
export function accentSemantic(accent: Accent): Record<string, Token> {
  if (accent === "agentic") return brandSemantic("agentic")
  const palette = chakraSemantic()[accent] ?? {}
  return Object.fromEntries(Object.entries(palette).map(([key, token]) => [key, { value: token.value }]))
}
