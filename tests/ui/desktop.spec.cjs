const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const sharp = require('sharp');
let root, input, output, application, page, errors;
test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lofi-ui-'));
  input = path.join(root, 'input'); output = path.join(root, 'output');
  await fs.mkdir(input); await fs.mkdir(output);
  for (const [folder, name, color] of [[input, 'A #1.PNG', 'red'], [input, 'B.png', 'blue'], [output, 'output.png', 'green']]) await sharp({ create: { width: 20, height: 10, channels: 3, background: color } }).png().toFile(path.join(folder, name));
  const env = { ...process.env, LDP_DATA_DIR: path.join(root, 'app-data') }; delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [path.join(__dirname, '../../main.js'), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], env });
  page = await application.firstWindow(); errors = []; page.on('pageerror', e => errors.push(e.message));
  await expect(page.locator('#status')).toContainText('Ready.');
});
test.afterEach(async () => { if (application) await application.close(); await fs.rm(root, { recursive: true, force: true }); });
async function pick(kind, folder) {
  await application.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, folder);
  await page.locator(`#pick-${kind}`).click();
  await expect(page.locator(`#${kind}-path`)).toHaveText(folder);
}
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
    await page.locator('#api-model').fill('mock-vision'); await page.locator('#save-api').click();
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
