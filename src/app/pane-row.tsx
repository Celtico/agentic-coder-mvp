import { Fragment, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { Box, Flex } from "@chakra-ui/react"
import { draggedPaneWidth, paneMinWidth, paneWidth } from "./row-sizes"

export type RowItem = { id: string; node: ReactNode }

/**
 * A row of panes, as in an IDE (src/app/row-sizes.ts): each pane but `flexId` has its own width, with a
 * divider on its right that changes that width only; the panes after it move along and `flexId` takes
 * what is left, down to its minimum. Arrow keys on a divider move it 16 px.
 */
export function PaneRow({ items, flexId, widths, onWidth, onCommit, label }: {
  items: RowItem[]
  flexId: string
  widths: Record<string, number>
  /** While dragging. */
  onWidth: (id: string, width: number) => void
  /** When the drag (or a key) ends: the width to keep. */
  onCommit: (id: string, width: number) => void
  label: string
}) {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const flexWidth = () => rowRef.current?.querySelector<HTMLElement>("[data-pane-flex]")?.getBoundingClientRect().width ?? 0
  const flexMin = paneMinWidth(flexId)

  const startDrag = (id: string) => (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const start = paneWidth(id, widths)
    const startX = event.clientX
    const room = flexWidth()
    let width = start
    const move = (moved: globalThis.PointerEvent) => {
      width = draggedPaneWidth({ id, start, delta: moved.clientX - startX, flexWidth: room, flexMin })
      onWidth(id, width)
    }
    const end = () => {
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", end)
      handle.removeEventListener("pointercancel", end)
      onCommit(id, width)
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", end)
    handle.addEventListener("pointercancel", end)
  }

  const nudge = (id: string) => (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 16 : event.key === "ArrowLeft" ? -16 : 0
    if (!step) return
    event.preventDefault()
    const start = paneWidth(id, widths)
    onCommit(id, draggedPaneWidth({ id, start, delta: step, flexWidth: flexWidth(), flexMin }))
  }

  return (
    <Flex ref={rowRef} h="full" w="full" minW="0" minH="0" overflow="hidden" aria-label={label} data-pane-row>
      {items.map((item) => {
        if (item.id === flexId) return <Flex key={item.id} flex="1" minW={`${flexMin}px`} minH="0" h="full" overflow="hidden" data-pane-flex data-pane-id={item.id}>{item.node}</Flex>
        const width = paneWidth(item.id, widths)
        return (
          <Fragment key={item.id}>
            <Flex flex="none" w={`${width}px`} minW={`${paneMinWidth(item.id)}px`} minH="0" h="full" overflow="hidden" data-pane-id={item.id}>{item.node}</Flex>
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
