// The errors of a call to the main process, as the window shows them. One helper for every panel:
// a window reloaded (⌘R) over an app started before a feature existed gets the same notice everywhere.

/**
 * An error from a call the main process does not know yet (it was started before the update): Electron
 * says «No handler registered», and an older preload has no such function at all.
 */
export const missingInMain = (error: unknown) => error instanceof TypeError && /is not a function/.test(error.message) || /No handler registered/i.test(String((error as Error)?.message ?? error))

export const RESTART_NOTICE = "Cal reiniciar l’app per activar aquesta funció: tanca-la (⌘Q) i torna-la a obrir."

/** The text to show: the restart notice, or the error without Electron's «Error invoking remote method…». */
export const ipcErrorText = (error: unknown) => missingInMain(error)
  ? RESTART_NOTICE
  : error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error)
