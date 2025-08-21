// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('LDP', {
  // dialogs
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),

  // folder scan
  scanFolder: (dir) => ipcRenderer.invoke('folder:scan', dir),

  // actions
  convert: (payload) => ipcRenderer.invoke('action:convert', payload),
  shuffle: (payload) => ipcRenderer.invoke('action:shuffle', payload),
  renameBatch: (payload) => ipcRenderer.invoke('action:rename', payload),
  deleteItems: (payload) => ipcRenderer.invoke('action:delete', payload),

  // undo
  undo: () => ipcRenderer.invoke('undo:perform'),

  // tag files
  readText: (path) => ipcRenderer.invoke('file:readText', path),
  writeText: (path, text) => ipcRenderer.invoke('file:writeText', { path, text })
});
