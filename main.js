const { app, BrowserWindow, ipcMain, dialog, safeStorage, protocol, net } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sharp = require('sharp');
const scan = require('./actions/loadFolder');
const operations = require('./actions/operations');
const undo = require('./actions/undoManager');
const { digest } = require('./actions/transactions');
const { pickTargets, portableName, IMAGE_EXTENSIONS } = require('./actions/paths');
const { Settings } = require('./lib/settings');
const { CaptionJobs } = require('./lib/jobs');
const { caption } = require('./lib/vision');

protocol.registerSchemesAsPrivileged([{ scheme: 'ldp-image', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (process.env.LDP_DATA_DIR) app.setPath('userData', path.resolve(process.env.LDP_DATA_DIR));
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
let win, settings, history, jobs, quitting = false, mutation = false;
let startupError = '';
const shellURL = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;

async function approvedDirectory(dir) {
  if (typeof dir !== 'string' || !settings.value.roots.includes(dir)) throw new Error('Choose this folder using the folder picker first.');
  const real = await fs.realpath(dir);
  if (real !== dir) throw new Error('The selected folder moved or changed. Select it again.');
  return real;
}
async function approvedImage(imagePath) {
  if (typeof imagePath !== 'string') throw new Error('Invalid image.');
  const dir = await approvedDirectory(path.dirname(imagePath));
  const item = (await scan(dir)).items.find(i => i.imagePath === imagePath);
  if (!item) throw new Error('Image is missing or is not a supported regular file.');
  return item;
}
async function approvedImageFile(file) {
  if (typeof file !== 'string' || !IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) throw new Error('Invalid image.');
  await approvedDirectory(path.dirname(file));
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new Error('Only regular image files are allowed.');
  return stat;
}
async function readCaption(imagePath) {
  const item = await approvedImage(imagePath);
  if (item.ambiguous) throw new Error('Multiple files share this caption stem. Resolve their names first.');
  const hash = await digest(item.captionPath);
  const text = hash ? await fs.readFile(item.captionPath, 'utf8') : '';
  if (await digest(item.captionPath) !== hash) throw new Error('Caption changed while reading. Open it again.');
  return { text, hash };
}
async function saveCaption(item, text) {
  const current = await approvedImage(item.imagePath);
  if (current.ambiguous || current.captionPath !== item.captionPath) throw new Error('Image/caption pairing changed. Refresh the folder.');
  if (typeof text !== 'string' || text.length > 20000) throw new Error('Caption must be text shorter than 20,000 characters.');
  if (item.imageHash && await digest(item.imagePath) !== item.imageHash) throw new Error('Image changed before caption save.');
  // Idempotent recovery if the app quit after saving but before recording job completion.
  if (item.text && await digest(current.captionPath) !== item.captionHash) {
    const existing = await fs.readFile(current.captionPath, 'utf8').catch(() => null);
    if (existing === text) return { ok: true, changed: 0 };
  }
  return history.execute('Save caption', [{ target: current.captionPath, content: text, replace: true, expected: item.captionHash }]);
}
function idle() {
  if (startupError) throw new Error(startupError);
  if (mutation || jobs.running) throw new Error('Wait for the current operation, or cancel captioning first.');
}
function handle(name, fn) {
  ipcMain.handle(name, async (event, payload) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== shellURL) return { ok: false, error: 'Untrusted request.' };
    try { return { ok: true, value: await fn(payload) }; }
    catch (e) { return { ok: false, error: e.message || 'Operation failed.' }; }
  });
}
function registerHandlers() {
  handle('app:state', () => ({ settings: settings.public(), job: jobs.snapshot(), startupError }));
  handle('folder:pick', async kind => {
    idle();
    if (!['input', 'output'].includes(kind)) throw new Error('Invalid folder type.');
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled) return null;
    const dir = await fs.realpath(result.filePaths[0]);
    if (!settings.value.roots.includes(dir)) settings.value.roots.push(dir);
    settings.value[`${kind}Dir`] = dir;
    if (settings.value.inputDir === settings.value.outputDir) settings.value.outputDir = null;
    await settings.persist(); return settings.public();
  });
  handle('folder:clear-output', async () => { idle(); settings.value.outputDir = null; await settings.persist(); return settings.public(); });
  handle('folder:scan', async dir => {
    await approvedDirectory(dir);
    const result = await scan(dir);
    result.items = result.items.map(item => ({ ...item, imageUrl: `ldp-image://image/?path=${encodeURIComponent(item.imagePath)}` }));
    return result;
  });
  handle('caption:read', readCaption);
  handle('caption:save', async ({ imagePath, text, hash }) => {
    idle(); mutation = true;
    try {
      if (hash !== null && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) throw new Error('Read this caption before editing it.');
      const item = await approvedImage(imagePath); return await saveCaption({ ...item, captionHash: hash }, text);
    }
    finally { mutation = false; }
  });
  handle('action:run', async payload => {
    idle(); mutation = true;
    try {
      const action = { rename: operations.rename, shuffle: operations.shuffle, convert: operations.convert, delete: operations.remove }[payload.kind];
      if (!action) throw new Error('Unknown operation.');
      await approvedDirectory(payload.inDir);
      const outDir = payload.outDir ? await approvedDirectory(payload.outDir) : null;
      return await action({ ...payload, outDir: outDir === payload.inDir ? null : outDir, items: (await scan(payload.inDir)).items });
    } finally { mutation = false; }
  });
  handle('undo:perform', async () => { idle(); mutation = true; try { return await history.undo(); } finally { mutation = false; } });
  handle('settings:api', async input => { idle(); return settings.saveApi(input); });
  handle('job:start', async payload => {
    idle(); mutation = true;
    try {
      await approvedDirectory(payload.dir);
      const items = pickTargets((await scan(payload.dir)).items, payload.scope, payload.selectedPaths);
      return await jobs.start(items, settings.value.api, payload.mode);
    } finally { mutation = false; }
  });
  handle('job:cancel', () => jobs.cancel());
  handle('job:resume', async () => { idle(); mutation = true; try { return await jobs.resume(); } finally { mutation = false; } });
  handle('job:review', async ({ imagePath, text }) => { idle(); mutation = true; try { return await jobs.review(imagePath, text); } finally { mutation = false; } });
  const templateDir = path.join(app.getPath('home'), 'LofiTagger', 'taggingStyle');
  handle('templates:list', async () => {
    await fs.mkdir(templateDir, { recursive: true });
    const entries = await fs.readdir(templateDir, { withFileTypes: true });
    const templates = [];
    for (const e of entries) if (e.isFile() && e.name.endsWith('.txt')) templates.push({ label: e.name.slice(0, -4), content: await fs.readFile(path.join(templateDir, e.name), 'utf8') });
    return templates;
  });
  handle('templates:save', async ({ label, content }) => {
    idle(); portableName(label);
    if (typeof content !== 'string' || content.length > 20000) throw new Error('Invalid template.');
    await fs.mkdir(templateDir, { recursive: true });
    const file = path.join(templateDir, `${label}.txt`);
    if (await digest(file)) throw new Error('Template name already exists. Choose a new name.');
    return history.execute('Save template', [{ target: file, content, expected: null }]);
  });
}
async function initialize() {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  settings = new Settings(app.getPath('userData'), safeStorage);
  await settings.load();
  history = undo.configure(path.join(app.getPath('userData'), 'history'));
  try { await history.recover(); } catch (e) { startupError = e.message; }
  jobs = new CaptionJobs(path.join(app.getPath('userData'), 'jobs'), {
    generate: (file, config, key, signal) => caption(file, config, key, signal, net.fetch),
    saveCaption, validateImage: approvedImage, getKey: base => settings.keyFor(base),
    notify: job => { if (win && !win.isDestroyed()) win.webContents.send('job:update', job); }
  });
  await jobs.load();
  const thumbnails = new Map();
  protocol.handle('ldp-image', async request => {
    try {
      const url = new URL(request.url);
      const file = url.searchParams.get('path');
      const stat = await approvedImageFile(file);
      const size = url.searchParams.has('full') ? 1600 : 320;
      const key = `${file}:${stat.mtimeMs}:${stat.size}:${size}`;
      let buffer = thumbnails.get(key);
      if (!buffer) {
        buffer = await sharp(file, { limitInputPixels: 100000000 }).rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
        thumbnails.set(key, buffer);
        if (thumbnails.size > 128) thumbnails.delete(thumbnails.keys().next().value);
      }
      return new Response(buffer, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } });
    } catch { return new Response('Image unavailable', { status: 404 }); }
  });
  registerHandlers();
  win = new BrowserWindow({ width: 1280, height: 900, minWidth: 960, minHeight: 680,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}
if (primaryInstance) app.whenReady().then(initialize).catch(e => { dialog.showErrorBox('Lofi Data Prep could not start', e.message); app.quit(); });
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting || !jobs) return;
  event.preventDefault(); quitting = true; jobs.cancel();
  Promise.allSettled([jobs.work, history.tail, settings.tail]).then(() => app.quit());
});
