const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('agentic', {
  openProject: () => ipcRenderer.invoke('project:open'),
  createProjectEntry: (relativePath, directory) => ipcRenderer.invoke('project:create-entry', relativePath, directory),
  deleteProjectEntry: (relativePath, directory) => ipcRenderer.invoke('project:delete-entry', relativePath, directory),
  renameProjectEntry: (relativePath, newName) => ipcRenderer.invoke('project:rename-entry', relativePath, newName),
  importProjectDirectory: (file) => ipcRenderer.invoke('project:import-directory', webUtils.getPathForFile(file)),
  currentProject: () => ipcRenderer.invoke('project:current'),
  clearProject: () => ipcRenderer.invoke('project:clear'),
  deletedBackups: () => ipcRenderer.invoke('project:deleted-backups'),
  restoreDeletedBackup: (backupId) => ipcRenderer.invoke('project:restore-deleted-backup', backupId),
  fileHistory: (relativePath) => ipcRenderer.invoke('project:file-history', relativePath),
  folderHistory: (relativePath) => ipcRenderer.invoke('project:folder-history', relativePath),
  fileHistoryVersion: (relativePath, versionId) => ipcRenderer.invoke('project:file-history-version', relativePath, versionId),
  restoreFileHistory: (relativePath, versionId) => ipcRenderer.invoke('project:restore-file-history', relativePath, versionId),
  projectForChat: (sessionId) => ipcRenderer.invoke('project:for-chat', sessionId),
  readFile: (relativePath) => ipcRenderer.invoke('project:read', relativePath),
  fileExists: (relativePath) => ipcRenderer.invoke('project:exists', relativePath),
  writeFile: (relativePath, content) => ipcRenderer.invoke('project:write', relativePath, content),
  ask: (request) => ipcRenderer.invoke('agent:ask', request),
  getPermissionMode: () => ipcRenderer.invoke('permissions:get'),
  setPermissionMode: (mode) => ipcRenderer.invoke('permissions:set', mode),
  listModels: () => ipcRenderer.invoke('models:list'),
  selectModel: (modelId) => ipcRenderer.invoke('models:select', modelId),
  cancel: () => ipcRenderer.invoke('agent:cancel'),
  gitSnapshot: () => ipcRenderer.invoke('git:snapshot'),
  gitHistory: () => ipcRenderer.invoke('git:history'),
  gitCommitDetails: (hash) => ipcRenderer.invoke('git:commit-details', hash),
  recentHistory: () => ipcRenderer.invoke('history:recent'),
  loadChatSessions: () => ipcRenderer.invoke('chat-store:load'),
  saveChatSessions: (sessions) => ipcRenderer.invoke('chat-store:save', sessions),
  recordVerifiedExperience: (experience) => ipcRenderer.invoke('learning:record-verified-experience', experience),
  learningDatasetPreview: () => ipcRenderer.invoke('learning:dataset-preview'),
  prepareLearningDataset: () => ipcRenderer.invoke('learning:prepare-dataset'),
  startBenchmark: (request) => ipcRenderer.invoke('benchmark:start', request),
  cancelBenchmark: () => ipcRenderer.invoke('benchmark:cancel'),
  benchmarkStatus: () => ipcRenderer.invoke('benchmark:status'),
  listBenchmarks: () => ipcRenderer.invoke('benchmark:list'),
  benchmarkReport: (id) => ipcRenderer.invoke('benchmark:report', id),
  openBenchmarkProject: (id, index) => ipcRenderer.invoke('benchmark:open-project', id, index),
  listBenchmarkProjects: () => ipcRenderer.invoke('benchmark:projects'),
  benchmarkTasks: () => ipcRenderer.invoke('benchmark:tasks'),
  onBenchmarkProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('benchmark:progress', listener);
    return () => ipcRenderer.removeListener('benchmark:progress', listener);
  },
  startTraining: (request) => ipcRenderer.invoke('learning:train-start', request),
  cancelTraining: () => ipcRenderer.invoke('learning:train-cancel'),
  trainingStatus: () => ipcRenderer.invoke('learning:train-status'),
  onTrainingProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('learning:train-progress', listener);
    return () => ipcRenderer.removeListener('learning:train-progress', listener);
  },
  runTests: () => ipcRenderer.invoke('project:run-tests'),
  runCommand: (command) => ipcRenderer.invoke('terminal:run', command),
  onTerminalOutput: (callback) => {
    const listener = (_e, value) => callback(value);
    ipcRenderer.on('terminal:output', listener);
    return () => ipcRenderer.removeListener('terminal:output', listener);
  },
  onProjectStarted: (callback) => {
    const listener = (_e, value) => callback(value);
    ipcRenderer.on('project:started', listener);
    return () => ipcRenderer.removeListener('project:started', listener);
  },
  onStatus: (callback) => {
    const listener = (_e, value) => callback(value);
    ipcRenderer.on('agent:status', listener);
    return () => ipcRenderer.removeListener('agent:status', listener);
  },
  onTestOutput: (callback) => {
    const listener = (_e, value) => callback(value);
    ipcRenderer.on('tests:output', listener);
    return () => ipcRenderer.removeListener('tests:output', listener);
  }
});
