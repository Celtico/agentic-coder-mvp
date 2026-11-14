import { createContext, useContext, type ReactNode } from "react"
import type { IconType } from "react-icons"
import { Box, Card, chakra, useSlotRecipe } from "@chakra-ui/react"
import { paneHeaderRecipe, paneToolbarRecipe } from "../theme/pane-recipes"

/**
 * The header of every pane (Converses, Fitxers, Editor, Navegador, Avaluació, Consola, Terminal, Git,
 * Aprenentatge) and the second row of those that have one. Their look is the theme's slot recipes
 * «paneHeader» and «paneToolbar» (src/theme/pane-recipes.ts); the tone comes from Preferències › Aparença.
 */
export type PaneHeaderTone = "brand" | "mono" | "tinted"
/** The tone every header and toolbar takes, unless one is given its own (the previews in Preferències). */
export const PaneToneContext = createContext<PaneHeaderTone>("brand")
/** Chakra's Card variants for the panes (src/theme/pane-recipes.ts), chosen in Preferències › Aparença. */
export type PaneStyle = "subtle" | "outline" | "elevated"
export const PaneStyleContext = createContext<PaneStyle>("subtle")

/** One pane: a Chakra Card with its header, and a body (an optional second row, then the content). */
export const Pane = ({ header, toolbar, children, label, variant }: { header: ReactNode; toolbar?: ReactNode; children: ReactNode; label?: string; variant?: PaneStyle }) => {
  const contextVariant = useContext(PaneStyleContext)
  const chosen = variant ?? contextVariant
  return (
    <Card.Root variant={chosen} aria-label={label} data-pane data-pane-style={chosen}>
      <Card.Header>{header}</Card.Header>
      <Card.Body>{toolbar}<Box flex="1" minH="0" minW="0" display="flex" flexDirection="column" overflow="hidden">{children}</Box></Card.Body>
    </Card.Root>
  )
}

export const PaneHeader = ({ icon: Icon, title, subtitle, subtitleTitle, badge, actions, tone }: { icon: IconType; title: string; subtitle?: ReactNode; subtitleTitle?: string; badge?: ReactNode; actions?: ReactNode; tone?: PaneHeaderTone }) => {
  const contextTone = useContext(PaneToneContext)
  const chosen = tone ?? contextTone
  const styles = useSlotRecipe({ recipe: paneHeaderRecipe })({ tone: chosen })
  return (
    <chakra.div css={styles.root} data-pane-header data-tone={chosen}>
      <chakra.span css={styles.icon}><Icon size={16} aria-hidden="true"/></chakra.span>
      <chakra.span css={styles.title}>{title}</chakra.span>
      {subtitle && <chakra.span css={styles.subtitle} title={subtitleTitle}>{subtitle}</chakra.span>}
      {badge && <Box flex="none" minW="0" overflow="hidden">{badge}</Box>}
      {actions && <chakra.div css={styles.actions}>{actions}</chakra.div>}
    </chakra.div>
  )
}

/** A pane's title (icon, title, subtitle) on its own, for a bar that is not a pane header (a floating window's). */
export const PaneTitle = ({ icon: Icon, title, subtitle, tone }: { icon: IconType; title: string; subtitle?: ReactNode; tone?: PaneHeaderTone }) => {
  const contextTone = useContext(PaneToneContext)
  const styles = useSlotRecipe({ recipe: paneHeaderRecipe })({ tone: tone ?? contextTone })
  return (
    <chakra.span display="inline-flex" alignItems="center" gap="2" minW="0" maxW="full" data-pane-title>
      <chakra.span css={styles.icon}><Icon size={16} aria-hidden="true"/></chakra.span>
      <chakra.span css={styles.title}>{title}</chakra.span>
      {subtitle && <chakra.span css={styles.subtitle}>{subtitle}</chakra.span>}
    </chakra.span>
  )
}

/** The second row: what needs width (`field`: an address, a path) and the pane's own small actions. */
export const PaneToolbar = ({ children, field, fieldTitle, tone }: { children?: ReactNode; field?: ReactNode; fieldTitle?: string; tone?: PaneHeaderTone }) => {
  const contextTone = useContext(PaneToneContext)
  const chosen = tone ?? contextTone
  const styles = useSlotRecipe({ recipe: paneToolbarRecipe })({ tone: chosen })
  return (
    <chakra.div css={styles.root} data-pane-toolbar data-tone={chosen}>
      {field !== undefined && <chakra.span css={styles.field} title={fieldTitle}>{field}</chakra.span>}
      {children && <chakra.div css={styles.action} flex={field === undefined ? "1" : undefined} minW="0">{children}</chakra.div>}
    </chakra.div>
  )
}
