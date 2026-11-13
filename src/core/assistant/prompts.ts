import fsSync from 'node:fs';
import path from 'node:path';
import process from 'node:process';

declare const __dirname: string;

/**
 * Every text the agent sends to the model — its instructions, the reminders it adds during a task,
 * the reviewer's questions, the framing of tool results — lives in prompts/<name>.md, outside the
 * code, so it can be read, edited or emptied without touching the app. The code only fills in the
 * {{variables}} of each text.
 *
 * A file is read each time it is used, so a change applies to the next request. A missing or empty
 * file means "no text": the agent keeps working without it; nothing is put back from the code.
 */
export function promptsDirectory(): string {
  return process.env.AGENT_PROMPTS_DIR || path.resolve(__dirname, '../../../prompts');
}

export function prompt(name: string, variables: Record<string, string | number> = {}): string {
  let text = '';
  try { text = fsSync.readFileSync(path.join(promptsDirectory(), `${name}.md`), 'utf8'); } catch { return ''; }
  // The one newline an editor leaves at the end of a file is not part of the text (a text that ends
  // with a blank line keeps it).
  text = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  return text.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => (key in variables ? String(variables[key]) : ''));
}

/**
 * The description of each tool, from prompts/tools.md: one «## tool_name» section per tool. The names
 * and parameters stay in the code (they are the tools' schema); what the model is told about each
 * tool is here. A tool without a section is sent without a description.
 */
export function toolDescriptions(): Record<string, string> {
  const text = prompt('tools');
  const found: Record<string, string> = {};
  for (const section of text.split(/^## /m).slice(1)) {
    const newline = section.indexOf('\n');
    const name = (newline < 0 ? section : section.slice(0, newline)).trim();
    if (name) found[name] = newline < 0 ? '' : section.slice(newline + 1).trim();
  }
  return found;
}
