import { FloatingPanel, IconButton, useFloatingPanelContext, type IconButtonProps } from "@chakra-ui/react"
import type { IconType } from "react-icons"
import { LuMinus as Minus, LuPlus as Plus, LuX as X } from "react-icons/lu"
import { useEffect, type ReactNode } from "react"
import { PaneHeader } from "./pane-header"

export type WindowStage = "default" | "minimized" | "maximized"

/**
 * One traffic light: a round button, as big as the system ones, whose glyph shows only while the pointer
 * is over the three. It is the child of a CloseTrigger or StageTrigger (asChild), so it must pass on what
 * the trigger gives it — the click above all; without that the lights did nothing.
 */
function Light({ color, label, children, ...trigger }: Omit<IconButtonProps, "color"> & { color: string; label: string; children: ReactNode }) {
  return (
    <IconButton
      {...trigger}
      aria-label={label}
      title={label}
      unstyled
      display="inline-flex"
      alignItems="center"
      justifyContent="center"
      boxSize="3"
      minW="3"
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
 * The header of a floating window: the traffic lights on the left, like a macOS one — red closes, yellow
 * minimizes, green makes it big — and after them the same title as every pane's header (icon, title,
 * subtitle: a PaneTitle), left-aligned, 40 px high like the panes' headers. The whole bar drags the
 * window (double click maximizes or restores it). `stage` is the panel's current stage (from its
 * Root's onStageChange): yellow and green turn into "restore" when the window is already in theirs.
 */
export function WindowTitleBar({ icon, title, subtitle, subtitleTitle, stage, name }: { icon: IconType; title: string; subtitle?: ReactNode; subtitleTitle?: string; stage: WindowStage; name: string }) {
  const minimized = stage === "minimized"
  const maximized = stage === "maximized"
  const lights = (
    <FloatingPanel.Control data-group display="flex" alignItems="center" gap="2" colorPalette="agentic" me="1">
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
  )
  // The panes' own header (same height, padding, icon, title, subtitle, line and tone), with the traffic
  // lights first; the whole of it drags the window.
  return (
    <FloatingPanel.Header p="0" gap="0" minH="0" bg="transparent" borderBottomWidth="0" display="block">
      <FloatingPanel.Title srOnly>{title}</FloatingPanel.Title>
      <FloatingPanel.DragTrigger display="block" w="full" p="0">
        <PaneHeader icon={icon} title={title} subtitle={subtitle} subtitleTitle={subtitleTitle} leading={lights}/>
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
