import type { TurnProgress } from "../types"

/**
 * The agent's progress as the chat shows it while it works: «Iteració 9 de 28», and the tool it runs,
 * «Iteració 9 de 28 · start_project». Empty until the first iteration has started.
 */
export function turnProgressText(progress: TurnProgress | null | undefined): string {
  if (!progress || !Number.isInteger(progress.iteration) || !Number.isInteger(progress.maxIterations) || progress.iteration < 1 || progress.maxIterations < 1) return ""
  const base = `Iteració ${Math.min(progress.iteration, progress.maxIterations)} de ${progress.maxIterations}`
  return progress.tool ? `${base} · ${progress.tool}` : base
}

/** A progress status from the agent (src/core/assistant/agent.ts), or null for any other status. */
export function progressFromStatus(value: { type: string; iteration?: number; maxIterations?: number; tool?: string }): TurnProgress | null {
  if (value.type !== "progress" || !Number.isInteger(value.iteration) || !Number.isInteger(value.maxIterations)) return null
  return { iteration: value.iteration as number, maxIterations: value.maxIterations as number, ...(typeof value.tool === "string" && value.tool ? { tool: value.tool } : {}) }
}
