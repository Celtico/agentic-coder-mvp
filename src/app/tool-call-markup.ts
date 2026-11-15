// A tool call the app could not read stays in the model's answer as markup (<tool_call>…). The chat does
// not show it as the answer's text: it is taken out of what is shown (the text around it stays) and the
// message gets a notice with the raw call. The conversation, the history sent back to the model and the
// training data keep the answer exactly as the model wrote it; only the display changes.

const BLOCK = /<tool_call>[\s\S]*?(?:<\/tool_call>|$)|<\|tool_call>[\s\S]*?(?:<tool_call\|>|$)/g

export function splitToolCallMarkup(text: string): { text: string; calls: string[] } {
  const calls = text.match(BLOCK) || []
  if (!calls.length) return { text, calls: [] }
  const shown = text.replace(BLOCK, "\n").replace(/\n{3,}/g, "\n\n").trim()
  return { text: shown, calls }
}
