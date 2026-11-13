import type { DetailedHTMLProps, HTMLAttributes, Ref } from 'react';

export type ProjectFile = { path: string; directory: boolean };
export type ProjectInfo = { path: string; files: ProjectFile[] };
export type ChatMessage = { role: 'user' | 'assistant'; text: string; error?: boolean };
export type HistoryEntry = { prompt: string; answer: string; at?: string };
export type ChatSession = { id: string; title: string; updatedAt: string; projectPath?: string | null; messages: ChatMessage[] };
export type BenchmarkCount = { runs: number; passed: number };
export type BenchmarkModelSummary = { model: string; label: string; at: string; open: BenchmarkCount; apps: BenchmarkCount; reference: BenchmarkCount; meanSeconds: number; tasks: Record<string, { runs: number; passed: number; meanSeconds: number; details: string[] }> };
export type BenchmarkList = { runs: { id: string; at: string; model: string; adapter: string | null; summary: { runs: number; passed: number } }[]; models: BenchmarkModelSummary[]; chart: string };
export type BenchmarkTurn = { input: { role: string; content: string } | null; output: string; seconds: number };
export type BenchmarkReport = { id: string; at: string; model: string; summary: { runs: number; passed: number }; results: { task: string; run: number; pass: boolean; detail: string; seconds: number; toolCalls: number; toolsByName: Record<string, number>; filesChanged: string[]; answer: string; transcript: BenchmarkTurn[]; error?: string }[] };
export type TrainingProgress = { step: string; message: string; progress?: number; published?: boolean; modelId?: string };
export type VerifiedExperience = { prompt: string; answer: string; projectPath: string; evidence: string; task?: string; sessionTurns?: { role: 'user' | 'assistant'; content: string }[] };
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
  getPermissionMode(): Promise<'ask' | 'auto'>;
  setPermissionMode(mode: 'ask' | 'auto'): Promise<'ask' | 'auto'>;
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
  startBenchmark(request: { repeat: 1 | 2 }): Promise<{ started: boolean; id: string }>;
  cancelBenchmark(): Promise<{ cancelled: boolean }>;
  benchmarkStatus(): Promise<{ running: boolean; model?: string }>;
  listBenchmarks(): Promise<BenchmarkList>;
  benchmarkReport(id: string): Promise<BenchmarkReport>;
  onBenchmarkProgress(callback: (value: { step: string; message: string; id?: string }) => void): () => void;
  startTraining(request: { name: string; baseModelId?: string }): Promise<{ started: boolean; dataset: string }>;
  cancelTraining(): Promise<{ cancelled: boolean }>;
  trainingStatus(): Promise<{ running: boolean; name?: string; base?: string }>;
  onTrainingProgress(callback: (value: TrainingProgress) => void): () => void;
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
