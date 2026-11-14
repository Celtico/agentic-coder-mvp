import type { DetailedHTMLProps, HTMLAttributes, Ref } from 'react';

export type ProjectFile = { path: string; directory: boolean };
export type ProjectInfo = { path: string; files: ProjectFile[] };
/** `notice`: a message of the window itself (stopped, error), not sent to the model as history. */
/** `images`: small thumbnails of the images sent with the message (the images themselves are not kept). */
export type ChatMessage = { role: 'user' | 'assistant'; text: string; error?: boolean; notice?: boolean; images?: { name: string; thumbnail: string }[] };
export type HistoryEntry = { prompt: string; answer: string; at?: string };
export type ChatSession = { id: string; title: string; updatedAt: string; projectPath?: string | null; messages: ChatMessage[] };
export type BenchmarkTask = { id: string; description: string; prompt: string; kind: 'open' | 'app' | 'reference' };
export type BenchmarkCurrent = { index: number; total: number; task: string; run: number; since: number };
export type BenchmarkProject = { id: string; index: number; at: string; model: string; task: string; run: number; pass: boolean; detail: string };
export type BenchmarkCount = { runs: number; passed: number };
export type BenchmarkModelSummary = { model: string; label: string; at: string; open: BenchmarkCount; apps: BenchmarkCount; reference: BenchmarkCount; meanSeconds: number; tasks: Record<string, { runs: number; passed: number; meanSeconds: number; details: string[] }> };
export type BenchmarkList = { runs: { id: string; at: string; model: string; adapter: string | null; summary: { runs: number; passed: number } }[]; models: BenchmarkModelSummary[]; chart: string };
export type BenchmarkTurn = { input: { role: string; content: string } | null; output: string; seconds: number };
export type BenchmarkReport = { id: string; at: string; model: string; summary: { runs: number; passed: number }; results: { task: string; run: number; pass: boolean; detail: string; seconds: number; toolCalls: number; toolsByName: Record<string, number>; filesChanged: string[]; answer: string; transcript: BenchmarkTurn[]; error?: string; hasProject?: boolean }[] };
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
export type LearningCase = { id: string; at: string | null; model: string | null; task: string; evidence: string; turns: number; steps: number; withoutToolSteps: boolean; editedAt?: string };
export type LearningCaseDetail = LearningCase & { prompt: string; answer: string; requests: { request: string; answer: string; steps: { name: string; ok: boolean; arguments: Record<string, string>; result: string }[] }[] };
export type AgentPreferences = { answerTokens: number; maxIterations: number; historyMessages: number; review: boolean; webSearch: boolean };
export type DictationPreferences = { model: string; language: 'auto' | 'ca' | 'es' | 'en' };
export type TrainingPreferences = { maxTokens: number; numLayers: number; learningRate: number; itersPerCase: number; minIters: number; maxIters: number; seed: number };
export type AdapterVersion = { folder: string; number: number; cases: number; createdAt: string; durationSeconds: number; finalLoss: number | null; truncated: number; dropped: number; comparison: { base: { passed: number; runs: number }; candidate: { passed: number; runs: number } } | null; promoted: { folder: string; label: string } | null };
export type LearningVersions = { cases: number; base: { id: string; label: string } | null; betas: AdapterVersion[]; candidate: AdapterVersion | null; buttons: Record<'beta' | 'stable' | 'promote', { enabled: boolean; reason: string | null; fewCases?: boolean }>; running: { kind: string } | null; fewCases: number };
export type LocalModelOption = { id: string; label: string; modelId: string; available: boolean; reason?: string; vision?: boolean };

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
  listLearningCases(): Promise<{ cases: LearningCase[]; unreadable: number }>;
  learningCaseDetail(id: string): Promise<LearningCaseDetail>;
  updateLearningCase(id: string, changes: { task: string; evidence: string }): Promise<LearningCase>;
  deleteLearningCase(id: string): Promise<{ id: string; deleted: number }>;
  projectForChat(sessionId: string): Promise<ProjectInfo | null>;
  readFile(relativePath: string): Promise<string>;
  /** Whether the file is in the project, without throwing when it is not. */
  fileExists(relativePath: string): Promise<boolean>;
  writeFile(relativePath: string, content: string): Promise<{ ok: boolean; backupPath: string | null }>;
  ask(request: { prompt: string; history: { role: 'user' | 'assistant'; content: string }[]; images?: { name: string; mime: string; data: string }[] }): Promise<string>;
  getPermissionMode(): Promise<'ask' | 'auto'>;
  agentPreferences(): Promise<{ values: AgentPreferences; defaults: AgentPreferences; limits: Record<'answerTokens' | 'maxIterations' | 'historyMessages', { min: number; max: number; default: number }> }>;
  setAgentPreferences(change: Partial<AgentPreferences>): Promise<AgentPreferences>;
  onMenu(callback: (value: { action: 'preferences' | 'open-folder' | 'new-chat' | 'save' | 'toggle-pane'; pane?: string }) => void): () => void;
  reportPanes(panes: Record<string, boolean>): void;
  dictationInfo(): Promise<{ preferences: DictationPreferences; languages: DictationPreferences['language'][]; models: { id: string; label: string; repo: string; bytes: number; installed: boolean }[] }>;
  setDictationPreferences(change: Partial<DictationPreferences>): Promise<DictationPreferences>;
  askMicrophone(): Promise<boolean>;
  transcribe(audio: { data: string }): Promise<{ text: string }>;
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
  /** Deletes one conversation; saving never deletes the ones it is not given. */
  deleteChatSession(id: string): Promise<boolean>;
  /** The conversations in the trash (deleted ones go there and can be restored). */
  deletedChatSessions(): Promise<(ChatSession & { deletedAt: string })[]>;
  restoreChatSession(id: string): Promise<ChatSession | null>;
  emptyChatTrash(): Promise<number>;
  recordVerifiedExperience(experience: VerifiedExperience): Promise<{ id: string; saved: boolean }>;
  startBenchmark(request: { repeat: 1 | 2; tasks?: string[] }): Promise<{ started: boolean; id: string }>;
  cancelBenchmark(): Promise<{ cancelled: boolean }>;
  benchmarkStatus(): Promise<{ running: boolean; model?: string; current?: BenchmarkCurrent | null }>;
  listBenchmarks(): Promise<BenchmarkList>;
  benchmarkReport(id: string): Promise<BenchmarkReport>;
  openBenchmarkProject(id: string, index: number): Promise<ProjectInfo>;
  listBenchmarkProjects(): Promise<BenchmarkProject[]>;
  benchmarkTasks(): Promise<BenchmarkTask[]>;
  onBenchmarkProgress(callback: (value: { step: string; message: string; id?: string; current?: BenchmarkCurrent }) => void): () => void;
  learningVersions(): Promise<LearningVersions>;
  trainBeta(): Promise<{ started: boolean }>;
  prepareStable(): Promise<{ started: boolean }>;
  promoteStable(name: string): Promise<{ label: string; id: string; models: LocalModelOption[] }>;
  deleteBeta(folder: string): Promise<{ deleted: string }>;
  trainingPreferences(): Promise<{ values: TrainingPreferences; defaults: TrainingPreferences; limits: Record<keyof TrainingPreferences, { min: number; max: number; default: number }> }>;
  setTrainingPreferences(change: Partial<TrainingPreferences>): Promise<TrainingPreferences>;
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
