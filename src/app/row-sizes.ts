// The rows of panes: every pane of a row has its own width, in pixels, kept between launches (per pane
// id, in the view state), and one pane of the row is flexible and takes what is left: the chat in the top
// row, the last pane in the bottom one. A divider changes only the two panes beside it, one wider and the
// other narrower by as much: no other pane moves or changes. When the pane on its right is the flexible
// one, that one takes the difference. Neither pane goes under its minimum.

/** A pane's id in a row: «nav-…» the side columns, «side-…» the panes of the top group, «dock-…» the bottom row, «chat». */
export const ROW_PANE_ID = /^(?:(?:nav|side|dock)-[a-z]{1,40}|chat)$/

/** Narrowest a pane may be, in pixels: the side columns 120, the chat 260, any other pane 140. */
export function paneMinWidth(id: string): number {
  if (id.startsWith("nav-")) return 120
  if (id === "chat") return 260
  return 140
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

/**
 * A divider dragged `delta` pixels from where it started, pushing like an IDE: the two panes beside it
 * exchange width; when the one that shrinks reaches its minimum and the drag goes on, the next pane on
 * that side starts to shrink, and so on to the end of the row (on the right, last of all the flexible
 * pane, down to `flexMin`). The pane that grows is always the one beside the divider. `order` is the
 * row's panes with their own width, left to right; the divider is on the right of `order[index]`;
 * `widths` are the widths when the drag started. Returns the new widths of the panes in `order`.
 */
export function pushDividers({ order, widths, index, delta, flexWidth, flexMin }: { order: string[]; widths: Record<string, number>; index: number; delta: number; flexWidth: number; flexMin: number }): Record<string, number> {
  const next = Object.fromEntries(order.map((id) => [id, widths[id]]))
  const room = (id: string) => Math.max(0, next[id] - paneMinWidth(id))
  let wanted = Math.round(Math.abs(delta))
  if (delta > 0) {
    // To the right: the pane on the left grows; the panes on the right give, nearest first, then the flexible one.
    let given = 0
    for (let i = index + 1; i < order.length && given < wanted; i += 1) { const take = Math.min(room(order[i]), wanted - given); next[order[i]] -= take; given += take }
    given += Math.min(Math.max(0, flexWidth - flexMin), wanted - given)
    next[order[index]] += given
  } else if (delta < 0) {
    // To the left: the panes on the left give, nearest first; the pane on the right of the divider grows
    // (the flexible one takes it by itself when it is the one there).
    let given = 0
    for (let i = index; i >= 0 && given < wanted; i -= 1) { const take = Math.min(room(order[i]), wanted - given); next[order[i]] -= take; given += take }
    if (index + 1 < order.length) next[order[index + 1]] += given
    wanted = given
  }
  return next
}
