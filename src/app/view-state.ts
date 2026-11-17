// What the app looked like when it was closed, so it opens the same way: which panels were open
// (the editor opens again with its file, so it is kept per project),
// the appearance chosen in Preferències (src/app/preferences.ts), the order and group of the icons of the left bar (src/app/rail-layout.ts), the open sections of the evaluation, the local history window (where, how big, minimized or big)
// and, per project, the page in the browser, the files open in the editor (its tabs, and the one in
// front if the editor was open) and the history that was open.
// Kept in localStorage, like the other sizes of the window.

import type { WindowStage } from "./window-controls"
import { defaultRailLayout, normalizeRailLayout, type RailLayout } from "./rail-layout"
import { defaultAppearance, normalizeAppearance, type Appearance } from "./preferences"
import { normalizePaneWidths } from "./row-sizes"

export const VIEW_STATE_KEY = "agentic-view-state-v1"

// «navigation» is from before the side panel had two columns; it is read but no longer decides anything.
export type PanelName = "navigation" | "conversations" | "files" | "browser" | "evaluation" | "chat" | "git" | "learning" | "llmlog" | "console" | "terminal"
export type Panels = Record<PanelName, boolean>
export type ProjectView = { browserUrl?: string; editorPath?: string; editorTabs?: string[]; historyPath?: string }
export type ViewState = {
  panels: Panels
  rail: RailLayout
  appearance: Appearance
  evaluationSections: string[]
  /** The open sections of the Aprenentatge local panel. */
  learningSections: string[]
  history: { position?: { x: number; y: number }; size?: { width: number; height: number }; stage: WindowStage }
  /** Each pane's own width in its row, in pixels, by pane id (src/app/row-sizes.ts). */
  paneWidths: Record<string, number>
  projects: Record<string, ProjectView>
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">

const PANELS: PanelName[] = ["navigation", "conversations", "files", "browser", "evaluation", "chat", "git", "learning", "llmlog", "console", "terminal"]

export const defaultViewState = (): ViewState => ({
  panels: { navigation: true, conversations: true, files: true, browser: false, evaluation: false, chat: true, git: false, learning: false, llmlog: false, console: false, terminal: false },
  rail: defaultRailLayout(),
  appearance: defaultAppearance(),
  evaluationSections: [],
  learningSections: ["cases", "training"],
  history: { stage: "default" },
  paneWidths: {},
  projects: {},
})

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const text = (value: unknown) => (typeof value === "string" && value ? value : undefined)

/** Only web pages are reopened, never a file:// or about: address. */
export const reopenableUrl = (value: unknown) => {
  const url = text(value)
  return url && /^https?:\/\//i.test(url) ? url : undefined
}

type Rect = { x: number; y: number; width: number; height: number }

/**
 * Puts a floating window inside the area it may use (the app below its title bar): never above its
 * top, nor past its sides or bottom, and never bigger than the area itself.
 */
export function clampWindowRect(rect: Rect, area: Rect): Rect {
  const width = Math.min(rect.width, area.width)
  const height = Math.min(rect.height, area.height)
  const x = Math.min(Math.max(rect.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(rect.y, area.y), area.y + area.height - height)
  return { x, y, width, height }
}

/** Reads the saved state; whatever is missing or broken takes its default. */
export function loadViewState(storage: Storage): ViewState {
  const state = defaultViewState()
  let saved: any
  try { saved = JSON.parse(storage.getItem(VIEW_STATE_KEY) || "null") } catch { return state }
  if (!saved || typeof saved !== "object") return state
  for (const name of PANELS) if (typeof saved.panels?.[name] === "boolean") state.panels[name] = saved.panels[name]
  state.rail = normalizeRailLayout(saved.rail)
  state.appearance = normalizeAppearance(saved.appearance)
  state.paneWidths = normalizePaneWidths(saved.paneWidths)
  if (Array.isArray(saved.learningSections)) state.learningSections = saved.learningSections.filter((item: unknown): item is string => typeof item === "string" && ["cases", "manual", "imports", "training", "models"].includes(item))
  if (Array.isArray(saved.evaluationSections)) state.evaluationSections = saved.evaluationSections.filter((item: unknown): item is string => typeof item === "string")
  const history = saved.history || {}
  if (isNumber(history.position?.x) && isNumber(history.position?.y)) state.history.position = { x: history.position.x, y: history.position.y }
  if (isNumber(history.size?.width) && isNumber(history.size?.height) && history.size.width > 0 && history.size.height > 0) state.history.size = { width: history.size.width, height: history.size.height }
  if (["default", "minimized", "maximized"].includes(history.stage)) state.history.stage = history.stage
  if (saved.projects && typeof saved.projects === "object") {
    for (const [project, view] of Object.entries<any>(saved.projects)) {
      if (!view || typeof view !== "object") continue
      const tabs = Array.isArray(view.editorTabs) ? view.editorTabs.filter((tab: unknown): tab is string => typeof tab === "string" && tab.length > 0) : []
      const entry: ProjectView = { browserUrl: reopenableUrl(view.browserUrl), editorPath: text(view.editorPath), editorTabs: tabs.length ? tabs : undefined, historyPath: typeof view.historyPath === "string" ? view.historyPath : undefined }
      state.projects[project] = Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined))
    }
  }
  return state
}

export function saveViewState(storage: Storage, state: ViewState) {
  try { storage.setItem(VIEW_STATE_KEY, JSON.stringify(state)) } catch { /* only a convenience */ }
}

/** Changes part of the saved state and writes it, keeping everything else as it was. */
export function updateViewState(storage: Storage, change: (state: ViewState) => void) {
  const state = loadViewState(storage)
  change(state)
  saveViewState(storage, state)
  return state
}

/** Sets what a project had open; an empty value is forgotten. */
export function setProjectView(state: ViewState, projectPath: string, view: ProjectView) {
  const entry: ProjectView = {}
  const url = reopenableUrl(view.browserUrl)
  if (url) entry.browserUrl = url
  if (view.editorPath) entry.editorPath = view.editorPath
  if (view.editorTabs?.length) entry.editorTabs = view.editorTabs
  if (typeof view.historyPath === "string") entry.historyPath = view.historyPath
  if (Object.keys(entry).length) state.projects[projectPath] = entry
  else delete state.projects[projectPath]
}
