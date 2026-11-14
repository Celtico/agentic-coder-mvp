import { defaultConfig, defineSlotRecipe } from "@chakra-ui/react"

// The look of every pane's header and second row (src/app/pane-header.tsx), as Chakra slot recipes with a
// `tone` variant chosen in Preferències › Aparença: «brand» (icon in the brand green), «mono» (icon and title
// muted) and «tinted» (a header tinted with the brand green). Only semantic tokens.

export const paneHeaderRecipe = defineSlotRecipe({
  className: "pane-header",
  slots: ["root", "icon", "title", "subtitle", "actions"],
  base: {
    root: { display: "flex", flex: "none", h: "10", alignItems: "center", gap: "2", px: "3", minW: "0", borderBottomWidth: "1px", borderColor: "border" },
    icon: { flex: "none", display: "inline-flex" },
    title: { flex: "none", fontSize: "sm", fontWeight: "semibold", whiteSpace: "nowrap" },
    subtitle: { minW: "0", fontSize: "xs", color: "fg.muted", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    actions: { flex: "none", display: "flex", alignItems: "center", gap: "0.5", ms: "auto" },
  },
  variants: {
    tone: {
      brand: { root: { bg: "transparent" }, icon: { color: "brand.solid" }, title: { color: "fg" } },
      mono: { root: { bg: "transparent" }, icon: { color: "fg.muted" }, title: { color: "fg.muted" } },
      tinted: { root: { bg: "brand.subtle" }, icon: { color: "brand.fg" }, title: { color: "brand.fg" } },
    },
  },
  defaultVariants: { tone: "brand" },
})

export const paneToolbarRecipe = defineSlotRecipe({
  className: "pane-toolbar",
  slots: ["root", "field", "action"],
  base: {
    root: { display: "flex", flex: "none", h: "9", alignItems: "center", gap: "1.5", px: "3", minW: "0", borderBottomWidth: "1px", borderColor: "border" },
    field: { flex: "1", minW: "0", fontSize: "xs", color: "fg.muted", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    action: { flex: "none", display: "flex", alignItems: "center", gap: "0.5" },
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
      elevated: { root: { bg: "bg", boxShadow: "md" } },
    },
    size: { ...(chakraCard.variants.size as Record<string, unknown>), pane: { root: { "--card-padding": "0" } } },
  },
  defaultVariants: { ...chakraCard.defaultVariants, variant: "subtle", size: "pane" },
} as Parameters<typeof defineSlotRecipe>[0])
