import type { DetailedHTMLProps, HTMLAttributes, Ref } from 'react';

export type ProjectFile = { path: string; directory: boolean };
export type ProjectInfo = { path: string; files: ProjectFile[] };
export type ChatMessage = { role: 'user' | 'assistant'; text: string; error?: boolean };
export type HistoryEntry = { prompt: string; answer: string; at?: string };
export type ChatSession = { id: string; title: string; updatedAt: string; projectPath?: string | null; messages: ChatMessage[] };
export type VerifiedExperience = { prompt: string; answer: string; projectPath: string; evidence: string };
export type GitSnapshot = { available: boolean; reason?: string; branch?: string; localBranches?: string[]; remotes?: string[]; status?: string; stagedDiff?: string; unstagedDiff?: string; truncated?: boolean };
export type GitCommit = { hash: string; shortHash: string; subject: string; author: string; email: string; date: string; decorations: string };
export type GitBranch = { name: string; hash: string; current: boolean; remote: boolean };
export type GitHistory = { available: boolean; reason?: string; branch?: string; branches: GitBranch[]; commits: GitCommit[]; truncated?: boolean };
export type GitCommitDetails = GitCommit & { files: { status: string; path: string }[]; truncated?: boolean };
export type DeletedBackup = { id: string; path: string; bytes: number; deletedAt: string; mode: number };
export type ProjectFileHistoryVersion = { id: string; path: string; bytes: number; savedAt: string; label: string; sha256: string; content?: string; mode?: number };
export type TrainingDatasetPreview = { counts: { input: number; unverified: number; invalid: number; secrets: number; duplicates: number; included: number }; splitCounts: { train: number; validation: number; test: number }; trainingReady: boolean };
export type LocalModelOption = { id: string; label: string; modelId: string; available: boolean; reason?: string };

export interface AgenticBridge {
  openProject(): Promise<ProjectInfo | null>;
  createProjectEntry(relativePath: string, directory: boolean): Promise<ProjectInfo>;
  deleteProjectEntry(relativePath: string, directory: boolean): Promise<ProjectInfo>;
  renameProjectEntry(relativePath: string, newName: string): Promise<ProjectInfo>;
  importProjectDirectory(file: File): Promise<ProjectInfo>;
  currentProject(): Promise<ProjectInfo | null>;
  deletedBackups(): Promise<DeletedBackup[]>;
  clearProject(): Promise<{ cleared: number; cancelled?: boolean; project: ProjectInfo }>;
  restoreDeletedBackup(backupId: string): Promise<{ restored: boolean; denied?: boolean; path: string }>;
  fileHistory(relativePath: string): Promise<ProjectFileHistoryVersion[]>;
  folderHistory(relativePath: string): Promise<ProjectFileHistoryVersion[]>;
  fileHistoryVersion(relativePath: string, versionId: string): Promise<ProjectFileHistoryVersion>;
  restoreFileHistory(relativePath: string, versionId: string): Promise<{ restored: boolean; denied?: boolean; path: string }>;
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
  gitHistory(): Promise<GitHistory>;
  gitCommitDetails(hash: string): Promise<GitCommitDetails>;
  recentHistory(): Promise<HistoryEntry[]>;
  loadChatSessions(): Promise<ChatSession[]>;
  saveChatSessions(sessions: ChatSession[]): Promise<number>;
  recordVerifiedExperience(experience: VerifiedExperience): Promise<{ id: string; saved: boolean }>;
  runTests(): Promise<{ code: number | null; output: string; timedOut?: boolean }>;
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
