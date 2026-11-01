const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { exportDataset, validateToolkitDirectory } = require('../lib/ai-toolkit');
const { Transactions } = require('../actions/transactions');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lofi-export-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const toolkitDir = path.join(root, 'AI Toolkit'), sourceDir = path.join(root, 'input');
  await fs.mkdir(path.join(toolkitDir, 'toolkit'), { recursive: true });
  await fs.writeFile(path.join(toolkitDir, 'run.py'), '# test fixture');
  await fs.mkdir(sourceDir);
  const imagePath = path.join(sourceDir, 'Photo #1.PNG');
  await sharp({ create: { width: 20, height: 10, channels: 3, background: 'red' } }).png().toFile(imagePath);
  await fs.writeFile(path.join(sourceDir, 'PHOTO #1.TXT'), 'A red rectangle.');
  return { root, toolkitDir, sourceDir, imagePath, history: new Transactions(path.join(root, 'history')), name: 'my_dataset', selectedPaths: [imagePath] };
}
test('export copies selected image/caption pairs with matching names and supports persistent undo', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.sourceDir, 'unselected.jpg'), 'not selected');
  await fs.writeFile(path.join(f.sourceDir, 'orphan.txt'), 'not an image caption');
  const original = await fs.readFile(f.imagePath);
  const result = await exportDataset(f, f.history);
  assert.equal(result.destination, path.join(f.toolkitDir, 'datasets', 'my_dataset'));
  assert.deepEqual(await fs.readdir(result.destination), ['Photo #1.png', 'Photo #1.txt']);
  assert.deepEqual(await fs.readFile(path.join(result.destination, 'Photo #1.png')), original);
  assert.equal(await fs.readFile(path.join(result.destination, 'Photo #1.txt'), 'utf8'), 'A red rectangle.');
  assert.equal(result.images, 1); assert.equal(result.captions, 1); assert.equal(result.missingCaptions, 0);
  await new Transactions(path.join(f.root, 'history')).undo();
  assert.deepEqual(await fs.readdir(result.destination), []);
  assert.deepEqual(await fs.readFile(f.imagePath), original);
  assert.equal(await fs.readFile(path.join(f.sourceDir, 'PHOTO #1.TXT'), 'utf8'), 'A red rectangle.');
});
test('WebP exports become PNG without changing original images; missing captions are reported', async t => {
  const f = await fixture(t), imagePath = path.join(f.sourceDir, 'second.webp');
  await sharp({ create: { width: 13, height: 7, channels: 4, background: '#0000ff80' } }).webp({ lossless: true }).toFile(imagePath);
  const original = await fs.readFile(imagePath);
  const result = await exportDataset({ ...f, selectedPaths: [imagePath] }, f.history);
  assert.deepEqual(await fs.readdir(result.destination), ['second.png']);
  const metadata = await sharp(path.join(result.destination, 'second.png')).metadata();
  assert.equal(metadata.format, 'png'); assert.equal(metadata.width, 13); assert.equal(metadata.height, 7);
  assert.equal(result.converted, 1); assert.equal(result.missingCaptions, 1); assert.equal(result.captions, 0);
  assert.deepEqual(await fs.readFile(imagePath), original);
  await fs.rename(imagePath, path.join(f.sourceDir, 'renamed.webp'));
});
test('existing datasets, including case variants, are never merged or overwritten', async t => {
  const f = await fixture(t), existing = path.join(f.toolkitDir, 'datasets', 'MY_DATASET');
  await fs.mkdir(existing, { recursive: true }); await fs.writeFile(path.join(existing, 'keep.txt'), 'keep');
  await assert.rejects(exportDataset(f, f.history), /already exists/);
  assert.deepEqual(await fs.readdir(path.dirname(existing)), ['MY_DATASET']);
  assert.equal(await fs.readFile(path.join(existing, 'keep.txt'), 'utf8'), 'keep');
});
test('invalid roots, dataset names, empty selection, and stale selection fail without exporting', async t => {
  const f = await fixture(t);
  await assert.rejects(validateToolkitDirectory(f.sourceDir), /main AI Toolkit folder/);
  await assert.rejects(validateToolkitDirectory('relative/path'), /full path/);
  for (const name of ['../escape', '..', 'CON', 'a/b', 'a\\b', '.hidden', 'name.', ' leading', 'hash#name', 'percent%name', 'space name']) await assert.rejects(exportDataset({ ...f, name }, f.history));
  await assert.rejects(exportDataset({ ...f, selectedPaths: [] }, f.history), /at least one/);
  await assert.rejects(exportDataset({ ...f, selectedPaths: [path.join(f.root, 'outside.png')] }, f.history), /missing or unsupported/);
  assert.deepEqual((await fs.readdir(f.toolkitDir)).sort(), ['run.py', 'toolkit']);
});
test('ambiguous stems and hidden images cannot silently create an unusable dataset', async t => {
  const f = await fixture(t);
  await fs.copyFile(f.imagePath, path.join(f.sourceDir, 'Photo #1.jpg'));
  await assert.rejects(exportDataset(f, f.history), /duplicate image\/caption stems/);
  const hidden = path.join(f.sourceDir, '.hidden.png'); await fs.copyFile(f.imagePath, hidden);
  await assert.rejects(exportDataset({ ...f, selectedPaths: [hidden] }, f.history), /hidden images/);
});
test('failed conversion removes the incomplete export and leaves source files intact', async t => {
  const f = await fixture(t), broken = path.join(f.sourceDir, 'broken.webp');
  await fs.writeFile(broken, 'not a WebP image');
  const original = await fs.readFile(f.imagePath);
  await assert.rejects(exportDataset({ ...f, selectedPaths: [f.imagePath, broken] }, f.history));
  assert.deepEqual(await fs.readdir(path.join(f.toolkitDir, 'datasets')), []);
  assert.deepEqual(await fs.readFile(f.imagePath), original);
  assert.equal(await fs.readFile(broken, 'utf8'), 'not a WebP image');
});
test('dataset-directory symlinks cannot redirect exports outside the chosen installation', async t => {
  const f = await fixture(t), elsewhere = path.join(f.root, 'elsewhere');
  await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, path.join(f.toolkitDir, 'datasets'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(exportDataset(f, f.history), /regular directory/);
  assert.deepEqual(await fs.readdir(elsewhere), []);
});
