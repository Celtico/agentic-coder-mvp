import type { DetailedHTMLProps, HTMLAttributes, Ref } from 'react';

export type ProjectFile = { path: string; directory: boolean };
export type ProjectInfo = { path: string; files: ProjectFile[] };
export type ChatMessage = { role: 'user' | 'assistant'; text: string; error?: boolean };
export type HistoryEntry = { prompt: string; answer: string; at?: string };

export interface AgenticBridge {
  openProject(): Promise<ProjectInfo | null>;
  currentProject(): Promise<ProjectInfo | null>;
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<{ ok: boolean; backupPath: string | null }>;
  ask(prompt: string): Promise<string>;
  recentHistory(): Promise<HistoryEntry[]>;
  runTests(): Promise<{ code: number; output: string }>;
  runCommand(command: string): Promise<{ code: number | null; output: string }>;
  onStatus(callback: (value: { type: string; message?: string }) => void): () => void;
  onTerminalOutput(callback: (value: string) => void): () => void;
  onTestOutput(callback: (value: string) => void): () => void;
}

export type ElectronWebviewTag = HTMLElement & {
  canGoBack(): boolean; canGoForward(): boolean; goBack(): void; goForward(): void;
  reload(): void; executeJavaScript(code: string): Promise<string>;
};

declare global {
  interface Window { agentic: AgenticBridge }
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string; partition?: string; webpreferences?: string; ref?: Ref<ElectronWebviewTag>;
      };
    }
  }
}
