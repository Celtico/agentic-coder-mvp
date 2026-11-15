// The rows of panes: every pane of a row has its own width, in pixels, kept between launches (per pane
// id, in the view state), and one pane of the row is flexible and takes what is left: the chat in the top
// row, the last pane in the bottom one. A divider changes only the two panes beside it, one wider and the
// other narrower by as much: no other pane moves or changes. When the pane on its right is the flexible
// one, that one takes the difference. Neither pane goes under its minimum.

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

/**
 * The two widths while the divider between `left` and `right` is dragged `delta` pixels: the left one
 * grows by as much as the right one shrinks, both within their minimums. With `right` the flexible pane,
 * only the left one gets a width (the flexible one takes what is left, as before).
 */
export function draggedPair({ left, right, startLeft, startRight, delta, rightIsFlex, flexMin }: { left: string; right: string; startLeft: number; startRight: number; delta: number; rightIsFlex: boolean; flexMin: number }): Record<string, number> {
  const rightMin = rightIsFlex ? flexMin : paneMinWidth(right)
  const moved = Math.round(Math.max(paneMinWidth(left) - startLeft, Math.min(delta, startRight - rightMin)))
  return rightIsFlex ? { [left]: startLeft + Math.max(moved, paneMinWidth(left) - startLeft) } : { [left]: startLeft + moved, [right]: startRight - moved }
}

/** The widths after one pane is resized: that pane's changes, every other pane keeps its own. */
export function withPaneWidth(widths: Record<string, number>, id: string, width: number): Record<string, number> {
  if (!ROW_PANE_ID.test(id) || id === "chat" || !Number.isFinite(width)) return widths
  return { ...widths, [id]: Math.round(Math.max(paneMinWidth(id), Math.min(width, 4000))) }
}

/** The widths after several panes are resized at once (the two beside a divider). */
export function withPaneWidths(widths: Record<string, number>, changes: Record<string, number>): Record<string, number> {
  return Object.entries(changes).reduce((next, [id, width]) => withPaneWidth(next, id, width), widths)
}

/**
 * The widths the panes `ids` take in a row `rowWidth` pixels wide that must also hold the flexible pane
 * (`flexMin`) and `handles` dividers of `handleWidth`: their own widths when they fit; when they do not
 * (a smaller window or screen), each gives up a share of the excess in proportion to what it has above
 * its minimum, so every pane stays in the window and none goes under its minimum. If not even the
 * minimums fit (a narrow window with many panes), every pane of the row, the flexible one too, gets an
 * equal share of the width (`narrowShare`): all of them stay visible, narrower than their minimum. The
 * saved widths are not changed: with room again, the panes go back to them.
 */
export function fitPaneWidths(ids: string[], widths: Record<string, number>, { rowWidth, flexMin, handles, handleWidth = 6 }: { rowWidth: number; flexMin: number; handles: number; handleWidth?: number }): Record<string, number> {
  const own = Object.fromEntries(ids.map((id) => [id, paneWidth(id, widths)]))
  if (!(rowWidth > 0)) return own
  const room = rowWidth - flexMin - handles * handleWidth
  const total = ids.reduce((sum, id) => sum + own[id], 0)
  if (total <= room) return own
  const spare = ids.reduce((sum, id) => sum + (own[id] - paneMinWidth(id)), 0)
  if (total - room > spare) {
    const share = narrowShare({ rowWidth, panes: ids.length + 1, handles, handleWidth })
    return Object.fromEntries(ids.map((id) => [id, share]))
  }
  const cut = total - room
  return Object.fromEntries(ids.map((id) => {
    const above = own[id] - paneMinWidth(id)
    return [id, Math.floor(own[id] - (spare > 0 ? (cut * above) / spare : 0))]
  }))
}

/** Each pane's width when not even the minimums fit: the row split evenly (never under 96 px). */
export function narrowShare({ rowWidth, panes, handles, handleWidth = 6 }: { rowWidth: number; panes: number; handles: number; handleWidth?: number }): number {
  return Math.max(96, Math.floor((rowWidth - handles * handleWidth) / Math.max(1, panes)))
}

/** Saved widths made safe: only pane ids, only widths between their minimum and 4000 px. */
export function normalizePaneWidths(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, number] => ROW_PANE_ID.test(entry[0]) && entry[0] !== "chat" && typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= paneMinWidth(entry[0]) && entry[1] <= 4000))
}
