import type React from "react"
import type { IconType } from "react-icons"
import { Box, Flex, HStack, Text } from "@chakra-ui/react"

/**
 * The header of every pane (Converses, Fitxers, Editor, Navegador, Avaluació, Consola, Terminal, Git,
 * Aprenentatge): the pane's icon (the same as in the bar), its title, an optional subtitle (a path,
 * «Només lectura»…) and badge, and its actions on the right, all the same height and size.
 */
/**
 * The header's colours, chosen in one place. «brand»: the icon in the brand green, the title in the text
 * colour, on the pane's background. «mono»: icon and title muted. «tinted»: a header tinted with the brand
 * green, with icon and title in its text colour. Change PANE_HEADER_TONE to try another one.
 */
export type PaneHeaderTone = "brand" | "mono" | "tinted"
export const PANE_HEADER_TONE: PaneHeaderTone = "brand"
export const PANE_HEADER_TONES: Record<PaneHeaderTone, { bg: string; icon: string; title: string }> = {
  brand: { bg: "transparent", icon: "brand.solid", title: "fg" },
  mono: { bg: "transparent", icon: "fg.muted", title: "fg.muted" },
  tinted: { bg: "brand.subtle", icon: "brand.fg", title: "brand.fg" },
}

export const PaneHeader = ({ icon: Icon, title, subtitle, subtitleTitle, badge, actions, tone = PANE_HEADER_TONE }: { icon: IconType; title: string; subtitle?: React.ReactNode; subtitleTitle?: string; badge?: React.ReactNode; actions?: React.ReactNode; tone?: PaneHeaderTone }) => {
  const colors = PANE_HEADER_TONES[tone]
  return (
    <Flex flex="none" h="10" align="center" gap="2" px="3" minW="0" bg={colors.bg} borderBottomWidth="1px" borderColor="border" data-pane-header data-tone={tone}>
      <Box flex="none" color={colors.icon} display="inline-flex"><Icon size={16} aria-hidden="true"/></Box>
      <Text flex="none" fontSize="sm" fontWeight="semibold" color={colors.title} whiteSpace="nowrap">{title}</Text>
      {subtitle && <Text minW="0" fontSize="xs" color="fg.muted" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" title={subtitleTitle}>{subtitle}</Text>}
      {badge && <Box flex="none" minW="0" overflow="hidden">{badge}</Box>}
      <Box flex="1" minW="0"/>
      {actions && <HStack flex="none" gap="0.5">{actions}</HStack>}
    </Flex>
  )
}
