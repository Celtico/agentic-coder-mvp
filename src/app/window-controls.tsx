import { FloatingPanel, HStack, IconButton, useFloatingPanelContext } from "@chakra-ui/react"
import { LuMinus as Minus, LuPlus as Plus, LuX as X } from "react-icons/lu"
import { useEffect, type ReactNode } from "react"

export type WindowStage = "default" | "minimized" | "maximized"

/** One traffic light: a round button, as big as the system ones, whose glyph shows only while the pointer is over the three. */
function Light({ color, label, children }: { color: string; label: string; children: ReactNode }) {
  return (
    <IconButton
      aria-label={label}
      title={label}
      unstyled
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
      boxSize="windowLight"
      minW="windowLight"
      rounded="full"
      bg={color}
      color="transparent"
      borderWidth="xs"
      borderColor="window.lightBorder"
      _groupHover={{ color: "window.lightGlyph" }}
      focusRing="outside"
      _focusVisible={{ color: "window.lightGlyph" }}
    >
      {children}
    </IconButton>
  )
}

/**
 * The header of a floating window, like a macOS one: the whole bar drags the window (double click
 * maximizes or restores it), the traffic lights are on the left — red closes, yellow minimizes,
 * green makes it big — and the title is centred. `stage` is the panel's current stage (from its
 * Root's onStageChange): yellow and green turn into "restore" when the window is already in theirs.
 */
export function WindowTitleBar({ title, stage, name }: { title: ReactNode; stage: WindowStage; name: string }) {
  const minimized = stage === "minimized"
  const maximized = stage === "maximized"
  return (
    <FloatingPanel.Header p="0" gap="0">
      <FloatingPanel.DragTrigger flex="1" minW="0" h="windowTitleBar" display="grid" gridTemplateColumns="auto minmax(0, 1fr) auto" alignItems="center" gap="3" px="windowLightInset" py="0">
        <FloatingPanel.Control data-group display="flex" alignItems="center" gap="windowLightGap" colorPalette="agentic">
          <FloatingPanel.CloseTrigger asChild>
            <Light color="window.close" label={`Tanca ${name}`}><X size={8} strokeWidth={3}/></Light>
          </FloatingPanel.CloseTrigger>
          <FloatingPanel.StageTrigger stage={minimized ? "default" : "minimized"} hidden={false} asChild>
            <Light color="window.minimize" label={minimized ? `Restaura ${name}` : `Minimitza ${name}`}><Minus size={8} strokeWidth={3}/></Light>
          </FloatingPanel.StageTrigger>
          <FloatingPanel.StageTrigger stage={maximized ? "default" : "maximized"} hidden={false} asChild>
            <Light color="window.maximize" label={maximized ? `Restaura la mida de ${name}` : `Fes gran ${name}`}><Plus size={8} strokeWidth={3}/></Light>
          </FloatingPanel.StageTrigger>
        </FloatingPanel.Control>
        <FloatingPanel.Title truncate textAlign="center" fontSize="xs" fontWeight="semibold">{title}</FloatingPanel.Title>
        {/* As wide as the lights, so the title stays in the middle of the bar. */}
        <HStack aria-hidden="true" w="windowLights" />
      </FloatingPanel.DragTrigger>
    </FloatingPanel.Header>
  )
}

/**
 * Puts a floating window back in the stage it was left in (minimized or big) when it opens. Goes
 * inside its FloatingPanel.Root; the panel has no prop for a starting stage.
 */
export function RestoreWindowStage({ stage }: { stage: WindowStage }) {
  const panel = useFloatingPanelContext()
  useEffect(() => {
    if (stage === "maximized") panel.maximize()
    else if (stage === "minimized") panel.minimize()
    // Only when the window opens: afterwards the user moves it between stages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}
