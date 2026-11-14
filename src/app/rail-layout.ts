// The icons of the left bar that open a pane, in two groups, like the tool windows of an IDE: the
// panes of the top group open in the top row of the work area (beside the chat), those of the bottom
// group in the bottom row (the dock). An icon dragged to the other group takes its pane to the other
// row, and the order of the icons is the order of the panes in their row.
// The toggle of the conversations and files column and «new chat» are not panes and stay at the top.

export type RailPanel = "editor" | "browser" | "evaluation" | "console" | "terminal" | "git" | "learning"
export type RailGroup = "top" | "bottom"
export type RailLayout = Record<RailGroup, RailPanel[]>

export const RAIL_PANELS: RailPanel[] = ["editor", "browser", "evaluation", "console", "terminal", "git", "learning"]
const DEFAULT_GROUP: Record<RailPanel, RailGroup> = { editor: "top", browser: "top", evaluation: "top", console: "bottom", terminal: "bottom", git: "bottom", learning: "bottom" }

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

/** The open panes of one row, in the order of their icons. */
export function panelsInRow(layout: RailLayout, group: RailGroup, isOpen: (panel: RailPanel) => boolean): RailPanel[] {
  return normalizeRailLayout(layout)[group].filter(isOpen)
}

export const sameRailLayout = (a: RailLayout, b: RailLayout) => a.top.join() === b.top.join() && a.bottom.join() === b.bottom.join()
