const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const operations = require('../actions/operations');
const scan = require('../actions/loadFolder');
const undo = require('../actions/undoManager');
const { Transactions, digest, writeJson } = require('../actions/transactions');
const { portableName, captionPath } = require('../actions/paths');
let root, dir, history;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'lofi-test-')); dir = path.join(root, 'dataset'); await fs.mkdir(dir); history = undo.configure(path.join(root, 'history')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
async function files(map) { for (const [name, value] of Object.entries(map)) await fs.writeFile(path.join(dir, name), value); }
async function snapshot() { const result = {}; for (const name of (await fs.readdir(dir)).sort()) result[name] = (await fs.readFile(path.join(dir, name))).toString('base64'); return result; }
async function payload(extra = {}) { return { items: (await scan(dir)).items, inDir: dir, ...extra }; }
test('selected shuffle refuses an unselected destination and preserves both pairs', async () => {
  await files({ '0000.png': 'unselected', '0000.txt': 'old caption', 'chosen.png': 'selected', 'chosen.txt': 'new caption' });
  const before = await snapshot();
  await assert.rejects(operations.shuffle(await payload({ scope: 'selected', selectedPaths: [path.join(dir, 'chosen.png')] })), /exists/);
  assert.deepEqual(await snapshot(), before);
});
test('cyclic renames and undo preserve every image and caption', async () => {
  await files({ 'set_0000.png': 'A', 'set_0000.txt': 'caption A', 'set_0001.png': 'B', 'set_0001.txt': 'caption B' });
  const before = await snapshot(), p = await payload({ baseName: 'set' }); p.items.reverse();
  await operations.rename(p);
  assert.equal(await fs.readFile(path.join(dir, 'set_0000.png'), 'utf8'), 'B');
  await new Transactions(path.join(root, 'history')).undo();
  assert.deepEqual(await snapshot(), before);
});
test('rename collision fails before changing any original', async () => {
  await files({ 'a.png': 'A', 'set_0000.png': 'B', 'set_0001.png': 'unselected' });
  const before = await snapshot(), p = await payload({ baseName: 'set', scope: 'selected', selectedPaths: [path.join(dir, 'a.png'), path.join(dir, 'set_0000.png')] });
  await assert.rejects(operations.rename(p), /exists/); assert.deepEqual(await snapshot(), before);
});
test('empty selected scope is a no-op', async () => {
  await files({ 'a.png': 'A', 'b.png': 'B' }); const before = await snapshot();
  await operations.rename(await payload({ baseName: 'renamed', scope: 'selected', selectedPaths: [] }));
  assert.deepEqual(await snapshot(), before);
});
test('shuffle and deletion have persistent undo', async () => {
  await files({ 'a.png': 'A', 'a.txt': 'caption' }); const before = await snapshot();
  await operations.shuffle(await payload()); await history.undo(); assert.deepEqual(await snapshot(), before);
  await operations.remove(await payload({ scope: 'selected', selectedPaths: [path.join(dir, 'a.png')] }));
  assert.deepEqual(await fs.readdir(dir), []); await new Transactions(path.join(root, 'history')).undo(); assert.deepEqual(await snapshot(), before);
});
test('copy mode rejects occupied captions even when image destination is empty', async () => {
  await files({ 'a.png': 'A', 'a.txt': 'caption' }); const output = path.join(root, 'output'); await fs.mkdir(output); await fs.writeFile(path.join(output, 'copy_0000.txt'), 'keep');
  await assert.rejects(operations.rename(await payload({ baseName: 'copy', outDir: output })), /exists/);
  assert.deepEqual(await fs.readdir(output), ['copy_0000.txt']);
});
test('conversion rejects collisions and skips same format', async () => {
  await sharp({ create: { width: 4, height: 3, channels: 3, background: 'red' } }).png().toFile(path.join(dir, 'a.png'));
  const before = await snapshot();
  assert.equal((await operations.convert(await payload({ targetExt: '.png' }))).skipped, 1);
  await fs.writeFile(path.join(dir, 'a.jpg'), 'unselected original');
  await assert.rejects(operations.convert({ items: [{ imagePath: path.join(dir, 'a.png') }], targetExt: '.jpg' }), /exists/);
  await fs.unlink(path.join(dir, 'a.jpg')); await operations.convert(await payload({ targetExt: '.jpg' }));
  assert.deepEqual(await fs.readdir(dir), ['a.jpg']); await history.undo(); assert.deepEqual(await snapshot(), before);
});
test('failed image decoding leaves the whole batch unchanged', async () => {
  await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toFile(path.join(dir, 'a.png'));
  await files({ 'b.png': 'corrupt' }); const before = await snapshot();
  await assert.rejects(operations.convert(await payload({ targetExt: '.jpg' }))); assert.deepEqual(await snapshot(), before);
});
test('scan pairs uppercase extensions and encodes URL punctuation', async () => {
  await files({ 'PHOTO #1.PNG': 'image', 'PHOTO #1.txt': 'caption' });
  const item = (await scan(dir)).items[0];
  assert.equal(item.tagPath, path.join(dir, 'PHOTO #1.txt')); assert.match(item.imageUrl, /%23/);
  assert.equal(captionPath(item.imagePath), path.join(dir, 'PHOTO #1.txt'));
});
test('ambiguous stems cannot silently share or lose captions', async () => {
  await files({ 'photo.png': 'A', 'photo.jpg': 'B', 'photo.txt': 'caption' });
  const p = await payload({ baseName: 'renamed' }); assert.ok(p.items.every(i => i.ambiguous));
  await assert.rejects(operations.rename(p), /duplicate/);
});
test('undo refuses to overwrite edits made after the operation', async () => {
  await files({ 'a.txt': 'before' }); const target = path.join(dir, 'a.txt');
  await history.execute('caption', [{ target, replace: true, content: 'after' }]);
  await fs.writeFile(target, 'external edit'); await assert.rejects(history.undo(), /changed/);
  assert.equal(await fs.readFile(target, 'utf8'), 'external edit');
});
test('interrupted operation recovers originals from persistent backups', async () => {
  await files({ 'a.txt': 'before' }); const target = path.join(dir, 'a.txt');
  await history.execute('caption', [{ target, replace: true, content: 'after' }]);
  const record = (await history.records())[0]; record.data.status = 'applying'; await writeJson(record.file, record.data);
  await new Transactions(path.join(root, 'history')).recover(); assert.equal(await fs.readFile(target, 'utf8'), 'before');
});
test('failure during publication rolls back all staged changes', async t => {
  await files({ 'a.txt': 'A', 'b.txt': 'B' }); const before = await snapshot();
  const link = fs.link; let count = 0;
  t.mock.method(fs, 'link', async (...args) => { if (++count === 2) throw new Error('simulated disk failure'); return link(...args); });
  await assert.rejects(history.execute('batch', ['a.txt','b.txt'].map(name => ({ target: path.join(dir, name), replace: true, content: 'new' }))), /disk failure/);
  assert.deepEqual(await snapshot(), before);
});
test('stale caption saves fail instead of replacing a newer edit', async () => {
  await files({ 'a.txt': 'before' }); const target = path.join(dir, 'a.txt'), expected = await digest(target);
  await fs.writeFile(target, 'newer');
  await assert.rejects(history.execute('save', [{ target, replace: true, expected, content: 'stale' }]), /changed/);
});
test('portable filename validation rejects traversal and Windows reserved names', () => {
  for (const name of ['../escape', 'x/y', 'x\\y', 'CON', 'LPT1.txt', 'trailing.', 'bad:name']) assert.throws(() => portableName(name));
  assert.equal(portableName('my_dataset'), 'my_dataset');
});
