import { useId } from "react"
import { Box, chakra, useChakraContext } from "@chakra-ui/react"

/**
 * The app's mark. Still when the model is ready; it turns and breathes while the model works (`busy`).
 * With `gradient` (the rail's logo) it is drawn like the app's icon, from the brand's light green at the
 * top left to its dark green at the bottom right, never in the accent, and it never turns.
 */
export const Mark = ({ size = 16, busy = false, color = "agentic.fg", gradient = false }: { size?: number; busy?: boolean; color?: string; gradient?: boolean }) => {
  // One id per drawing, so two marks on the screen never share a gradient.
  const id = `mark-gradient-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  // The brand's own tokens, as their real values: stop-color here is an SVG attribute, and an attribute
  // never resolves a CSS var() (the stop then falls back to black). If a shade were missing, brand.solid.
  const { token } = useChakraContext()
  // A token that refers to another one (brand.300 is {colors.green.300}) comes back as its CSS variable:
  // followed to the palette's own value.
  const resolve = (path: string): string => {
    const value = token(path, "") as string
    const ref = /^var\(--chakra-colors-([a-z]+)-(\d+)\)$/.exec(value)
    return ref ? resolve(`colors.${ref[1]}.${ref[2]}`) : value
  }
  const shade = (path: string) => resolve(path) || resolve("colors.brand.500") || "currentColor"
  const light = shade("colors.brand.300")
  const dark = shade("colors.brand.600")
  const paint = gradient ? `url(#${id})` : "currentColor"
  const moving = busy && !gradient
  return (
    <Box as="span" display="inline-flex" flex="none" color={gradient ? undefined : color} aria-hidden="true" w={`${size}px`} h={`${size}px`} data-mark={gradient ? "gradient" : "plain"}>
      {/* In pixels: a bare number here would be read as a size token (28 → 7rem = 112 px). */}
      <chakra.svg viewBox="0 0 24 24" width={`${size}px`} height={`${size}px`} fill="none" animation={moving ? "agenticTurn 2.4s linear infinite" : undefined} _motionReduce={{ animation: "none" }}>
        {gradient && (
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={light}/>
              <stop offset="100%" stopColor={dark}/>
            </linearGradient>
          </defs>
        )}
        <chakra.path d="M12 2.5 21.5 12 12 21.5 2.5 12Z" stroke={paint} strokeWidth="2" strokeLinejoin="round" animation={moving ? "agenticBreathe 1.2s ease-in-out infinite" : undefined} transformOrigin="12px 12px" _motionReduce={{ animation: "none" }}/>
        <chakra.path d="M12 8 16 12 12 16 8 12Z" fill={paint} animation={moving ? "agenticBeat 1.2s ease-in-out infinite" : undefined} transformOrigin="12px 12px" _motionReduce={{ animation: "none" }}/>
      </chakra.svg>
    </Box>
  )
}
