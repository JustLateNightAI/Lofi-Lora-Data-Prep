const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (channel, payload) => {
  const result = await ipcRenderer.invoke(channel, payload);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld('LDP', {
  state: () => invoke('app:state'),
  pickFolder: kind => invoke('folder:pick', kind),
  clearOutput: () => invoke('folder:clear-output'),
  pickToolkit: () => invoke('toolkit:pick'),
  saveToolkit: directory => invoke('toolkit:settings', directory),
  exportToolkit: data => invoke('toolkit:export', data),
  scan: dir => invoke('folder:scan', dir),
  readCaption: file => invoke('caption:read', file),
  saveCaption: data => invoke('caption:save', data),
  action: data => invoke('action:run', data),
  undo: () => invoke('undo:perform'),
  saveApi: data => invoke('settings:api', data),
  models: data => invoke('api:models', data),
  startJob: data => invoke('job:start', data),
  cancelJob: () => invoke('job:cancel'),
  resumeJob: () => invoke('job:resume'),
  reviewCaption: data => invoke('job:review', data),
  templates: () => invoke('templates:list'),
  saveTemplate: data => invoke('templates:save', data),
  onJob: callback => {
    const listener = (_event, job) => callback(job);
    ipcRenderer.on('job:update', listener);
    return () => ipcRenderer.removeListener('job:update', listener);
  }
});
