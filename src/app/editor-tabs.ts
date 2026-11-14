// The files open in the editor, one tab each (src/app/App.tsx, the editor pane). Only the list and
// which one is active live here; the content of each file is kept by the app.

/** Adds a file at the end of the tabs, unless it is already there. */
export function openTab(tabs: string[], path: string): string[] {
  return tabs.includes(path) ? tabs : [...tabs, path]
}

/**
 * Closes one tab. If it was the active one, the tab that takes its place becomes active (or the one
 * before it, if it was the last); with no tab left, nothing is active.
 */
export function closeTab(tabs: string[], active: string | null, path: string): { tabs: string[]; active: string | null } {
  const index = tabs.indexOf(path)
  if (index < 0) return { tabs, active }
  const next = tabs.filter((tab) => tab !== path)
  if (active !== path) return { tabs: next, active }
  return { tabs: next, active: next[index] ?? next[index - 1] ?? null }
}

/** A file or folder renamed: its tabs follow it (a folder takes every file inside with it). */
export function renameInTabs(tabs: string[], from: string, to: string): string[] {
  return tabs.map((tab) => (tab === from ? to : tab.startsWith(`${from}/`) ? `${to}${tab.slice(from.length)}` : tab))
}

/** A file or folder deleted: its tabs go (a folder takes every file inside with it). */
export function removeFromTabs(tabs: string[], path: string): string[] {
  return tabs.filter((tab) => tab !== path && !tab.startsWith(`${path}/`))
}

/** The name shown on each tab: the file name, with its folder when two open files share a name. */
export function tabLabels(tabs: string[]): Record<string, string> {
  const name = (path: string) => path.split("/").pop() || path
  const counts = new Map<string, number>()
  for (const tab of tabs) counts.set(name(tab), (counts.get(name(tab)) ?? 0) + 1)
  return Object.fromEntries(tabs.map((tab) => {
    const parts = tab.split("/")
    return [tab, (counts.get(name(tab)) ?? 0) > 1 && parts.length > 1 ? parts.slice(-2).join("/") : name(tab)]
  }))
}

/**
 * The tabs to put back for a project, from what was saved: its list of tabs, or, saved before there
 * were tabs, its one open file. `active` is the file that was in front (only if the editor was open).
 */
export function savedTabs(view: { editorTabs?: string[]; editorPath?: string }): { tabs: string[]; active: string | null } {
  let tabs = [...new Set((view.editorTabs ?? []).filter((tab) => typeof tab === "string" && tab))]
  if (view.editorPath) tabs = openTab(tabs, view.editorPath)
  return { tabs, active: view.editorPath ?? null }
}

/**
 * The first of `candidates` that still exists, and those found missing on the way (to be forgotten).
 * Empty or repeated candidates are skipped; with none left, `file` is null.
 */
export async function firstExistingFile(candidates: (string | null | undefined)[], exists: (path: string) => Promise<boolean>): Promise<{ file: string | null; missing: string[] }> {
  const missing: string[] = []
  for (const path of [...new Set(candidates.filter((item): item is string => typeof item === "string" && item.length > 0))]) {
    if (await exists(path)) return { file: path, missing }
    missing.push(path)
  }
  return { file: null, missing }
}
