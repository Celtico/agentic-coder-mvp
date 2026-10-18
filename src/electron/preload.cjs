const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('agentic', {
  openProject: () => ipcRenderer.invoke('project:open'),
  currentProject: () => ipcRenderer.invoke('project:current'),
  deletedBackups: () => ipcRenderer.invoke('project:deleted-backups'),
  restoreDeletedBackup: (backupId) => ipcRenderer.invoke('project:restore-deleted-backup', backupId),
  projectForChat: (sessionId) => ipcRenderer.invoke('project:for-chat', sessionId),
  readFile: (relativePath) => ipcRenderer.invoke('project:read', relativePath),
  writeFile: (relativePath, content) => ipcRenderer.invoke('project:write', relativePath, content),
  ask: (prompt) => ipcRenderer.invoke('agent:ask', prompt),
  cancel: () => ipcRenderer.invoke('agent:cancel'),
  gitSnapshot: () => ipcRenderer.invoke('git:snapshot'),
  recentHistory: () => ipcRenderer.invoke('history:recent'),
  loadChatSessions: () => ipcRenderer.invoke('chat-store:load'),
  saveChatSessions: (sessions) => ipcRenderer.invoke('chat-store:save', sessions),
  recordVerifiedExperience: (experience) => ipcRenderer.invoke('learning:record-verified-experience', experience),
  runTests: () => ipcRenderer.invoke('project:run-tests'),
  runCommand: (command) => ipcRenderer.invoke('terminal:run', command),
  onTerminalOutput: (callback) => {
    const listener = (_e, value) => callback(value);
    ipcRenderer.on('terminal:output', listener);
    return () => ipcRenderer.removeListener('terminal:output', listener);
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
