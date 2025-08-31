// preload.js
const { contextBridge, ipcRenderer } = require('electron');

// ---- JoyCaption bridge ----
contextBridge.exposeInMainWorld('joy', {
  prompt: (imagePath, opts) => ipcRenderer.invoke('joy:prompt', { imagePath, ...opts }),
});

// ---- LDP (your existing app bridge) ----
contextBridge.exposeInMainWorld('LDP', {
  // dialogs
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),

  // folder scan
  scanFolder: (dir) => ipcRenderer.invoke('folder:scan', dir),

  // actions
  convert:      (payload) => ipcRenderer.invoke('action:convert', payload),
  shuffle:      (payload) => ipcRenderer.invoke('action:shuffle', payload),
  renameBatch:  (payload) => ipcRenderer.invoke('action:rename', payload),
  deleteItems:  (payload) => ipcRenderer.invoke('action:delete', payload),

  // undo
  undo: () => ipcRenderer.invoke('undo:perform'),

  // tag files
  readText: (path) => ipcRenderer.invoke('file:readText', path),

  // Accept BOTH forms:
  //   writeText(path, text)
  //   writeText({ path, text })
  writeText: (arg1, arg2) => {
    const payload = (typeof arg1 === 'string')
      ? { path: arg1, text: arg2 }
      : (arg1 || {});
    return ipcRenderer.invoke('file:writeText', payload);
  },
});

// ---- File‑based Templates bridge ----
contextBridge.exposeInMainWorld('Templates', {
  list:   () => ipcRenderer.invoke('templates:list'),
  read:   (label) => ipcRenderer.invoke('templates:read', label),
  save:   ({ label, content }) => ipcRenderer.invoke('templates:save', { label, content }),
  remove: (label) => ipcRenderer.invoke('templates:delete', label),
});
