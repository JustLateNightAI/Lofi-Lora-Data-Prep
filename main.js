const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');

let mainWin;

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  });

  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.on('ready-to-show', () => mainWin.show());
  mainWin.on('closed', () => { mainWin = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

/* IPC: Dialogs */
ipcMain.handle('dialog:select-folder', async (_evt, _args) => {
  const res = await dialog.showOpenDialog(mainWin, {
    properties: ['openDirectory']
  });
  if (res.canceled) return null;
  return res.filePaths[0];
});

/* IPC: Actions */
const loadFolder = require('./actions/loadFolder');
const convertFormat = require('./actions/convertFormat');
const shuffleDataset = require('./actions/shuffleDataset');
const batchRename = require('./actions/batchRename');
const deleteItems = require('./actions/deleteItems');
const undoManager = require('./actions/undoManager');

ipcMain.handle('folder:scan', (_e, dir) => loadFolder(dir));
ipcMain.handle('action:convert', (_e, payload) => convertFormat(payload));
ipcMain.handle('action:shuffle', (_e, payload) => shuffleDataset(payload));
ipcMain.handle('action:rename', (_e, payload) => batchRename(payload));
ipcMain.handle('action:delete', (_e, payload) => deleteItems(payload));
ipcMain.handle('undo:perform', () => undoManager.undo());


const fs = require('fs/promises');

ipcMain.handle('file:readText', async (_e, path) => {
  try {
    const buf = await fs.readFile(path, 'utf8');
    return { ok: true, text: buf };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('file:writeText', async (_e, { path, text }) => {
  try {
    await fs.writeFile(path, text ?? '', 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
