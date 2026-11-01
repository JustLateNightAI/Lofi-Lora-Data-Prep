const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const sharp = require('sharp');
let root, input, output, application, page, errors;
test.beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lofi-ui-')));
  input = path.join(root, 'input'); output = path.join(root, 'output');
  await fs.mkdir(input); await fs.mkdir(output);
  for (const [folder, name, color] of [[input, 'A #1.PNG', 'red'], [input, 'B.png', 'blue'], [output, 'output.png', 'green']]) await sharp({ create: { width: 20, height: 10, channels: 3, background: color } }).png().toFile(path.join(folder, name));
  const env = { ...process.env, LDP_DATA_DIR: path.join(root, 'app-data') }; delete env.ELECTRON_RUN_AS_NODE;
  const packaged = !!process.env.LDP_TEST_PACKAGED;
  const executablePath = packaged ? process.env.LDP_TEST_EXECUTABLE || path.resolve(__dirname, '../../dist', process.platform === 'win32' ? 'win-unpacked/Lofi Data Prep.exe' : 'linux-unpacked/lofi-data-prep') : undefined;
  application = await electron.launch({ executablePath, args: [...(packaged ? [] : [path.join(__dirname, '../../main.js')]), ...(process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=headless'] : [])], env });
  expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(packaged);
  page = await application.firstWindow(); errors = []; page.on('pageerror', e => errors.push(e.message));
  await expect(page.locator('#status')).toContainText('Ready.');
});
test.afterEach(async () => { if (application) await application.close(); await fs.rm(root, { recursive: true, force: true }); });
async function pick(kind, folder) {
  await application.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, folder);
  await page.locator(`#pick-${kind}`).click();
  await expect(page.locator(`#${kind}-path`)).toHaveText(await fs.realpath(folder));
}
test('folder chooser cancels safely, remembers the folder, and recovers after an error', async () => {
  async function pendingPicker() {
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (_window, options) => new Promise((resolve, reject) => {
        globalThis.picker = { options, resolve, reject };
      });
    });
    await page.locator('#pick-input').click();
    await expect.poll(() => application.evaluate(() => !!globalThis.picker)).toBe(true);
    await expect(page.locator('#status')).toHaveText('Opening folder chooser…');
    await expect(page.locator('#pick-input')).toBeDisabled();
  }
  await pendingPicker();
  expect(await application.evaluate(({ app }) => globalThis.picker.options.defaultPath === app.getPath('home'))).toBe(true);
  expect(await page.evaluate(() => globalThis.LDP.pickFolder('output').then(() => '', error => error.message))).toContain('Wait for the current operation');
  await application.evaluate(() => { globalThis.picker.resolve({ canceled: true, filePaths: [] }); delete globalThis.picker; });
  await expect(page.locator('#status')).toHaveText('Folder selection cancelled.');
  await expect(page.locator('#pick-input')).toBeEnabled();
  expect((await page.evaluate(() => globalThis.LDP.state())).settings.inputDir).toBeNull();
  await pick('input', input);
  await pendingPicker();
  expect(await application.evaluate(() => globalThis.picker.options.defaultPath)).toBe(input);
  await application.evaluate(() => { globalThis.picker.reject(new Error('Chooser unavailable')); delete globalThis.picker; });
  await expect(page.locator('#status')).toContainText('Chooser unavailable');
  await expect(page.locator('#pick-input')).toBeEnabled();
  await expect(page.locator('#input-path')).toHaveText(input);
  await pick('output', output);
  expect(errors).toEqual([]);
});
test('desktop opens images, saves a new caption, and restores it with undo', async () => {
  await pick('input', input); await expect(page.locator('.tile')).toHaveCount(2);
  await page.getByRole('button', { name: 'Edit A #1.PNG', exact: true }).click();
  await expect(page.locator('#editor-text')).toBeEnabled();
  await expect(page.locator('#editor-image')).toBeVisible();
  await expect.poll(() => page.locator('#editor-image').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  await page.locator('#editor-text').fill('A red rectangle.'); await page.locator('#editor-save').click();
  await expect(page.locator('#editor')).not.toBeVisible();
  expect(await fs.readFile(path.join(input, 'A #1.txt'), 'utf8')).toBe('A red rectangle.');
  await page.locator('#undo').click(); await expect(page.locator('#status')).toContainText('Undid Save caption');
  await expect.poll(() => fs.access(path.join(input, 'A #1.txt')).then(() => true, () => false)).toBe(false);
  expect(errors).toEqual([]);
});
test('late caption reads cannot replace the newly selected image caption', async () => {
  await pick('input', input);
  await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('caption:read');
    ipcMain.handle('caption:read', async (_event, image) => {
      const first = image.includes('A #1'); await new Promise(resolve => setTimeout(resolve, first ? 500 : 10));
      return { ok: true, value: { text: first ? 'caption A' : 'caption B', hash: null } };
    });
  });
  await page.getByRole('button', { name: 'Edit A #1.PNG', exact: true }).click();
  await page.locator('#editor-next').click();
  await expect(page.locator('#editor-name')).toHaveText('B.png');
  await expect(page.locator('#editor-text')).toHaveValue('caption B');
  await page.waitForTimeout(650);
  await expect(page.locator('#editor-text')).toHaveValue('caption B'); expect(errors).toEqual([]);
});
test('API captioning targets the chosen output folder and preserves existing input captions', async () => {
  let calls = 0; let requestBody;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'mock-vision' }] })); return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    calls++; requestBody = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'A green rectangle.' }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fs.writeFile(path.join(input, 'B.txt'), 'keep this caption');
    await pick('input', input); await pick('output', output);
    await page.locator('#working-folder').selectOption('output'); await expect(page.locator('.tile')).toHaveCount(1);
    await page.locator('#api-panel summary').click();
    await page.locator('#api-url').fill(`http://127.0.0.1:${server.address().port}/v1`);
    await expect(page.locator('#api-model option[value="mock-vision"]')).toHaveCount(1);
    await expect(page.locator('#api-model')).toHaveValue('mock-vision');
    await page.locator('#api-model').selectOption('mock-vision'); await page.locator('#save-api').click();
    await expect(page.locator('#status')).toHaveText('API settings saved.');
    await page.locator('#generate').click();
    await expect(page.locator('#job-status')).toContainText('complete: 1/1');
    expect(calls).toBe(1); expect(requestBody.model).toBe('mock-vision');
    expect(await fs.readFile(path.join(output, 'output.txt'), 'utf8')).toBe('A green rectangle.');
    expect(await fs.readFile(path.join(input, 'B.txt'), 'utf8')).toBe('keep this caption');
    expect(await fs.readdir(input)).not.toContain('A #1.txt'); expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('desktop.png'), fullPage: true });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('model dropdown loads with a new key, refreshes with the saved key, and reports errors', async () => {
  let fail = false; const authorizations = [];
  const server = http.createServer((req, res) => {
    authorizations.push(req.headers.authorization);
    res.writeHead(fail ? 401 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fail ? { error: 'do-not-echo-this-secret' } : { data: [{ id: 'vision-b' }, { id: 'vision-a' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.locator('#api-panel summary').click();
    await page.locator('#api-url').fill(`127.0.0.1:${server.address().port}`);
    await page.locator('#api-key').fill('synthetic-key');
    await expect(page.locator('#api-model option')).toHaveText(['Choose a model…', 'vision-a', 'vision-b']);
    await page.locator('#api-model').selectOption('vision-b'); await page.locator('#save-api').click();
    await expect(page.locator('#status')).toHaveText('API settings saved.');
    await expect(page.locator('#api-key')).toHaveValue('');
    await page.locator('#refresh-models').click(); await expect(page.locator('#model-status')).toContainText('2 models available');
    await expect(page.locator('#api-model')).toHaveValue('vision-b');
    expect(authorizations).toEqual(['Bearer synthetic-key', 'Bearer synthetic-key']);
    fail = true; await page.locator('#refresh-models').click();
    await expect(page.locator('#model-status')).toHaveText('Models HTTP 401. Check your API key.');
    await expect(page.locator('#api-model')).toHaveValue('vision-b'); expect(errors).toEqual([]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('late model lists cannot replace choices from a newly selected endpoint', async () => {
  let started, delivered;
  const oldStarted = new Promise(resolve => { started = resolve; });
  const oldDelivered = new Promise(resolve => { delivered = resolve; });
  const server = http.createServer((req, res) => {
    const old = req.url.startsWith('/old/');
    if (old) started();
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: old ? 'old-model' : 'new-model' }] }));
      if (old) delivered();
    }, old ? 1000 : 0);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.locator('#api-panel summary').click();
    await page.locator('#api-url').fill(`${base}/old/v1`); await page.locator('#refresh-models').click(); await oldStarted;
    await page.locator('#api-url').fill(`${base}/new/v1`); await page.locator('#refresh-models').click();
    await expect(page.locator('#api-model')).toHaveValue('new-model');
    await oldDelivered;
    await page.waitForTimeout(100);
    await expect(page.locator('#api-model option')).toHaveText(['Choose a model…', 'new-model']);
    expect(errors).toEqual([]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
