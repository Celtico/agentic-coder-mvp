// The rows of panes work like an IDE's: every pane of a row has its own width, in pixels, kept between
// launches (per pane id, in the view state), and one pane of the row is flexible and takes what is left:
// the chat in the top row, the last pane in the bottom one. The divider on the right of a pane changes
// that pane's width only: the panes after it keep theirs and move along, and the flexible pane takes the
// difference. When the flexible pane is at its narrowest, the divider goes no further.

/** A pane's id in a row: «nav-…» the side columns, «side-…» the panes of the top group, «dock-…» the bottom row, «chat». */
export const ROW_PANE_ID = /^(?:(?:nav|side|dock)-[a-z]{1,40}|chat)$/

/** Narrowest a pane may be, in pixels: the side columns 160, the chat 320, any other pane 220. */
export function paneMinWidth(id: string): number {
  if (id.startsWith("nav-")) return 160
  if (id === "chat") return 320
  return 220
}

/** The width a pane has the first time it is shown, before it has one of its own. */
export function defaultPaneWidth(id: string): number {
  if (id.startsWith("nav-")) return 240
  if (id.startsWith("dock-")) return 380
  return 420
}

/** A pane's width: its own, or its default, never under its minimum. */
export function paneWidth(id: string, widths: Record<string, number>): number {
  const own = widths[id]
  return Math.max(paneMinWidth(id), Number.isFinite(own) && own > 0 ? own : defaultPaneWidth(id))
}

/**
 * The width a pane takes while its divider is dragged `delta` pixels from where it started (`start`):
 * never under its minimum, and never more than the flexible pane can give (down to its own minimum).
 */
export function draggedPaneWidth({ id, start, delta, flexWidth, flexMin }: { id: string; start: number; delta: number; flexWidth: number; flexMin: number }): number {
  const most = start + Math.max(0, flexWidth - flexMin)
  return Math.round(Math.max(paneMinWidth(id), Math.min(start + delta, most)))
}

/** The widths after one pane is resized: that pane's changes, every other pane keeps its own. */
export function withPaneWidth(widths: Record<string, number>, id: string, width: number): Record<string, number> {
  if (!ROW_PANE_ID.test(id) || id === "chat" || !Number.isFinite(width)) return widths
  return { ...widths, [id]: Math.round(Math.max(paneMinWidth(id), Math.min(width, 4000))) }
}

/** Saved widths made safe: only pane ids, only widths between their minimum and 4000 px. */
export function normalizePaneWidths(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, number] => ROW_PANE_ID.test(entry[0]) && entry[0] !== "chat" && typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= paneMinWidth(entry[0]) && entry[1] <= 4000))
}
