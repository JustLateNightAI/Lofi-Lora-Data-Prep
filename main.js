// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs/promises');           // single fs/promises import
const os = require('os');

let sidecarProc = null;
let mainWin;

// ---------- Window ----------
function createWindow() {
  mainWin = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
    show: false,
  });

  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.on('ready-to-show', () => mainWin.show());
  mainWin.on('closed', () => { mainWin = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ---------- JoyCaption sidecar ----------
function startSidecar(opts = {}) {
  const env = Object.assign({}, process.env, {
    JOYCAPTION_PORT: String(opts.port || 5057),
    JOYCAPTION_MODEL_ID: 'fancyfeast/llama-joycaption-beta-one-hf-llava',
    JOYCAPTION_CACHE: path.join(app.getPath('userData'), 'models', 'joycaption'),
  });

  if (app.isPackaged) {
    // ✅ packaged: use the bundled EXE from extraResources
    const exePath = path.join(process.resourcesPath, 'sidecar', 'server.exe');
    sidecarProc = spawn(exePath, [], { env });
  } else {
    // 🧪 dev: use your venv’s python to run server.py
    const py = process.platform === 'win32'
      ? path.join(__dirname, 'sidecar', '.venv', 'Scripts', 'python.exe')
      : path.join(__dirname, 'sidecar', '.venv', 'bin', 'python');

    const script = path.join(__dirname, 'sidecar', 'server.py');
    sidecarProc = spawn(py, [script], { env });
  }

  sidecarProc.stdout.on('data', d => console.log('[joycaption]', String(d)));
  sidecarProc.stderr.on('data', d => console.warn('[joycaption-err]', String(d)));
  sidecarProc.on('exit', code => { console.warn('JoyCaption sidecar exited:', code); });
}

app.whenReady().then(() => {
  startSidecar({ port: 5057 });
});

// ---------- Templates FS wiring (~/LofiTagger/taggingStyle) ----------
const TEMPLATES_DIR = path.join(os.homedir(), 'LofiTagger', 'taggingStyle');

async function ensureTemplatesDir() {
  await fs.mkdir(TEMPLATES_DIR, { recursive: true });
}

let templatesHandlersRegistered = false;
function registerTemplateIpcHandlers() {
  if (templatesHandlersRegistered) return;
  templatesHandlersRegistered = true;

  ipcMain.handle('templates:list', async () => {
    await ensureTemplatesDir();
    const entries = await fs.readdir(TEMPLATES_DIR, { withFileTypes: true });
    const files = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.txt'));
    return files.map(f => {
      const label = path.basename(f.name, '.txt');
      return { id: `file:${label}`, label, contentPath: path.join(TEMPLATES_DIR, f.name) };
    });
  });

  ipcMain.handle('templates:read', async (_evt, label) => {
    const file = path.join(TEMPLATES_DIR, `${label}.txt`);
    const content = await fs.readFile(file, 'utf8');
    return { label, content };
  });

  ipcMain.handle('templates:save', async (_evt, { label, content }) => {
    await ensureTemplatesDir();
    const file = path.join(TEMPLATES_DIR, `${label}.txt`);
    await fs.writeFile(file, content ?? '', 'utf8');
    return { ok: true, id: `file:${label}` };
  });

  ipcMain.handle('templates:delete', async (_evt, label) => {
    const file = path.join(TEMPLATES_DIR, `${label}.txt`);
    await fs.rm(file, { force: true });
    return { ok: true };
  });
}

app.whenReady().then(async () => {
  await ensureTemplatesDir();
  registerTemplateIpcHandlers();
});

// ---------- Graceful shutdown ----------
app.on('will-quit', () => {
  try { sidecarProc && sidecarProc.kill(); } catch (e) {}
});

// ---------- JoyCaption prompt IPC ----------
ipcMain.handle('joy:prompt', async (_evt, { imagePath, device = 'gpu', quant = 'bf16', imageSide = 448, maxTokens = 512 }) => {
  // Ensure fetch exists (Node/Electron versions differ)
  const fetchFn = (typeof fetch === 'function')
    ? fetch
    : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

  const FormData = require('form-data');
  const fsNode = require('fs'); // regular fs for reading the image as a Buffer

  const url = 'http://127.0.0.1:5057/predict';
  const data = await fsNode.promises.readFile(imagePath);
  const form = new FormData();
  form.append('device', device);
  form.append('quant', quant);
  form.append('image_side', String(imageSide));
  form.append('max_tokens', String(maxTokens));
  form.append('image', data, { filename: path.basename(imagePath) });

  const res = await fetchFn(url, { method: 'POST', body: form });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || 'JoyCaption error');
  return json.text;
});

// ---------- Dialogs ----------
ipcMain.handle('dialog:select-folder', async () => {
  const res = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory'] });
  if (res.canceled) return null;
  return res.filePaths[0];
});

// ---------- App actions (existing) ----------
const loadFolder     = require('./actions/loadFolder');
const convertFormat  = require('./actions/convertFormat');
const shuffleDataset = require('./actions/shuffleDataset');
const batchRename    = require('./actions/batchRename');
const deleteItems    = require('./actions/deleteItems');
const undoManager    = require('./actions/undoManager');

ipcMain.handle('folder:scan',   (_e, dir)      => loadFolder(dir));
ipcMain.handle('action:convert',(_e, payload)  => convertFormat(payload));
ipcMain.handle('action:shuffle',(_e, payload)  => shuffleDataset(payload));
ipcMain.handle('action:rename', (_e, payload)  => batchRename(payload));
ipcMain.handle('action:delete', (_e, payload)  => deleteItems(payload));
ipcMain.handle('undo:perform',  ()             => undoManager.undo());

// ---------- Simple file read/write IPC (reuses fs/promises above) ----------
ipcMain.handle('file:readText', async (_e, pathArg) => {
  try {
    const buf = await fs.readFile(pathArg, 'utf8');
    return { ok: true, text: buf };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('file:writeText', async (_e, { path: pathArg, text }) => {
  try {
    await fs.writeFile(pathArg, text ?? '', 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
