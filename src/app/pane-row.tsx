import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { Box, Flex } from "@chakra-ui/react"
import { draggedPair, fitPaneWidths, narrowShare, paneMinWidth } from "./row-sizes"

export type RowItem = { id: string; node: ReactNode }

/**
 * A row of panes (src/app/row-sizes.ts): each pane but `flexId` has its own width, with a divider on its
 * right that changes only the two panes beside it, one wider and the other narrower by as much; no other
 * pane moves. Next to `flexId`, that one takes the difference. Arrow keys on a divider move it 16 px.
 */
export function PaneRow({ items, flexId, widths, onWidth, onCommit, label }: {
  items: RowItem[]
  flexId: string
  widths: Record<string, number>
  /** While dragging: the new widths of the two panes beside the divider. */
  onWidth: (changes: Record<string, number>) => void
  /** When the drag (or a key) ends: the widths to keep. */
  onCommit: (changes: Record<string, number>) => void
  label: string
}) {
  const rowRef = useRef<HTMLDivElement | null>(null)
  // While a divider is dragged nothing in the panes is selected: the row stops selecting text, and a
  // layer over the whole window (a webview or the terminal would take the pointer) keeps the resize cursor.
  const [dragging, setDragging] = useState<string | null>(null)
  // The drag in progress, so it is ended (listeners off, capture released) if the row goes away mid-drag.
  const endDragRef = useRef<(() => void) | null>(null)
  useEffect(() => () => endDragRef.current?.(), [])
  const flexWidth = () => rowRef.current?.querySelector<HTMLElement>("[data-pane-flex]")?.getBoundingClientRect().width ?? 0
  // The row's width, followed as the window changes: the panes' widths are fitted to it (src/app/row-sizes.ts),
  // so the row never runs past the window on a smaller screen.
  const [rowWidth, setRowWidth] = useState(0)
  useEffect(() => {
    const row = rowRef.current
    if (!row || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => setRowWidth(Math.round(entry.contentRect.width)))
    observer.observe(row)
    return () => observer.disconnect()
  }, [])
  const fixedIds = items.filter((item) => item.id !== flexId).map((item) => item.id)
  // Not even the minimums fit (a narrow window with many panes): every pane, the flexible one too, gets an
  // equal share, so none is cut off or hidden (src/app/row-sizes.ts).
  const tooNarrow = rowWidth > 0 && fixedIds.reduce((sum, id) => sum + paneMinWidth(id), 0) + paneMinWidth(flexId) + fixedIds.length * 6 > rowWidth
  const flexMin = tooNarrow ? Math.min(paneMinWidth(flexId), narrowShare({ rowWidth, panes: fixedIds.length + 1, handles: fixedIds.length })) : paneMinWidth(flexId)
  const fitted = fitPaneWidths(fixedIds, widths, { rowWidth, flexMin: paneMinWidth(flexId), handles: fixedIds.length })
  const paneWidth = (id: string, _widths: Record<string, number>) => fitted[id]
  const minOf = (id: string) => (tooNarrow ? Math.min(paneMinWidth(id), fitted[id] ?? paneMinWidth(id)) : paneMinWidth(id))
  // The pane on the right of a pane's divider, and how wide each one is when a drag starts.
  const rightOf = (id: string) => items[items.findIndex((item) => item.id === id) + 1]?.id ?? flexId
  const pair = (id: string, delta: number, starts = { left: paneWidth(id, widths), right: rightOf(id) === flexId ? flexWidth() : paneWidth(rightOf(id), widths) }) =>
    draggedPair({ left: id, right: rightOf(id), startLeft: starts.left, startRight: starts.right, delta, rightIsFlex: rightOf(id) === flexId, flexMin })

  const startDrag = (id: string) => (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const starts = { left: paneWidth(id, widths), right: rightOf(id) === flexId ? flexWidth() : paneWidth(rightOf(id), widths) }
    let changes = pair(id, 0, starts)
    setDragging(id)
    window.getSelection()?.removeAllRanges()
    const move = (moved: globalThis.PointerEvent) => {
      changes = pair(id, moved.clientX - startX, starts)
      onWidth(changes)
    }
    // The drag ends however the pointer is let go: on the divider, anywhere in the window, when the
    // divider loses the pointer or the window loses the focus. Ended once; never left half-way, which
    // left the layer over the window and the app blocked.
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      endDragRef.current = null
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", end)
      handle.removeEventListener("pointercancel", end)
      handle.removeEventListener("lostpointercapture", end)
      window.removeEventListener("pointerup", end)
      window.removeEventListener("blur", end)
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
      setDragging(null)
      onCommit(changes)
    }
    endDragRef.current = end
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", end)
    handle.addEventListener("pointercancel", end)
    handle.addEventListener("lostpointercapture", end)
    window.addEventListener("pointerup", end)
    window.addEventListener("blur", end)
  }

  const nudge = (id: string) => (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 16 : event.key === "ArrowLeft" ? -16 : 0
    if (!step) return
    event.preventDefault()
    onCommit(pair(id, step))
  }

  return (
    <Flex ref={rowRef} h="full" w="full" minW="0" minH="0" overflowX="clip" aria-label={label} data-pane-row userSelect={dragging ? "none" : undefined} data-dragging={dragging ? "" : undefined}>
      {dragging && <Box position="fixed" inset="0" zIndex="4000" cursor="col-resize" userSelect="none" data-pane-drag-layer onPointerUp={() => setDragging(null)}/>}
      {items.map((item) => {
        // The panes clip their own content (their Card); these boxes do not, so a pane's shadow («amb ombra») shows round its corners.
        if (item.id === flexId) return <Flex key={item.id} flex="1" minW={`${flexMin}px`} minH="0" h="full" data-pane-flex data-pane-id={item.id}>{item.node}</Flex>
        const width = paneWidth(item.id, widths)
        return (
          <Fragment key={item.id}>
            <Flex flex="none" w={`${width}px`} minW={`${minOf(item.id)}px`} minH="0" h="full" data-pane-id={item.id}>{item.node}</Flex>
            <Box role="separator" aria-orientation="vertical" aria-label="Arrossega per ajustar l’amplada d’aquest panell" title="Arrossega per ajustar l’amplada d’aquest panell"
              aria-valuenow={width} aria-valuemin={paneMinWidth(item.id)} tabIndex={0} data-pane-handle={item.id} data-group
              flex="none" w="6px" h="full" display="flex" alignItems="center" justifyContent="center" cursor="col-resize" touchAction="none"
              _focusVisible={{ outlineColor: "border", outlineWidth: "1px", outlineStyle: "solid" }}
              onPointerDown={startDrag(item.id)} onKeyDown={nudge(item.id)}>
              <Box w="2px" h="32px" rounded="full" bg="transparent" _groupHover={{ bg: "border" }}/>
            </Box>
          </Fragment>
        )
      })}
    </Flex>
  )
}
