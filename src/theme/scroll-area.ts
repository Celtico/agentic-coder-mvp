import type { SystemStyleObject } from "@chakra-ui/react"

/**
 * A scrolling area with a thin bar that is always there when the content overflows (macOS hides its own
 * bar until you scroll): the WebKit scrollbar, drawn with the theme's tokens. Spread on any box that
 * scrolls: `<Box {...scrollArea}>`. Used by every list and panel body of the app.
 */
export const scrollArea = {
  overflowY: "auto",
  _scrollbar: { width: "2", height: "2" },
  _scrollbarTrack: { bg: "transparent" },
  _scrollbarThumb: { bg: "border.emphasized", borderRadius: "full", borderWidth: "2px", borderStyle: "solid", borderColor: "transparent", backgroundClip: "padding-box" },
} satisfies SystemStyleObject
