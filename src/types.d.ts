import type { DetailedHTMLProps, HTMLAttributes, Ref } from 'react';

export type ProjectFile = { path: string; directory: boolean };
export type ProjectInfo = { path: string; files: ProjectFile[] };
export type ChatMessage = { role: 'user' | 'assistant'; text: string; error?: boolean };
export type HistoryEntry = { prompt: string; answer: string; at?: string };
export type ChatSession = { id: string; title: string; updatedAt: string; projectPath?: string | null; messages: ChatMessage[] };
export type VerifiedExperience = { prompt: string; answer: string; projectPath: string; evidence: string };
export type GitSnapshot = { available: boolean; reason?: string; branch?: string; status?: string; stagedDiff?: string; unstagedDiff?: string; truncated?: boolean };
export type DeletedBackup = { id: string; path: string; bytes: number; deletedAt: string; mode: number };
export type TrainingDatasetPreview = { counts: { input: number; unverified: number; invalid: number; secrets: number; duplicates: number; included: number }; splitCounts: { train: number; validation: number; test: number }; trainingReady: boolean };
export type LocalModelOption = { id: string; label: string; modelId: string; available: boolean; reason?: string };

export interface AgenticBridge {
  openProject(): Promise<ProjectInfo | null>;
  currentProject(): Promise<ProjectInfo | null>;
  deletedBackups(): Promise<DeletedBackup[]>;
  restoreDeletedBackup(backupId: string): Promise<{ restored: boolean; denied?: boolean; path: string }>;
  learningDatasetPreview(): Promise<TrainingDatasetPreview>;
  prepareLearningDataset(): Promise<{ prepared: boolean; cancelled?: boolean; directory?: string; manifest?: Record<string, unknown>; counts?: TrainingDatasetPreview['counts'] }>;
  projectForChat(sessionId: string): Promise<ProjectInfo | null>;
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<{ ok: boolean; backupPath: string | null }>;
  ask(request: { prompt: string; history: { role: 'user' | 'assistant'; content: string }[] }): Promise<string>;
  listModels(): Promise<{ selectedModel: string; models: LocalModelOption[] }>;
  selectModel(modelId: string): Promise<{ selectedModel: string; models: LocalModelOption[] }>;
  cancel(): Promise<{ cancelled: boolean; reason?: string }>;
  gitSnapshot(): Promise<GitSnapshot>;
  recentHistory(): Promise<HistoryEntry[]>;
  loadChatSessions(): Promise<ChatSession[]>;
  saveChatSessions(sessions: ChatSession[]): Promise<number>;
  recordVerifiedExperience(experience: VerifiedExperience): Promise<{ id: string; saved: boolean }>;
  runTests(): Promise<{ code: number; output: string }>;
  runCommand(command: string): Promise<{ code: number | null; output: string }>;
  onStatus(callback: (value: { type: string; message?: string }) => void): () => void;
  onTerminalOutput(callback: (value: string) => void): () => void;
  onProjectStarted(callback: (value: { projectPath: string; script: string; url: string }) => void): () => void;
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
