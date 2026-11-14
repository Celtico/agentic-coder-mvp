// The appearance of the app, chosen in Preferències and kept with the rest of the view state
// (src/app/view-state.ts): light, dark or as the system; the size of the chat and editor text; and the
// accent colour (src/theme/accent.ts).

import { isAccent, type Accent } from "../theme/accent"
import type { PaneHeaderTone, PaneStyle } from "./pane-header"

export type ColorMode = "light" | "dark" | "system"
export const COLOR_MODES: ColorMode[] = ["light", "dark", "system"]
/** Chat text sizes are steps of the theme's font sizes. */
export const CHAT_FONT_SIZES = ["xs", "sm", "md", "lg"] as const
export type ChatFontSize = (typeof CHAT_FONT_SIZES)[number]
export const EDITOR_FONT_SIZES = [10, 11, 12, 13, 14, 16, 18] as const

/** How the panes' headers look (src/app/pane-header.tsx). */
export const PANE_TONES: PaneHeaderTone[] = ["brand", "mono", "tinted"]
/** How the panes themselves look: Chakra's Card variants (src/theme/pane-recipes.ts). */
export const PANE_STYLES: PaneStyle[] = ["subtle", "outline", "elevated"]

export type Appearance = { colorMode: ColorMode; chatFontSize: ChatFontSize; editorFontSize: number; accent: Accent; paneTone: PaneHeaderTone; paneStyle: PaneStyle }

/** As the app looked before there were preferences. */
export const defaultAppearance = (): Appearance => ({ colorMode: "dark", chatFontSize: "sm", editorFontSize: 11, accent: "agentic", paneTone: "brand", paneStyle: "subtle" })

export function normalizeAppearance(value: unknown): Appearance {
  const saved = value && typeof value === "object" ? value as Record<string, unknown> : {}
  const result = defaultAppearance()
  if (COLOR_MODES.includes(saved.colorMode as ColorMode)) result.colorMode = saved.colorMode as ColorMode
  if ((CHAT_FONT_SIZES as readonly string[]).includes(saved.chatFontSize as string)) result.chatFontSize = saved.chatFontSize as ChatFontSize
  if ((EDITOR_FONT_SIZES as readonly number[]).includes(saved.editorFontSize as number)) result.editorFontSize = saved.editorFontSize as number
  if (isAccent(saved.accent)) result.accent = saved.accent
  if (PANE_TONES.includes(saved.paneTone as PaneHeaderTone)) result.paneTone = saved.paneTone as PaneHeaderTone
  if (PANE_STYLES.includes(saved.paneStyle as PaneStyle)) result.paneStyle = saved.paneStyle as PaneStyle
  return result
}

/** The mode actually shown: «system» follows the operating system. */
export const resolveColorMode = (mode: ColorMode, systemPrefersDark: boolean): "light" | "dark" => mode === "system" ? (systemPrefersDark ? "dark" : "light") : mode

/** One step bigger or smaller in a list of sizes, staying inside it. */
export function stepSize<T>(sizes: readonly T[], current: T, direction: 1 | -1): T {
  const index = sizes.indexOf(current)
  const next = Math.min(sizes.length - 1, Math.max(0, (index < 0 ? 0 : index) + direction))
  return sizes[next]
}
