const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('agentic', {
  openProject: () => ipcRenderer.invoke('project:open'),
  currentProject: () => ipcRenderer.invoke('project:current'),
  readFile: (relativePath) => ipcRenderer.invoke('project:read', relativePath),
  writeFile: (relativePath, content) => ipcRenderer.invoke('project:write', relativePath, content),
  ask: (prompt) => ipcRenderer.invoke('agent:ask', prompt),
  recentHistory: () => ipcRenderer.invoke('history:recent'),
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
