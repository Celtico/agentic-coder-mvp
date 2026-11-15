import { defaultConfig, defineSlotRecipe } from "@chakra-ui/react"

// The look of every pane's header and second row (src/app/pane-header.tsx), as Chakra slot recipes with a
// `tone` variant chosen in Preferències › Aparença: «brand» (icon in the accent colour), «mono» (icon and
// title muted) and «tinted» (a header tinted with the accent). The colours are the colour palette, which
// is the app's accent («agentic», the green by default, or the one chosen in Preferències).

export const paneHeaderRecipe = defineSlotRecipe({
  className: "pane-header",
  slots: ["root", "icon", "title", "subtitle", "actions"],
  base: {
    root: { colorPalette: "agentic", display: "flex", flex: "none", h: "10", alignItems: "center", gap: "2", px: "3", minW: "0", borderBottomWidth: "1px", borderColor: "border" },
    icon: { flex: "none", display: "inline-flex" },
    // In a narrow pane the subtitle gives way first (it shrinks a hundred times faster), then the title is
    // cut with an ellipsis; the icon and the actions keep their size.
    title: { flex: "0 1 auto", minW: "0", fontSize: "sm", fontWeight: "semibold", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
    subtitle: { flex: "0 100 auto", minW: "0", fontSize: "xs", color: "fg.muted", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    actions: { flex: "none", display: "flex", alignItems: "center", gap: "0.5", ms: "auto" },
  },
  variants: {
    tone: {
      brand: { root: { bg: "transparent" }, icon: { color: "colorPalette.solid" }, title: { color: "fg" } },
      mono: { root: { bg: "transparent" }, icon: { color: "fg.muted" }, title: { color: "fg.muted" } },
      tinted: { root: { bg: "colorPalette.subtle" }, icon: { color: "colorPalette.fg" }, title: { color: "colorPalette.fg" } },
    },
  },
  defaultVariants: { tone: "brand" },
})

export const paneToolbarRecipe = defineSlotRecipe({
  className: "pane-toolbar",
  slots: ["root", "field", "action"],
  base: {
    root: { colorPalette: "agentic", display: "flex", flex: "none", h: "9", alignItems: "center", gap: "2", px: "3", minW: "0", borderBottomWidth: "1px", borderColor: "border" },
    field: { flex: "1", minW: "0", fontSize: "xs", color: "fg.muted", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    action: { flex: "none", display: "flex", alignItems: "center", gap: "2" },
  },
  variants: {
    tone: {
      brand: { root: { bg: "transparent" } },
      mono: { root: { bg: "transparent" } },
      tinted: { root: { bg: "bg.subtle" } },
    },
  },
  defaultVariants: { tone: "brand" },
})

// Every pane is a Chakra Card (src/app/pane-header.tsx, Pane), with Chakra's own variants chosen in
// Preferències › Aparença › Estil dels panells: «subtle» (as the panes have always looked: the panel
// colour, no line), «outline» (a thin line around) and «elevated» (a shadow). Chakra's card recipe is
// extended, not replaced: the panes' radius, the app's panel colour, and no inner padding (header and
// body bring their own).
type CardRecipe = { slots: string[]; base: Record<string, Record<string, unknown>>; variants: Record<string, Record<string, unknown>>; defaultVariants?: Record<string, string> }
const chakraCard = defaultConfig.theme?.slotRecipes?.card as unknown as CardRecipe

export const paneCardRecipe = defineSlotRecipe({
  ...chakraCard,
  slots: [...chakraCard.slots],
  base: {
    ...chakraCard.base,
    root: { ...chakraCard.base.root, borderRadius: "panel", overflow: "hidden", minH: "0", h: "full", flex: "1" },
    body: { ...chakraCard.base.body, minH: "0", overflow: "hidden" },
  },
  variants: {
    ...chakraCard.variants,
    variant: {
      subtle: { root: { bg: "bg" } },
      outline: { root: { bg: "bg", borderWidth: "1px", borderColor: "border" } },
      // Chakra's own elevated card, as its docs show it: the panel colour and its «md» shadow (in dark mode
      // a soft shadow and a faint light inset edge), nothing of our own on top.
      elevated: { root: { bg: "bg.panel", boxShadow: "md" } },
    },
    size: { ...(chakraCard.variants.size as Record<string, unknown>), pane: { root: { "--card-padding": "0" } } },
  },
  defaultVariants: { ...chakraCard.defaultVariants, variant: "subtle", size: "pane" },
} as Parameters<typeof defineSlotRecipe>[0])

// What dialogs and floating windows are made of, chosen in Preferències › Aparença › Diàlegs: «solid»
// (Chakra's panel background) or «glass» (the same background, see-through and blurred). Defined once:
// the dialog recipe's `material` variant, the Historial local window and the preview use these.
export type DialogMaterial = "solid" | "glass"
export const DIALOG_MATERIALS: Record<DialogMaterial, { content: Record<string, string>; backdrop: Record<string, string> }> = {
  solid: { content: { bg: "bg.panel", borderColor: "border" }, backdrop: { bg: "blackAlpha.600" } },
  glass: { content: { bg: "bg.panel/80", backdropFilter: "blur(16px) saturate(1.2)", borderColor: "border.subtle" }, backdrop: { bg: "blackAlpha.400" } },
}

// Every dialog of the app (Preferències, the saved cases, confirmations…) on Chakra's panel background,
// with the app's line around it: Chakra's dialog recipe, extended.
const chakraDialog = defaultConfig.theme?.slotRecipes?.dialog as unknown as CardRecipe

export const dialogRecipe = defineSlotRecipe({
  ...chakraDialog,
  slots: [...chakraDialog.slots],
  base: {
    ...chakraDialog.base,
    content: { ...chakraDialog.base.content, bg: "bg.panel", color: "fg", borderWidth: "1px", borderColor: "border", borderRadius: "lg", boxShadow: "2xl", overflow: "hidden" },
    // The header is the panes' header (src/app/pane-header.tsx), which brings its own padding.
    header: { ...chakraDialog.base.header, p: "0", display: "block" },
    // The close button is one of the header's actions (src/app/App.tsx, DialogHeading), in its flow:
    // not Chakra's corner button.
    closeTrigger: { ...chakraDialog.base.closeTrigger, pos: "static", top: "auto", insetEnd: "auto" },
  },
  variants: {
    ...chakraDialog.variants,
    material: {
      solid: { content: DIALOG_MATERIALS.solid.content, backdrop: DIALOG_MATERIALS.solid.backdrop },
      glass: { content: DIALOG_MATERIALS.glass.content, backdrop: DIALOG_MATERIALS.glass.backdrop },
    },
  },
  defaultVariants: { ...chakraDialog.defaultVariants, material: "glass" },
} as unknown as Parameters<typeof defineSlotRecipe>[0])
