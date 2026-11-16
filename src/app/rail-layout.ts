// The icons of the left bar that open a pane, in two groups, like the tool windows of an IDE: the
// panes of the top group open in the top row of the work area (beside the chat), those of the bottom
// group in the bottom row (the dock). An icon dragged to the other group takes its pane to the other
// row, and the order of the icons is the order of the panes in their row.
// The editor has no icon (it opens from a file in Fitxers) and is always the first pane of the top row.
// Ids that are no longer icons (the editor, «new chat») are dropped from a saved layout.

// Converses and Fitxers are panes too: with their icons in the top group they are the columns of the
// side panel (beside the chat), in the bottom group they are panes of the bottom row, like the others.
export type SideColumn = "conversations" | "files"
// The chat is a pane too: last on top by default (where it always was), and it can be hidden or moved like the others.
export type RailPanel = SideColumn | "browser" | "evaluation" | "chat" | "console" | "terminal" | "git" | "learning" | "llmlog"
export const SIDE_COLUMNS: SideColumn[] = ["conversations", "files"]
export const isSideColumn = (panel: string): panel is SideColumn => (SIDE_COLUMNS as string[]).includes(panel)
/** A pane: one with an icon in the bar, or the editor (which has none and is always first on top). */
export type Pane = RailPanel | "editor"
export type RailGroup = "top" | "bottom"
export type RailLayout = Record<RailGroup, RailPanel[]>

export const RAIL_PANELS: RailPanel[] = ["conversations", "files", "browser", "evaluation", "chat", "console", "terminal", "git", "learning", "llmlog"]
const DEFAULT_GROUP: Record<RailPanel, RailGroup> = { conversations: "top", files: "top", browser: "top", evaluation: "top", chat: "top", console: "bottom", terminal: "bottom", git: "bottom", learning: "bottom", llmlog: "bottom" }

export const defaultRailLayout = (): RailLayout => ({
  top: RAIL_PANELS.filter((panel) => DEFAULT_GROUP[panel] === "top"),
  bottom: RAIL_PANELS.filter((panel) => DEFAULT_GROUP[panel] === "bottom"),
})

const isPanel = (value: unknown): value is RailPanel => typeof value === "string" && (RAIL_PANELS as string[]).includes(value)

/**
 * A saved layout made safe: unknown ids and repeated ones are dropped, and a pane it does not name
 * (one added by a newer version) is put at the end of its default group.
 */
export function normalizeRailLayout(value: unknown): RailLayout {
  const saved = value && typeof value === "object" ? value as Partial<Record<RailGroup, unknown>> : {}
  const seen = new Set<RailPanel>()
  const layout: RailLayout = { top: [], bottom: [] }
  for (const group of ["top", "bottom"] as RailGroup[]) {
    const list = Array.isArray(saved[group]) ? saved[group] as unknown[] : []
    for (const item of list) if (isPanel(item) && !seen.has(item)) { seen.add(item); layout[group].push(item) }
  }
  // The side columns' icons, when a saved layout does not have them yet, go first on top, under the mark.
  const missingColumns = SIDE_COLUMNS.filter((panel) => !seen.has(panel))
  layout.top.unshift(...missingColumns)
  for (const panel of missingColumns) seen.add(panel)
  for (const panel of RAIL_PANELS) if (!seen.has(panel)) layout[DEFAULT_GROUP[panel]].push(panel)
  return layout
}

export function railGroupOf(layout: RailLayout, panel: RailPanel): RailGroup {
  return layout.bottom.includes(panel) ? "bottom" : "top"
}

/**
 * Moves a pane to `group`, before the icon now at `index` of that group (as the group is shown
 * while dragging, with the dragged icon still in it); an index past the end puts it last.
 */
export function moveRailPanel(layout: RailLayout, panel: RailPanel, group: RailGroup, index: number): RailLayout {
  const current = normalizeRailLayout(layout)
  const from = railGroupOf(current, panel)
  const fromIndex = current[from].indexOf(panel)
  let target = Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : current[group].length, current[group].length))
  if (from === group && fromIndex < target) target -= 1
  const next: RailLayout = { top: current.top.filter((item) => item !== panel), bottom: current.bottom.filter((item) => item !== panel) }
  next[group].splice(target, 0, panel)
  return next
}

/**
 * The open panes of one row, in the order of their icons. The top row starts with the editor and leaves
 * out Converses and Fitxers (on top they are the side panel's columns, see sideColumnsShown); the bottom
 * row has them like any other pane.
 */
export function panelsInRow(layout: RailLayout, group: RailGroup, isOpen: (panel: Pane) => boolean): Pane[] {
  const panes: Pane[] = normalizeRailLayout(layout)[group]
  return (group === "top" ? ["editor" as Pane, ...panes.filter((panel) => !isSideColumn(panel))] : panes).filter(isOpen)
}

/** The side panel's columns: Converses and Fitxers while their icons are on top and they are shown, in that order. */
export function sideColumnsShown(layout: RailLayout, isOpen: (panel: SideColumn) => boolean): SideColumn[] {
  return normalizeRailLayout(layout).top.filter((panel): panel is SideColumn => isSideColumn(panel) && isOpen(panel))
}

export const sameRailLayout = (a: RailLayout, b: RailLayout) => a.top.join() === b.top.join() && a.bottom.join() === b.bottom.join()
